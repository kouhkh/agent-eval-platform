import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { BrowserRunnerError } from "./operation-budget.mjs";
import { SENSITIVE_SETUP_SESSION } from "./session-manager.mjs";
import { attachRuntimeValue, redactRuntimeValues, runtimeSensitiveValues } from "./runtime-values.mjs";
import {
  hasRuntimeSetupValues,
  hasRuntimeOperationValues,
  materializeAssertion,
  materializeOperationStep,
  normalizeEnvironment,
  normalizeSetup,
  normalizeTestSteps,
  resolveAssetUrl,
} from "./setup-fixture.mjs";

function iso() { return new Date().toISOString(); }

function jsonClone(value) { return JSON.parse(JSON.stringify(value)); }

function normalizedDraftIssues(input, existing = []) {
  const source = input === undefined ? existing : input;
  if (!Array.isArray(source)) return [];
  return source.filter(Boolean).slice(0, 500).map((issue) => {
    if (typeof issue === "string") return { code: "UNRESOLVED_STEP", message: issue.slice(0, 1000) };
    return {
      code: String(issue.code || "UNRESOLVED_STEP").slice(0, 120),
      message: String(issue.message || issue.detail || "待补全项").slice(0, 1000),
      ...(issue.stepId == null ? {} : { stepId: String(issue.stepId).slice(0, 120) }),
      ...(issue.sourceEventRef == null ? {} : { sourceEventRef: String(issue.sourceEventRef).slice(0, 240) }),
    };
  });
}

function normalizeProposalMetadata(input, existing = {}) {
  const source = input === undefined ? existing : input;
  if (!source || typeof source !== "object") return {};
  return Object.fromEntries(["kind", "proposalId", "proposalDigest", "packetDigest", "proposalRef", "provenanceRef"]
    .filter((key) => source[key] != null).map((key) => [key, String(source[key]).slice(0, 1000)]));
}

function normalizeProvenance(input, existing = {}) {
  const source = input === undefined ? existing : input;
  if (!source || typeof source !== "object") return {};
  return {
    sourceEventRefs: Array.isArray(source.sourceEventRefs) ? source.sourceEventRefs.map(String).slice(0, 500) : [],
    ...(source.packetDigest == null ? {} : { packetDigest: String(source.packetDigest).slice(0, 256) }),
    ...(source.inputDigest == null ? {} : { inputDigest: String(source.inputDigest).slice(0, 256) }),
    ...(source.adapterDigest == null ? {} : { adapterDigest: String(source.adapterDigest).slice(0, 256) }),
  };
}

function normalizeHumanConfirmation(input, existing = {}) {
  const source = input === undefined ? existing : input;
  const status = String(source?.status || "pending");
  if (!["pending", "confirmed", "rejected"].includes(status)) throw new BrowserRunnerError("INVALID_CONFIRMATION_STATUS", "humanConfirmation.status 不合法。", { statusCode: 422, phase: "control-plane" });
  const items = Array.isArray(source?.items) ? source.items.filter((item) => item && typeof item === "object").slice(0, 200).map((item, index) => ({
    id: String(item.id || `confirmation-${index + 1}`).slice(0, 120),
    question: String(item.question || "待确认项").slice(0, 1000),
    proposedValue: String(item.proposedValue || "").slice(0, 4000),
    humanValue: String(item.humanValue || "").slice(0, 4000),
    blocking: item.blocking === true,
    status: String(item.status || (item.humanValue ? "confirmed" : "unresolved")).slice(0, 40),
    evidence: Array.isArray(item.evidence) ? item.evidence.map(String).slice(0, 20) : [],
  })) : (existing.items || []);
  return { status, questions: Array.isArray(source?.questions) ? source.questions.map(String).slice(0, 200) : [], items };
}

const TEST_TRACKS = new Set(["mainline", "experiment", "candidate"]);
const TEST_LIFECYCLES = new Set(["draft", "active", "blocked", "retired"]);

function boundedText(value, limit = 1000) { return String(value ?? "").trim().slice(0, limit); }

function normalizeEvaluationMetadata(input, existing = {}, assetState = "runnable", environment = {}) {
  const source = input === undefined ? existing : input;
  const value = source && typeof source === "object" ? source : {};
  const track = boundedText(value.track || existing.track || "mainline", 40);
  if (!TEST_TRACKS.has(track)) throw new BrowserRunnerError("INVALID_TEST_TRACK", "track 只能是 mainline、experiment 或 candidate。", { statusCode: 422, phase: "control-plane" });
  const lifecycle = boundedText(value.lifecycle || existing.lifecycle || (assetState === "draft" ? "draft" : "active"), 40);
  if (!TEST_LIFECYCLES.has(lifecycle)) throw new BrowserRunnerError("INVALID_TEST_LIFECYCLE", "lifecycle 只能是 draft、active、blocked 或 retired。", { statusCode: 422, phase: "control-plane" });
  const targetInput = value.target && typeof value.target === "object" ? value.target : (existing.target || {});
  const promotionInput = value.promotion && typeof value.promotion === "object" ? value.promotion : (existing.promotion || {});
  return {
    track,
    lifecycle,
    ...(boundedText(value.blockedReason ?? existing.blockedReason, 2000) ? { blockedReason: boundedText(value.blockedReason ?? existing.blockedReason, 2000) } : {}),
    target: {
      ...(boundedText(targetInput.name, 240) ? { name: boundedText(targetInput.name, 240) } : {}),
      ...(boundedText(targetInput.instance, 240) ? { instance: boundedText(targetInput.instance, 240) } : {}),
      ...(boundedText(targetInput.baseUrl || environment.baseUrl, 2000) ? { baseUrl: boundedText(targetInput.baseUrl || environment.baseUrl, 2000) } : {}),
    },
    ...(boundedText(value.fixturePolicy ?? existing.fixturePolicy, 1000) ? { fixturePolicy: boundedText(value.fixturePolicy ?? existing.fixturePolicy, 1000) } : {}),
    promotion: {
      ...(boundedText(promotionInput.parentAssetId, 240) ? { parentAssetId: boundedText(promotionInput.parentAssetId, 240) } : {}),
      ...(boundedText(promotionInput.targetAssetId, 240) ? { targetAssetId: boundedText(promotionInput.targetAssetId, 240) } : {}),
      ...(boundedText(promotionInput.note, 1000) ? { note: boundedText(promotionInput.note, 1000) } : {}),
    },
  };
}

function caseSnapshot(testCase) {
  const { runs: _runs, ...asset } = testCase;
  return jsonClone(asset);
}

function snapshotDigest(snapshot) {
  return createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
}

function hasAuthoritativeAssertions(testCase) {
  return testCase.assertions.length > 0 || testCase.steps.some((step) => step.operation === "assert");
}

function errorAuditDetails(error) {
  const code = error instanceof BrowserRunnerError ? error.code : "TEST_CLEANUP_FAILED";
  const phase = error instanceof BrowserRunnerError ? error.phase : "cleanup";
  const failures = Array.isArray(error?.details?.failures)
    ? error.details.failures.slice(0, 20).map((failure) => ({
      code: String(failure?.code || "UNKNOWN_CLOSE_FAILURE").slice(0, 120),
      phase: String(failure?.phase || "close").slice(0, 120),
      retryable: failure?.retryable === true,
    }))
    : [];
  return { code, phase, ...(failures.length > 0 ? { failures } : {}) };
}

async function executeOperationStep(step, options) {
  const materialized = await materializeOperationStep(step, {
    baseUrl: options.baseUrl,
    env: options.env,
    secretResolver: options.secretResolver,
    defaultOperation: options.defaultOperation,
  });
  const request = { ...materialized.input, ...options.operationInput };
  if (materialized.operation === "act" && !request.approvedScope && !request.authorization && options.approvedScope) {
    request.approvedScope = options.approvedScope;
  }
  const sensitiveValues = runtimeSensitiveValues(materialized.input);
  for (const sensitiveValue of sensitiveValues) attachRuntimeValue(request, "value", sensitiveValue);
  const result = materialized.operation === "navigate"
    ? await options.manager.navigate(options.sessionId, request)
    : materialized.operation === "act"
      ? await options.manager.act(options.sessionId, request)
      : await options.manager.assert(options.sessionId, request);
  return redactRuntimeValues(result, sensitiveValues);
}

function normalizeCase(input = {}, existing = {}) {
  const steps = normalizeTestSteps(input.steps, existing.steps);
  const draftIssues = normalizedDraftIssues(input.draftIssues, existing.draftIssues);
  const assertions = Array.isArray(input.assertions) ? input.assertions.filter((item) => item && typeof item === "object").slice(0, 200) : (existing.assertions || []);
  const policy = input.policy && typeof input.policy === "object" ? input.policy : (existing.policy || {});
  const assetState = String(input.assetState ?? existing.assetState ?? "runnable");
  if (!["draft", "runnable"].includes(assetState)) {
    throw new BrowserRunnerError("INVALID_ASSET_STATE", "assetState 只能是 draft 或 runnable。", { statusCode: 422, phase: "control-plane" });
  }
  const environment = normalizeEnvironment(input.environment, existing.environment);
  return {
    ...existing,
    id: existing.id || String(input.id || randomUUID()),
    title: String(input.title ?? existing.title ?? "未命名回归用例").slice(0, 240),
    description: String(input.description ?? existing.description ?? "").slice(0, 2000),
    project: String(input.project ?? existing.project ?? "").slice(0, 120),
    approvedScope: String(input.approvedScope ?? existing.approvedScope ?? "").trim().slice(0, 500),
    startUrl: String(input.startUrl ?? existing.startUrl ?? "").slice(0, 2000),
    setup: normalizeSetup(input.setup, existing.setup),
    cleanup: normalizeSetup(input.cleanup, existing.cleanup),
    steps,
    assertions,
    assetState,
    draftIssues,
    metadata: normalizeProposalMetadata(input.metadata, existing.metadata),
    provenance: normalizeProvenance(input.provenance, existing.provenance),
    humanConfirmation: normalizeHumanConfirmation(input.humanConfirmation ?? (input.metadata?.kind === "trace-proposal" ? { status: "pending", questions: draftIssues.filter((issue) => issue.code === "HUMAN_QUESTION").map((issue) => issue.message) } : undefined), existing.humanConfirmation),
    environment,
    evaluation: normalizeEvaluationMetadata(input.evaluation, existing.evaluation, assetState, environment),
    sourceRevision: String(input.sourceRevision ?? existing.sourceRevision ?? "").slice(0, 120),
    policy: {
      gate: Boolean(policy.gate ?? existing.policy?.gate),
      nightly: Boolean(policy.nightly ?? existing.policy?.nightly),
      retries: 0,
      schedule: policy.schedule ?? existing.policy?.schedule ?? null,
    },
    version: Number(existing.version || 0) + (existing.id ? 1 : 1),
    createdAt: existing.createdAt || iso(),
    updatedAt: iso(),
    runs: existing.runs || [],
  };
}

export class TestControlPlane {
  constructor(options = {}) {
    this.statePath = path.resolve(options.statePath || path.join(process.cwd(), "data", "test-cases.json"));
    this.cases = new Map();
    this.env = options.env || process.env;
    this.secretResolver = options.secretResolver || null;
    this.loadPromise = this.load();
  }

  async load() {
    try {
      const data = JSON.parse(await readFile(this.statePath, "utf8"));
      for (const item of Array.isArray(data.cases) ? data.cases : []) {
        if (!item?.id) continue;
        this.cases.set(item.id, {
          ...item,
          assetState: item.assetState || "runnable",
          draftIssues: normalizedDraftIssues(item.draftIssues),
          cleanup: item.cleanup && Array.isArray(item.cleanup.steps) ? item.cleanup : { steps: [] },
          evaluation: normalizeEvaluationMetadata(item.evaluation, {}, item.assetState || "runnable", item.environment || {}),
        });
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }

  async persist() {
    await mkdir(path.dirname(this.statePath), { recursive: true, mode: 0o700 });
    const tmp = `${this.statePath}.tmp`;
    await writeFile(tmp, `${JSON.stringify({ version: 1, cases: [...this.cases.values()] }, null, 2)}\n`, { mode: 0o600 });
    await rename(tmp, this.statePath);
  }

  async create(input) {
    await this.loadPromise;
    const value = normalizeCase(input);
    if (this.cases.has(value.id)) throw new BrowserRunnerError("TEST_CASE_ALREADY_EXISTS", "同 ID 测试资产已存在；如需修改请使用 PATCH。", { statusCode: 409, phase: "control-plane" });
    this.cases.set(value.id, value);
    await this.persist();
    return value;
  }

  async get(id) { await this.loadPromise; const value = this.cases.get(String(id)); if (!value) throw new BrowserRunnerError("TEST_CASE_NOT_FOUND", "找不到指定测试用例。", { statusCode: 404, phase: "control-plane" }); return value; }

  async list() { await this.loadPromise; return [...this.cases.values()].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))); }

  async update(id, input) { const current = await this.get(id); const value = normalizeCase(input, current); this.cases.set(value.id, value); await this.persist(); return value; }

  async remove(id) { const current = await this.get(id); this.cases.delete(current.id); await this.persist(); return current; }

  async run(id, manager, input = {}) {
    const testCase = await this.get(id);
    const startedAt = Date.now();
    let sessionId = input.sessionId || null;
    let ownedSession = false;
    const operations = [];
    const evidenceRefs = [];
    const totalBudgetMs = Number(input.totalBudgetMs);
    const totalDeadlineAt = Number.isFinite(totalBudgetMs) && totalBudgetMs > 0 ? startedAt + totalBudgetMs : undefined;
    const operationInput = () => ({ deadlineMs: input.deadlineMs, totalDeadlineAt });
    const approvedScope = String(input.approvedScope || testCase.approvedScope || "").trim().slice(0, 500);
    const setup = testCase.setup || { steps: [] };
    const cleanupFixture = testCase.cleanup || { steps: [] };
    const hasRuntimeValues = hasRuntimeSetupValues(setup)
      || hasRuntimeOperationValues(testCase.steps)
      || hasRuntimeSetupValues(cleanupFixture);
    const baseUrl = input.baseUrl
      ? normalizeEnvironment({ baseUrl: input.baseUrl }).baseUrl
      : String(testCase.environment?.baseUrl || "");
    const startUrl = testCase.startUrl ? resolveAssetUrl(testCase.startUrl, baseUrl, "startUrl") : "";
    const snapshot = caseSnapshot(testCase);
    const runMetadata = {
      caseVersion: testCase.version,
      caseSnapshot: snapshot,
      caseSnapshotDigest: snapshotDigest(snapshot),
      environment: { ...testCase.environment, baseUrl: baseUrl || null },
      setup: { stepCount: setup.steps.length, runtimeValueRefs: hasRuntimeValues },
      cleanupPlan: { stepCount: cleanupFixture.steps.length },
      tracePolicy: hasRuntimeValues
        ? { playwrightTrace: "suppressed", reason: "runtime-value setup may contain credentials" }
        : { playwrightTrace: "enabled", reason: null },
    };
    const saveRun = async (run) => {
      const current = this.cases.get(String(id)) || testCase;
      current.runs = [...(current.runs || []), run].slice(-50);
      current.updatedAt = iso();
      this.cases.set(current.id, current);
      await this.persist();
      return { testCaseId: id, ...run };
    };
    if (testCase.assetState !== "runnable" || testCase.draftIssues.length > 0 || ["blocked", "retired"].includes(testCase.evaluation?.lifecycle)) {
      return saveRun({
        id: randomUUID(),
        status: "blocked",
        executionStatus: "not_started",
        businessVerdict: "not_evaluated",
        startedAt: new Date(startedAt).toISOString(),
        completedAt: iso(),
        elapsedMs: Date.now() - startedAt,
        sessionId,
        operations,
        evidenceRefs,
        ...runMetadata,
        cleanup: { status: "not_started", operations: [], evidenceRefs: [] },
        errorCode: ["blocked", "retired"].includes(testCase.evaluation?.lifecycle) ? "TEST_CASE_LIFECYCLE_BLOCKED" : "TEST_CASE_NOT_EXECUTABLE",
        error: testCase.evaluation?.lifecycle === "blocked"
          ? `测试资产已标记为阻塞：${testCase.evaluation.blockedReason || "未记录原因"}`
          : testCase.evaluation?.lifecycle === "retired"
            ? "测试资产已淘汰，不允许执行。"
            : "测试资产仍是草稿或存在待补全项，不允许执行。",
      });
    }
    if (hasRuntimeValues && sessionId) {
      const run = {
        id: randomUUID(),
        status: "failed",
        executionStatus: "not_started",
        businessVerdict: "not_evaluated",
        startedAt: new Date(startedAt).toISOString(),
        completedAt: iso(),
        elapsedMs: Date.now() - startedAt,
        sessionId,
        operations,
        evidenceRefs,
        ...runMetadata,
        cleanup: { status: "not_started", operations: [], evidenceRefs: [] },
        error: "包含运行时凭据的 setup 必须使用该次 run 新建的独立 session，防止已开启的 trace 记录凭据。",
        errorCode: "SENSITIVE_SETUP_REQUIRES_OWN_SESSION",
      };
      return saveRun(run);
    }
    let primaryError = null;
    let executionStatus = "not_started";
    try {
      if (!sessionId) {
        const session = await manager.createSession({
          url: setup.steps.length === 0 ? startUrl || undefined : undefined,
          profileDir: input.profileDir,
          baseURL: baseUrl || undefined,
          locale: testCase.environment?.locale,
          ...(hasRuntimeValues ? { [SENSITIVE_SETUP_SESSION]: true } : {}),
        });
        sessionId = session.sessionId;
        ownedSession = true;
      }
      for (const setupStep of setup.steps) {
        const safeResult = await executeOperationStep(setupStep, {
          manager,
          sessionId,
          baseUrl,
          env: this.env,
          secretResolver: this.secretResolver,
          approvedScope,
          operationInput: operationInput(),
        });
        operations.push(safeResult);
        evidenceRefs.push(...(safeResult.evidenceRefs || []));
        if (safeResult.status !== "succeeded") {
          throw new BrowserRunnerError(safeResult.errorCode, safeResult.error?.message || "setup 操作失败。", { statusCode: safeResult.httpStatus || 502, phase: safeResult.phase });
        }
      }
      if (startUrl && (setup.steps.length > 0 || !ownedSession) && input.navigate !== false) {
        const result = await manager.navigate(sessionId, { url: startUrl, ...operationInput() });
        operations.push(result);
        evidenceRefs.push(...(result.evidenceRefs || []));
        if (result.status !== "succeeded") throw new BrowserRunnerError(result.errorCode, result.error?.message || "用例起始地址打开失败。", { statusCode: result.httpStatus || 502, phase: result.phase });
      }
      for (const step of testCase.steps) {
        const safeResult = await executeOperationStep(step, {
          manager,
          sessionId,
          baseUrl,
          env: this.env,
          secretResolver: this.secretResolver,
          defaultOperation: "act",
          approvedScope,
          operationInput: operationInput(),
        });
        operations.push(safeResult);
        evidenceRefs.push(...(safeResult.evidenceRefs || []));
        if (safeResult.status !== "succeeded") throw new BrowserRunnerError(safeResult.errorCode, safeResult.error?.message || "测试步骤失败。", { statusCode: safeResult.httpStatus || 502, phase: safeResult.phase });
      }
      for (const assertion of testCase.assertions) {
        const result = await manager.assert(sessionId, { ...materializeAssertion(assertion, baseUrl), ...operationInput() });
        operations.push(result);
        evidenceRefs.push(...(result.evidenceRefs || []));
        if (result.status !== "succeeded") throw new BrowserRunnerError(result.errorCode, result.error?.message || "测试断言失败。", { statusCode: result.httpStatus || 422, phase: result.phase });
      }
      executionStatus = "completed";
    } catch (error) {
      primaryError = error;
      executionStatus = "interrupted";
    }

    const cleanup = { status: "not_required", operations: [], evidenceRefs: [] };
    let cleanupError = null;
    if (sessionId && cleanupFixture.steps.length > 0) {
      cleanup.status = "running";
      for (const cleanupStep of cleanupFixture.steps) {
        try {
          const result = await executeOperationStep(cleanupStep, {
            manager,
            sessionId,
            baseUrl,
            env: this.env,
            secretResolver: this.secretResolver,
            approvedScope,
            operationInput: operationInput(),
          });
          cleanup.operations.push(result);
          cleanup.evidenceRefs.push(...(result.evidenceRefs || []));
          evidenceRefs.push(...(result.evidenceRefs || []));
          if (result.status !== "succeeded") {
            throw new BrowserRunnerError(result.errorCode, result.error?.message || "cleanup 操作失败。", { statusCode: result.httpStatus || 502, phase: result.phase });
          }
        } catch (error) {
          cleanupError = error;
          cleanup.status = "failed";
          break;
        }
      }
      if (!cleanupError) cleanup.status = "completed";
    }
    if (ownedSession && input.closeAfterRun !== false && sessionId) {
      try {
        await manager.close(sessionId, { strict: true });
        cleanup.sessionClose = { status: "completed" };
      } catch (error) {
        cleanupError ||= error;
        cleanup.status = "failed";
        cleanup.sessionClose = { status: "failed", ...errorAuditDetails(error) };
      }
    }
    if (cleanupError) {
      cleanup.errorCode = cleanupError instanceof BrowserRunnerError ? cleanupError.code : "TEST_CLEANUP_FAILED";
      cleanup.error = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
      cleanup.errorDetails = errorAuditDetails(cleanupError);
    }
    const asserted = hasAuthoritativeAssertions(testCase);
    const failed = Boolean(primaryError || cleanupError);
    const run = {
      id: randomUUID(),
      status: failed ? "failed" : asserted ? "passed" : "completed",
      executionStatus,
      businessVerdict: primaryError ? "not_evaluated" : asserted ? "passed" : "not_evaluated",
      startedAt: new Date(startedAt).toISOString(),
      completedAt: iso(),
      elapsedMs: Date.now() - startedAt,
      sessionId,
      operations,
      evidenceRefs,
      ...runMetadata,
      cleanup,
      ...(primaryError ? {
        errorCode: primaryError instanceof BrowserRunnerError ? primaryError.code : "TEST_RUN_FAILED",
        error: primaryError instanceof Error ? primaryError.message : String(primaryError),
      } : cleanupError ? { errorCode: cleanup.errorCode, error: cleanup.error } : {}),
    };
    return saveRun(run);
  }
}
