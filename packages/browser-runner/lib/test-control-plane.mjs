import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { BrowserRunnerError } from "./operation-budget.mjs";

function iso() { return new Date().toISOString(); }

function normalizeCase(input = {}, existing = {}) {
  const steps = Array.isArray(input.steps) ? input.steps.filter((item) => item && typeof item === "object").slice(0, 200) : (existing.steps || []);
  const assertions = Array.isArray(input.assertions) ? input.assertions.filter((item) => item && typeof item === "object").slice(0, 200) : (existing.assertions || []);
  const policy = input.policy && typeof input.policy === "object" ? input.policy : (existing.policy || {});
  return {
    ...existing,
    id: existing.id || String(input.id || randomUUID()),
    title: String(input.title ?? existing.title ?? "未命名回归用例").slice(0, 240),
    description: String(input.description ?? existing.description ?? "").slice(0, 2000),
    project: String(input.project ?? existing.project ?? "").slice(0, 120),
    startUrl: String(input.startUrl ?? existing.startUrl ?? "").slice(0, 2000),
    steps,
    assertions,
    environment: input.environment && typeof input.environment === "object" ? input.environment : (existing.environment || {}),
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
    try {
      if (!sessionId) {
        const session = await manager.createSession({ url: testCase.startUrl || undefined, profileDir: input.profileDir });
        sessionId = session.sessionId;
        ownedSession = true;
      } else if (testCase.startUrl && input.navigate !== false) {
        operations.push(await manager.navigate(sessionId, { url: testCase.startUrl, ...operationInput() }));
      }
      for (const step of testCase.steps) {
        const result = await manager.act(sessionId, { ...step, ...operationInput() });
        operations.push(result);
        evidenceRefs.push(...(result.evidenceRefs || []));
        if (result.status !== "succeeded") throw new BrowserRunnerError(result.errorCode, result.error?.message || "测试动作失败。", { statusCode: result.httpStatus || 502, phase: result.phase });
      }
      for (const assertion of testCase.assertions) {
        const result = await manager.assert(sessionId, { ...assertion, ...operationInput() });
        operations.push(result);
        evidenceRefs.push(...(result.evidenceRefs || []));
        if (result.status !== "succeeded") throw new BrowserRunnerError(result.errorCode, result.error?.message || "测试断言失败。", { statusCode: result.httpStatus || 422, phase: result.phase });
      }
      const run = { id: randomUUID(), status: "passed", startedAt: new Date(startedAt).toISOString(), completedAt: iso(), elapsedMs: Date.now() - startedAt, sessionId, operations, evidenceRefs };
      testCase.runs = [...(testCase.runs || []), run].slice(-50);
      testCase.updatedAt = iso();
      await this.persist();
      if (ownedSession && input.closeAfterRun !== false) await manager.close(sessionId).catch(() => {});
      return { testCaseId: id, ...run };
    } catch (error) {
      const run = { id: randomUUID(), status: "failed", startedAt: new Date(startedAt).toISOString(), completedAt: iso(), elapsedMs: Date.now() - startedAt, sessionId, operations, evidenceRefs, error: error instanceof Error ? error.message : String(error) };
      testCase.runs = [...(testCase.runs || []), run].slice(-50);
      testCase.updatedAt = iso();
      await this.persist();
      if (ownedSession && input.closeAfterRun !== false) await manager.close(sessionId).catch(() => {});
      return { testCaseId: id, ...run };
    }
  }
}
