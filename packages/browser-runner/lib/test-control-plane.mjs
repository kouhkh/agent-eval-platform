import { randomUUID } from "node:crypto";
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
  const assertions = Array.isArray(input.assertions) ? input.assertions.filter((item) => item && typeof item === "object").slice(0, 200) : (existing.assertions || []);
  const policy = input.policy && typeof input.policy === "object" ? input.policy : (existing.policy || {});
  return {
    ...existing,
    id: existing.id || String(input.id || randomUUID()),
    title: String(input.title ?? existing.title ?? "未命名回归用例").slice(0, 240),
    description: String(input.description ?? existing.description ?? "").slice(0, 2000),
    project: String(input.project ?? existing.project ?? "").slice(0, 120),
    approvedScope: String(input.approvedScope ?? existing.approvedScope ?? "").trim().slice(0, 500),
    startUrl: String(input.startUrl ?? existing.startUrl ?? "").slice(0, 2000),
    setup: normalizeSetup(input.setup, existing.setup),
    steps,
    assertions,
    environment: normalizeEnvironment(input.environment, existing.environment),
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
      for (const item of Array.isArray(data.cases) ? data.cases : []) if (item?.id) this.cases.set(item.id, item);
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

  async create(input) { await this.loadPromise; const value = normalizeCase(input); this.cases.set(value.id, value); await this.persist(); return value; }

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
    const operationInput = () => ({ deadlineMs: input.deadlineMs, deadlineAt: totalDeadlineAt, totalBudgetMs: input.totalBudgetMs });
    const approvedScope = String(input.approvedScope || testCase.approvedScope || "").trim().slice(0, 500);
    const setup = testCase.setup || { steps: [] };
    const hasRuntimeValues = hasRuntimeSetupValues(setup) || hasRuntimeOperationValues(testCase.steps);
    const baseUrl = input.baseUrl
      ? normalizeEnvironment({ baseUrl: input.baseUrl }).baseUrl
      : String(testCase.environment?.baseUrl || "");
    const startUrl = testCase.startUrl ? resolveAssetUrl(testCase.startUrl, baseUrl, "startUrl") : "";
    const runMetadata = {
      environment: { ...testCase.environment, baseUrl: baseUrl || null },
      setup: { stepCount: setup.steps.length, runtimeValueRefs: hasRuntimeValues },
      tracePolicy: hasRuntimeValues
        ? { playwrightTrace: "suppressed", reason: "runtime-value setup may contain credentials" }
        : { playwrightTrace: "enabled", reason: null },
    };
    if (hasRuntimeValues && sessionId) {
      const run = {
        id: randomUUID(),
        status: "failed",
        startedAt: new Date(startedAt).toISOString(),
        completedAt: iso(),
        elapsedMs: Date.now() - startedAt,
        sessionId,
        operations,
        evidenceRefs,
        ...runMetadata,
        error: "包含运行时凭据的 setup 必须使用该次 run 新建的独立 session，防止已开启的 trace 记录凭据。",
        errorCode: "SENSITIVE_SETUP_REQUIRES_OWN_SESSION",
      };
      testCase.runs = [...(testCase.runs || []), run].slice(-50);
      testCase.updatedAt = iso();
      await this.persist();
      return { testCaseId: id, ...run };
    }
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
      const run = { id: randomUUID(), status: "passed", startedAt: new Date(startedAt).toISOString(), completedAt: iso(), elapsedMs: Date.now() - startedAt, sessionId, operations, evidenceRefs, ...runMetadata };
      testCase.runs = [...(testCase.runs || []), run].slice(-50);
      testCase.updatedAt = iso();
      await this.persist();
      if (ownedSession && input.closeAfterRun !== false) await manager.close(sessionId).catch(() => {});
      return { testCaseId: id, ...run };
    } catch (error) {
      const run = { id: randomUUID(), status: "failed", startedAt: new Date(startedAt).toISOString(), completedAt: iso(), elapsedMs: Date.now() - startedAt, sessionId, operations, evidenceRefs, ...runMetadata, errorCode: error instanceof BrowserRunnerError ? error.code : "TEST_RUN_FAILED", error: error instanceof Error ? error.message : String(error) };
      testCase.runs = [...(testCase.runs || []), run].slice(-50);
      testCase.updatedAt = iso();
      await this.persist();
      if (ownedSession && input.closeAfterRun !== false) await manager.close(sessionId).catch(() => {});
      return { testCaseId: id, ...run };
    }
  }
}
