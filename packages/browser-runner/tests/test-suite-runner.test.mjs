import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { normalizeSuite, runFixedSuite } from "../lib/test-suite-runner.mjs";

function manifest(scenarios) {
  return {
    id: "fixed-benchmarks",
    title: "fixed benchmarks",
    application: { repository: "sample", revision: "abc123", dirty: true, dirtyDiffRef: "artifact://dirty.patch" },
    baselineRef: "workspace://baseline/sample",
    scenarios,
  };
}

function scenario(id) {
  return { id, benchmarkKey: "jingzhou", scenarioType: "outline_generation", caseId: `case-${id}`, copyRef: `workspace://copy/${id}`, projectBinding: { projectId: `project-${id}` } };
}

test("suite manifest requires a dirty diff reference and stable benchmark identity", () => {
  assert.throws(() => normalizeSuite({ ...manifest([scenario("one")]), application: { repository: "sample", revision: "abc", dirty: true } }), /dirtyDiffRef/);
  assert.throws(() => normalizeSuite(manifest([{ ...scenario("one"), benchmarkKey: "" }])), /benchmarkKey/);
  assert.throws(() => normalizeSuite(manifest([{ ...scenario("one"), runInput: { sessionId: "shared" } }])), /独立 session/);
});

test("fixed suite continues independent scenarios and persists an auditable result index", async () => {
  const outputRoot = await mkdtemp(path.join(tmpdir(), "agent-eval-suite-"));
  const calls = [];
  const results = new Map([
    ["case-complete", { testCaseId: "case-complete", id: "run-complete", status: "completed", executionStatus: "completed", businessVerdict: "not_evaluated", caseVersion: 3, evidenceRefs: ["evidence://complete"] }],
    ["case-timeout", { testCaseId: "case-timeout", id: "run-timeout", status: "failed", executionStatus: "interrupted", errorCode: "DEADLINE_EXCEEDED", cleanup: { evidenceRefs: ["evidence://timeout-cleanup"] } }],
    ["case-blocked", { testCaseId: "case-blocked", id: "run-blocked", status: "blocked", executionStatus: "not_started", errorCode: "TEST_CASE_NOT_EXECUTABLE" }],
    ["case-after", { testCaseId: "case-after", id: "run-after", status: "passed", executionStatus: "completed", businessVerdict: "passed", evidenceRefs: ["evidence://after"] }],
  ]);
  try {
    const suite = manifest([scenario("complete"), scenario("timeout"), scenario("unknown"), scenario("blocked"), scenario("after")]);
    const { index, indexPath } = await runFixedSuite(suite, {
      outputRoot,
      runId: "suite-run-1",
      executeCase: async (caseId) => {
        calls.push(caseId);
        if (caseId === "case-unknown") throw new Error("socket closed after write");
        return results.get(caseId);
      },
    });
    assert.deepEqual(calls, ["case-complete", "case-timeout", "case-unknown", "case-blocked", "case-after"]);
    assert.deepEqual(index.summary, { completed: 2, failed: 1, timed_out: 1, not_executed: 1 });
    assert.equal(index.status, "attention_required");
    assert.equal(index.application.revision, "abc123");
    assert.equal(index.application.dirtyDiffRef, "artifact://dirty.patch");
    assert.equal(index.scenarios[1].copyDisposition, "retained_for_investigation");
    assert.deepEqual(index.scenarios[1].evidenceRefs, ["evidence://timeout-cleanup"]);
    assert.equal(index.scenarios[2].reasonCode, "REQUEST_STATUS_UNKNOWN");
    assert.equal(index.scenarios[2].attempts, 1);
    assert.equal(index.scenarios[2].retryPolicy, "none");
    assert.equal(index.scenarios[4].outcome, "completed");
    assert.deepEqual(JSON.parse(await readFile(indexPath, "utf8")), index);
  } finally {
    await rm(outputRoot, { recursive: true, force: true });
  }
});
