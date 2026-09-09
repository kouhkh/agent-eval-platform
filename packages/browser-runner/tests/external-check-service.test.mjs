import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createPlanoraFixedRegressionAdapter } from "../adapters/planora-fixed-regression.mjs";
import { ExternalCheckService } from "../lib/external-check-service.mjs";
import { TestControlPlane } from "../lib/test-control-plane.mjs";

const FIXED_ROOT = "/Users/ltc/CodexProject/中交机电局项目/outputs/trace-replay-20260908";

test("imports eight fixed checks and preserves original execution times and separate verdicts", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "external-check-history-"));
  try {
    const service = new ExternalCheckService({ statePath: path.join(root, "runs.json"), adapter: createPlanoraFixedRegressionAdapter({ root: FIXED_ROOT }) });
    const checks = await service.list();
    assert.equal(checks.length, 8);
    assert.ok(checks.every((item) => item.id.startsWith("fixed-") && item.method && item.basis));
    assert.ok(checks.every((item) => item.proposedQualityChecks[0].status === "pending_confirmation"));
    const jingzhou = await service.get("fixed-jingzhou-directory");
    assert.equal(jingzhou.latestRun.startedAt, "2026-09-08T14:39:16.522Z");
    assert.equal(jingzhou.latestRun.timeSource, "job");
    assert.equal(jingzhou.latestRun.importedAt, null);
    assert.equal(jingzhou.latestRun.executionStatus, "finished");
    assert.equal(jingzhou.latestRun.checkVerdict, "passed");
    assert.equal(jingzhou.latestRun.businessVerdict, "not_evaluated");
    assert.deepEqual(jingzhou.latestRun.checkResults.map((item) => item.checkId), ["baseline-binding", "request-contract", "new-job-binding", "job-completed", "artifact-exists", "artifact-non-empty"]);
    const qidong = await service.get("fixed-qidong-directory");
    assert.equal(qidong.latestRun.checkVerdict, "failed");
    const sanming = await service.get("fixed-sanming-chapter");
    assert.equal(sanming.history.length, 2);
    assert.equal(sanming.history[0].checkVerdict, "attention_required");
    assert.equal(sanming.history[1].checkVerdict, "passed");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("whitelisted execution exposes pending, running, and finished states with persisted callback evidence", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "external-check-run-"));
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const adapter = {
    load: async () => ({ assets: [{ id: "safe-check", title: "Safe", executor: { id: "allowlisted", argument: "one" } }], history: {} }),
    execute: async (executor, hooks) => {
      assert.deepEqual(executor, { id: "allowlisted", argument: "one" });
      await hooks.onLog("objective runner started");
      await gate;
      return { checkVerdict: "passed", businessVerdict: "not_evaluated", checkResults: [{ checkId: "artifact", status: "pass" }], evidenceRefs: ["result.json"] };
    },
  };
  try {
    const service = new ExternalCheckService({ statePath: path.join(root, "runs.json"), adapter });
    const pending = await service.start("safe-check");
    assert.equal(pending.executionStatus, "pending");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal((await service.get("safe-check")).latestRun.executionStatus, "running");
    for (let index = 0; index < 30 && !(await service.get("safe-check")).latestRun.logTail.length; index += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.match((await service.get("safe-check")).latestRun.logTail.join("\n"), /runner started/);
    release();
    for (let index = 0; index < 30 && (await service.get("safe-check")).latestRun.executionStatus !== "finished"; index += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    const finished = (await service.get("safe-check")).latestRun;
    assert.equal(finished.executionStatus, "finished");
    assert.equal(finished.checkVerdict, "passed");
    assert.equal(finished.businessVerdict, "not_evaluated");
    assert.match(await readFile(path.join(root, "runs.json"), "utf8"), /objective runner started/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("restart marks unfinished external work interrupted instead of rerunning it", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "external-check-restart-"));
  const statePath = path.join(root, "runs.json");
  const adapter = { load: async () => ({ assets: [{ id: "one" }], history: {} }), execute: async () => ({}) };
  try {
    await writeFile(statePath, JSON.stringify({ runs: { one: [{ id: "old", executionStatus: "running", checkVerdict: "not_evaluated" }] } }));
    const service = new ExternalCheckService({ statePath, adapter });
    const run = (await service.get("one")).latestRun;
    assert.equal(run.executionStatus, "interrupted");
    assert.equal(run.errorCode, "PLATFORM_RESTARTED");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("duplicate test-case create refuses to overwrite proposal metadata or runs", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "test-case-conflict-"));
  try {
    const plane = new TestControlPlane({ statePath: path.join(root, "cases.json") });
    const created = await plane.create({ id: "proposal-1", assetState: "draft", metadata: { kind: "trace-proposal", proposalDigest: "aaa", packetDigest: "bbb" }, provenance: { sourceEventRefs: ["event-1"], inputDigest: "ccc", packetDigest: "bbb" }, humanConfirmation: { status: "pending", questions: ["confirm target"] } });
    created.runs.push({ id: "human-run" });
    await assert.rejects(() => plane.create({ id: "proposal-1", metadata: { proposalDigest: "replacement" } }), (error) => error.code === "TEST_CASE_ALREADY_EXISTS" && error.statusCode === 409);
    const stored = await plane.get("proposal-1");
    assert.equal(stored.metadata.proposalDigest, "aaa");
    assert.equal(stored.metadata.packetDigest, "bbb");
    assert.deepEqual(stored.provenance.sourceEventRefs, ["event-1"]);
    assert.equal(stored.provenance.packetDigest, "bbb");
    assert.deepEqual(stored.humanConfirmation.questions, ["confirm target"]);
    assert.deepEqual(stored.runs, [{ id: "human-run" }]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("adapter keeps an unknown existing-run outcome reviewable and never crashes on a missing resultRef", async () => {
  const source = await readFile(new URL("../adapters/planora-fixed-regression.mjs", import.meta.url), "utf8");
  assert.match(source, /if \(!scenarioResult\.resultRef\)/);
  assert.match(source, /checkVerdict: "attention_required"/);
  assert.match(source, /RESULT_REFERENCE_UNAVAILABLE/);
  assert.match(source, /retryPolicy|RUNNER_REPORTED_NONZERO/);
});
