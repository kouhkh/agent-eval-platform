import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createPlanoraFixedRegressionAdapter } from "../adapters/planora-fixed-regression.mjs";
import { ExternalCheckService } from "../lib/external-check-service.mjs";
import { TestControlPlane } from "../lib/test-control-plane.mjs";

const FIXED_ROOT = process.env.AGENT_EVAL_REAL_FIXED_ROOT;

test("real fixture integration imports eight checks when an explicit asset root is supplied", { skip: !FIXED_ROOT }, async () => {
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
    assert.deepEqual(jingzhou.latestRun.checkResults.map((item) => item.checkId), ["baseline-binding", "request-contract", "new-job-binding", "job-completed", "artifact-exists", "artifact-binding", "artifact-non-empty"]);
    const qidong = await service.get("fixed-qidong-directory");
    assert.equal(qidong.latestRun.checkVerdict, "failed");
    const sanming = await service.get("fixed-sanming-chapter");
    assert.equal(sanming.history.length, 2);
    assert.equal(sanming.history[0].checkVerdict, "attention_required");
    assert.equal(sanming.history[1].checkVerdict, "passed");
  } finally { await rm(root, { recursive: true, force: true }); }
});

async function portableFixture(root) {
  const generation = path.join(root, "replay", "generation"); const runs = path.join(root, "runs"); const evidence = path.join(root, "evidence");
  await Promise.all([mkdir(generation, { recursive: true }), mkdir(runs, { recursive: true }), mkdir(evidence, { recursive: true })]);
  const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
  const save = async (file, value) => { const bytes = `${JSON.stringify(value)}\n`; await writeFile(file, bytes); return digest(bytes); };
  const configPath = path.join(root, "config.json"); const configSha256 = await save(configPath, { benchmarks: [] });
  const ledger = { inputFingerprint: "1".repeat(64), actorUserId: "actor" };
  const ledgerA = path.join(root, "ledger-a.json"); const ledgerB = path.join(root, "ledger-b.json"); const shaA = await save(ledgerA, ledger); const shaB = await save(ledgerB, ledger);
  const before = path.join(evidence, "prepare-0003-jobs.json"); const request = path.join(evidence, "observe-0001-request-reference.json");
  await save(before, []); await save(request, { method: "POST", path: "/api/projects/p/chapters/generate", status: 200 });
  const artifact = path.join(evidence, "artifact.json"); await save(artifact, { id: "p", chapters: [{ id: "c", title: "Chapter", businessLine: "bid_plan", content: "body" }] });
  const resultRef = path.join(evidence, "result.json");
  const result = { state: "objective_completed", scenario: "directory", applicationRevision: "revision", inputFingerprint: ledger.inputFingerprint, projectId: "p", targetId: "p:bid_plan", observation: { reason: "ok", projectId: "p", scenario: "directory", plan: { projectId: "p", targetId: "p:bid_plan", scenario: "directory", businessLine: "bid_plan", jobType: "outline", actorUserId: "actor", requestPath: "/api/projects/p/chapters/generate" }, job: { id: "j", projectId: "p", targetId: "p:bid_plan", type: "outline", createdById: "actor", status: "succeeded", startedAt: "2026-01-01T00:00:00.000Z", finishedAt: "2026-01-01T00:00:01.000Z" }, artifact: { chapterCount: 1 }, artifactEvidenceRef: artifact, evidenceRefs: [before, request] } };
  await save(resultRef, result);
  const catalog = { applicationRevision: "revision", configPath, configSha256, benchmarks: [{ benchmarkKey: "jingzhou", inputs: [], A: { ledgerPath: ledgerA, sha256: shaA }, B: { ledgerPath: ledgerB, sha256: shaB }, directorySpec: { scenario: "directory" }, chapterSpec: { scenario: "chapter", chapterKey: "c" } }] };
  await save(path.join(generation, "fixed-catalog.json"), catalog);
  await save(path.join(runs, "first-eight-results.json"), [{ benchmark: "jingzhou", scenario: "directory", startedAt: "2026-01-01T00:00:00.000Z", finishedAt: "2026-01-01T00:00:01.000Z", resultRef, artifactRef: artifact }]);
  await save(path.join(runs, "repeat-verification-summary.json"), []);
  return { resultRef, before, artifact, result };
}

test("portable adapter fixture verifies real bindings and leaves absent evidence unknown", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "portable-fixed-check-"));
  try {
    const fixture = await portableFixture(root);
    let checks = await new ExternalCheckService({ statePath: path.join(root, "state-a.json"), adapter: createPlanoraFixedRegressionAdapter({ root }) }).list();
    assert.equal(checks.length, 2);
    assert.equal(checks[0].latestRun.checkVerdict, "passed");
    await writeFile(fixture.resultRef, `${JSON.stringify({ ...fixture.result, inputFingerprint: "0".repeat(64), observation: { ...fixture.result.observation, job: { ...fixture.result.observation.job, finishedAt: null } } })}\n`);
    await writeFile(fixture.before, "{}\n");
    await writeFile(fixture.artifact, "not-json\n");
    checks = await new ExternalCheckService({ statePath: path.join(root, "state-b.json"), adapter: createPlanoraFixedRegressionAdapter({ root }) }).list();
    const results = Object.fromEntries(checks[0].latestRun.checkResults.map((item) => [item.checkId, item.status]));
    assert.equal(results["baseline-binding"], "fail");
    assert.equal(results["new-job-binding"], "unknown");
    assert.equal(results["job-completed"], "unknown");
    assert.equal(results["artifact-exists"], "fail");
    assert.equal(results["artifact-binding"], "unknown");
    assert.equal(results["artifact-non-empty"], "unknown");
    await writeFile(fixture.artifact, `${JSON.stringify({ id: "foreign-project", chapters: [{ id: "foreign-chapter", title: "Foreign", businessLine: "wrong-line" }] })}\n`);
    checks = await new ExternalCheckService({ statePath: path.join(root, "state-c.json"), adapter: createPlanoraFixedRegressionAdapter({ root }) }).list();
    assert.equal(Object.fromEntries(checks[0].latestRun.checkResults.map((item) => [item.checkId, item.status]))["artifact-binding"], "fail");
    await rm(fixture.artifact);
    checks = await new ExternalCheckService({ statePath: path.join(root, "state-d.json"), adapter: createPlanoraFixedRegressionAdapter({ root }) }).list();
    const missing = Object.fromEntries(checks[0].latestRun.checkResults.map((item) => [item.checkId, item]));
    assert.equal(missing["artifact-exists"].status, "unknown");
    assert.equal(missing["artifact-exists"].reasonCode, "ARTIFACT_EVIDENCE_UNAVAILABLE");
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
    assert.equal(finished.executionOutcome, "completed");
    assert.equal(finished.checkVerdict, "passed");
    assert.equal(finished.businessVerdict, "not_evaluated");
    await Promise.all([...service.executions]);
    await service.persistChain;
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

test("simultaneous starts reserve a check exactly once", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "external-check-race-"));
  let executions = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const adapter = { load: async () => ({ assets: [{ id: "one", executor: { id: "safe" } }], history: {} }), execute: async () => { executions += 1; await gate; return { checkVerdict: "passed" }; } };
  try {
    const service = new ExternalCheckService({ statePath: path.join(root, "runs.json"), adapter });
    const settled = await Promise.allSettled([service.start("one"), service.start("one")]);
    assert.equal(settled.filter((item) => item.status === "fulfilled").length, 1);
    assert.equal(settled.filter((item) => item.status === "rejected" && item.reason.code === "CHECK_ALREADY_RUNNING").length, 1);
    for (let index = 0; index < 30 && executions === 0; index += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(executions, 1);
    release();
    for (let index = 0; index < 30 && (await service.get("one")).latestRun.executionStatus !== "finished"; index += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    await Promise.all([...service.executions]);
    await service.persistChain;
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
