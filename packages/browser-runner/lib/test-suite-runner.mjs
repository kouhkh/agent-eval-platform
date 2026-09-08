import { randomUUID } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { BrowserRunnerError } from "./operation-budget.mjs";

function iso() { return new Date().toISOString(); }

function boundedString(value, field, maximum = 2000) {
  const text = String(value ?? "").trim();
  if (!text) throw new BrowserRunnerError("INVALID_SUITE_MANIFEST", `${field} 不能为空。`, { statusCode: 422, phase: "suite" });
  return text.slice(0, maximum);
}

function normalizeScenario(scenario, index) {
  const runInput = scenario?.runInput && typeof scenario.runInput === "object" ? scenario.runInput : {};
  if (runInput.sessionId || runInput.closeAfterRun === false) {
    throw new BrowserRunnerError("INVALID_SUITE_MANIFEST", `scenarios[${index}].runInput 必须使用独立 session 并在运行后关闭。`, { statusCode: 422, phase: "suite" });
  }
  const binding = scenario?.projectBinding && typeof scenario.projectBinding === "object" ? scenario.projectBinding : {};
  return {
    id: boundedString(scenario?.id || `scenario-${index + 1}`, `scenarios[${index}].id`, 160),
    benchmarkKey: boundedString(scenario?.benchmarkKey, `scenarios[${index}].benchmarkKey`, 160),
    scenarioType: boundedString(scenario?.scenarioType, `scenarios[${index}].scenarioType`, 160),
    caseId: boundedString(scenario?.caseId, `scenarios[${index}].caseId`, 240),
    copyRef: boundedString(scenario?.copyRef, `scenarios[${index}].copyRef`),
    projectBinding: {
      projectId: boundedString(binding.projectId, `scenarios[${index}].projectBinding.projectId`, 240),
      ...(binding.preparedRef == null ? {} : { preparedRef: boundedString(binding.preparedRef, `scenarios[${index}].projectBinding.preparedRef`) }),
    },
    runInput: { ...runInput, closeAfterRun: true },
  };
}

function normalizeSuite(input = {}) {
  const application = input.application && typeof input.application === "object" ? input.application : {};
  const dirty = application.dirty === true;
  const normalized = {
    id: boundedString(input.id || "fixed-suite", "suite.id", 160),
    title: boundedString(input.title || input.id || "固定评测套件", "suite.title", 240),
    application: {
      repository: boundedString(application.repository, "application.repository"),
      revision: boundedString(application.revision, "application.revision", 160),
      dirty,
      dirtyDiffRef: dirty ? boundedString(application.dirtyDiffRef, "application.dirtyDiffRef") : null,
    },
    baselineRef: boundedString(input.baselineRef, "baselineRef"),
    scenarios: Array.isArray(input.scenarios) ? input.scenarios.map(normalizeScenario) : [],
  };
  if (normalized.scenarios.length === 0) throw new BrowserRunnerError("INVALID_SUITE_MANIFEST", "scenarios 至少需要一项。", { statusCode: 422, phase: "suite" });
  const ids = new Set();
  for (const scenario of normalized.scenarios) {
    if (ids.has(scenario.id)) throw new BrowserRunnerError("INVALID_SUITE_MANIFEST", `场景 id 重复：${scenario.id}。`, { statusCode: 422, phase: "suite" });
    ids.add(scenario.id);
  }
  return normalized;
}

function uniqueRefs(result) {
  return [...new Set([
    ...(Array.isArray(result?.evidenceRefs) ? result.evidenceRefs : []),
    ...(Array.isArray(result?.cleanup?.evidenceRefs) ? result.cleanup.evidenceRefs : []),
  ].map(String))];
}

function classifyResult(result) {
  if (result?.errorCode === "DEADLINE_EXCEEDED") return { outcome: "timed_out", reasonCode: result.errorCode };
  if (result?.executionStatus === "not_started" || result?.status === "blocked") return { outcome: "not_executed", reasonCode: result.errorCode || "NOT_EXECUTED" };
  if (result?.executionStatus === "interrupted" || result?.status === "failed" || Number(result?.httpStatus) >= 400) return { outcome: "failed", reasonCode: result.errorCode || "TEST_RUN_FAILED" };
  if (["completed", "passed"].includes(result?.status)) return { outcome: "completed", reasonCode: null };
  return { outcome: "failed", reasonCode: "UNRECOGNIZED_RUN_RESULT" };
}

async function persistIndex(outputRoot, index) {
  const directory = path.resolve(outputRoot, index.runId);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const resultPath = path.join(directory, "index.json");
  const temporaryPath = `${resultPath}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(index, null, 2)}\n`, { mode: 0o600 });
  await rename(temporaryPath, resultPath);
  return resultPath;
}

function pendingScenario(scenario) {
  return {
    scenarioId: scenario.id,
    benchmarkKey: scenario.benchmarkKey,
    scenarioType: scenario.scenarioType,
    caseId: scenario.caseId,
    copyRef: scenario.copyRef,
    projectBinding: scenario.projectBinding,
    attempts: 0,
    retryPolicy: "none",
    outcome: "not_started",
    requestState: "not_started",
    reasonCode: "NOT_STARTED",
    caseRunId: null,
    testCaseId: scenario.caseId,
    caseVersion: null,
    executionStatus: "not_started",
    businessVerdict: "not_evaluated",
    evidenceRefs: [],
    error: null,
    startedAt: null,
    completedAt: null,
    elapsedMs: null,
    copyDisposition: "retained_for_investigation",
  };
}

function summarize(scenarios) {
  return scenarios.reduce((counts, item) => ({ ...counts, [item.outcome]: (counts[item.outcome] || 0) + 1 }), {
    completed: 0,
    failed: 0,
    timed_out: 0,
    not_executed: 0,
    not_started: 0,
    in_progress: 0,
  });
}

export async function runFixedSuite(input, options = {}) {
  const suite = normalizeSuite(input);
  if (typeof options.executeCase !== "function") throw new TypeError("executeCase is required");
  const runId = String(options.runId || randomUUID());
  const startedAt = options.now ? options.now() : iso();
  const scenarioRuns = suite.scenarios.map(pendingScenario);
  const index = {
    schemaVersion: 1,
    runId,
    suite: { id: suite.id, title: suite.title },
    application: suite.application,
    baselineRef: suite.baselineRef,
    startedAt,
    completedAt: null,
    status: "running",
    retryPolicy: "none",
    summary: summarize(scenarioRuns),
    scenarios: scenarioRuns,
  };
  let indexPath = await persistIndex(options.outputRoot, index);
  for (let scenarioIndex = 0; scenarioIndex < suite.scenarios.length; scenarioIndex += 1) {
    const scenario = suite.scenarios[scenarioIndex];
    const scenarioStartedAt = options.now ? options.now() : iso();
    Object.assign(scenarioRuns[scenarioIndex], {
      attempts: 1,
      outcome: "in_progress",
      requestState: "request_pending",
      reasonCode: null,
      startedAt: scenarioStartedAt,
    });
    index.summary = summarize(scenarioRuns);
    indexPath = await persistIndex(options.outputRoot, index);
    try {
      const result = await options.executeCase(scenario.caseId, scenario.runInput);
      const classified = classifyResult(result);
      scenarioRuns[scenarioIndex] = {
        scenarioId: scenario.id,
        benchmarkKey: scenario.benchmarkKey,
        scenarioType: scenario.scenarioType,
        caseId: scenario.caseId,
        copyRef: scenario.copyRef,
        projectBinding: scenario.projectBinding,
        attempts: 1,
        retryPolicy: "none",
        ...classified,
        requestState: "settled",
        caseRunId: result?.id || null,
        testCaseId: result?.testCaseId || scenario.caseId,
        caseVersion: result?.caseVersion || null,
        executionStatus: result?.executionStatus || "unknown",
        businessVerdict: result?.businessVerdict || "not_evaluated",
        evidenceRefs: uniqueRefs(result),
        error: result?.error || null,
        startedAt: result?.startedAt || scenarioStartedAt,
        completedAt: result?.completedAt || (options.now ? options.now() : iso()),
        elapsedMs: Number.isFinite(result?.elapsedMs) ? result.elapsedMs : null,
        copyDisposition: classified.outcome === "completed" ? "eligible_for_cleanup" : "retained_for_investigation",
      };
    } catch (error) {
      scenarioRuns[scenarioIndex] = {
        scenarioId: scenario.id,
        benchmarkKey: scenario.benchmarkKey,
        scenarioType: scenario.scenarioType,
        caseId: scenario.caseId,
        copyRef: scenario.copyRef,
        projectBinding: scenario.projectBinding,
        attempts: 1,
        retryPolicy: "none",
        outcome: "failed",
        requestState: "unknown",
        reasonCode: "REQUEST_STATUS_UNKNOWN",
        caseRunId: null,
        testCaseId: scenario.caseId,
        caseVersion: null,
        executionStatus: "unknown",
        businessVerdict: "not_evaluated",
        evidenceRefs: [],
        error: error instanceof Error ? error.message : String(error),
        startedAt: scenarioStartedAt,
        completedAt: options.now ? options.now() : iso(),
        elapsedMs: null,
        copyDisposition: "retained_for_investigation",
      };
    }
    index.summary = summarize(scenarioRuns);
    indexPath = await persistIndex(options.outputRoot, index);
  }
  index.completedAt = options.now ? options.now() : iso();
  index.summary = summarize(scenarioRuns);
  index.status = index.summary.failed || index.summary.timed_out || index.summary.not_executed ? "attention_required" : "completed";
  indexPath = await persistIndex(options.outputRoot, index);
  return { index, indexPath };
}

export { normalizeSuite };
