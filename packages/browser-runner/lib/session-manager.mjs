import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { asBrowserRunnerError, BrowserRunnerError, createOperationBudget } from "./operation-budget.mjs";
import { publicOperationResult, sanitizeUrl } from "./evidence-store.mjs";
import { runtimeSensitiveValues } from "./runtime-values.mjs";

export const SENSITIVE_SETUP_SESSION = Symbol("agent-eval-sensitive-setup-session");

function nowIso() {
  return new Date().toISOString();
}

function publicSession(session) {
  return {
    sessionId: session.sessionId,
    instanceId: session.instanceId,
    tabId: session.tabId,
    state: session.state,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    lastHeartbeatAt: session.lastHeartbeatAt,
    leaseExpiresAt: session.leaseExpiresAt,
    url: sanitizeUrl(session.page?.url?.() || "about:blank"),
    profile: session.profile || "ephemeral",
    traceActive: session.traceActive === true,
    traceRefs: session.traceRefs || [],
    traceError: session.traceError || null,
    staleReason: session.staleReason || null,
    reconnectCount: session.reconnectCount || 0,
    pixelEvidenceSuppressed: session.suppressPixelEvidence === true,
    currentOperationId: session.operation?.operationId || null,
  };
}

function errorEnvelope(error, meta, elapsedMs, evidenceRefs = []) {
  const normalized = asBrowserRunnerError(error, meta);
  return {
    operationId: meta.operationId,
    sessionId: meta.sessionId,
    tabId: meta.tabId,
    status: "failed",
    elapsedMs,
    phase: normalized.phase || meta.phase || "operation",
    errorCode: normalized.code,
    error: normalized.toJSON(),
    evidenceRefs,
    httpStatus: normalized.statusCode || 502,
  };
}

export class SessionManager {
  constructor(options = {}) {
    this.runner = options.runner;
    if (!this.runner) throw new TypeError("SessionManager 需要 runner。");
    this.evidenceStore = options.evidenceStore || null;
    this.traceRoot = path.resolve(options.traceRoot || path.join(process.cwd(), "data", "traces"));
    this.leaseMs = Math.max(10_000, Number(options.leaseMs) || 30 * 60 * 1000);
    this.heartbeatMs = Math.max(500, Number(options.heartbeatMs) || 5_000);
    this.sessions = new Map();
    this.operations = new Map();
    this.profileOwners = new Map();
    this.timer = setInterval(() => { void this.heartbeat(); }, this.heartbeatMs);
    this.timer.unref?.();
    this.runner.onDisconnected = () => this.markAllStale("浏览器进程已断开，当前 session 需要重新建立。");
  }

  async heartbeat() {
    let alive = true;
    try { alive = Boolean((await this.runner.health()).ready); } catch { alive = false; }
    for (const session of this.sessions.values()) {
      if (["closed", "stale"].includes(session.state)) continue;
      const pageClosed = Boolean(session.page?.isClosed?.());
      if (pageClosed) {
        session.state = "closed";
        session.updatedAt = nowIso();
        continue;
      }
      if (!alive) {
        this.markStale(session.sessionId, "浏览器进程已断开，当前 session 需要重新建立。");
        continue;
      }
      if (Date.now() > new Date(session.leaseExpiresAt).getTime()) {
        this.markStale(session.sessionId, "session lease 已过期。");
      } else {
        session.lastHeartbeatAt = nowIso();
      }
    }
  }

  markStale(sessionId, reason = "session 已失效，请重新建立浏览器 session。") {
    const session = this.sessions.get(sessionId);
    if (!session || session.state === "closed") return;
    session.state = "stale";
    session.staleReason = reason;
    session.updatedAt = nowIso();
  }

  markAllStale(reason) {
    for (const session of this.sessions.values()) this.markStale(session.sessionId, reason);
  }

  get(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) throw new BrowserRunnerError("SESSION_NOT_FOUND", "找不到指定 session。", { statusCode: 404, phase: "session" });
    if (session.state === "ready" && session.page?.isClosed?.()) {
      session.state = "closed";
      session.updatedAt = nowIso();
    }
    return session;
  }

  async createSession(options = {}) {
    if (options.trace === false && options[SENSITIVE_SETUP_SESSION] !== true) {
      throw new BrowserRunnerError("TRACE_POLICY_FORBIDDEN", "普通 session 不允许关闭强制 trace。", { statusCode: 403, phase: "trace" });
    }
    const sessionId = String(options.sessionId || randomUUID());
    if (this.sessions.has(sessionId) && this.sessions.get(sessionId)?.state !== "closed") {
      throw new BrowserRunnerError("SESSION_ALREADY_EXISTS", "指定 sessionId 已被使用。", { statusCode: 409, phase: "session" });
    }
    const tabId = String(options.tabId || `tab-${randomUUID()}`);
    const profile = options.profileDir ? "persistent" : "ephemeral";
    const profileDir = options.profileDir ? path.resolve(options.profileDir) : null;
    const profileOwner = profileDir ? this.profileOwners.get(profileDir) : null;
    if (profileOwner && profileOwner !== sessionId) {
      throw new BrowserRunnerError("PROFILE_BUSY", "专用浏览器 profile 已被另一个 session 使用。", { statusCode: 409, phase: "lease", details: { ownerSessionId: profileOwner } });
    }
    if (profileDir) this.profileOwners.set(profileDir, sessionId);
    let context;
    try {
      context = await this.runner.createContext({
        sessionId,
        profileDir,
        baseURL: options.baseURL,
        locale: options.locale,
      });
    } catch (error) {
      if (profileDir) this.profileOwners.delete(profileDir);
      throw error;
    }
    let page;
    try {
      page = await this.runner.newPage(context);
    } catch (error) {
      await this.runner.closeContext(context).catch(() => {});
      if (profileDir) this.profileOwners.delete(profileDir);
      throw error;
    }
    const session = {
      sessionId,
      instanceId: randomUUID(),
      tabId,
      context,
      page,
      profile,
      profileDir,
      baseURL: options.baseURL || null,
      locale: options.locale || null,
      state: "new",
      createdAt: nowIso(),
      updatedAt: nowIso(),
      lastHeartbeatAt: nowIso(),
      leaseExpiresAt: new Date(Date.now() + this.leaseMs).toISOString(),
      traceActive: false,
      traceRefs: [],
      networkCursor: 0,
      operation: null,
      staleReason: null,
      reconnectCount: 0,
      traceEnabled: options[SENSITIVE_SETUP_SESSION] !== true,
      suppressPixelEvidence: options[SENSITIVE_SETUP_SESSION] === true,
    };
    this.sessions.set(sessionId, session);
    try {
      if (session.traceEnabled) {
        await this.runner.startTrace(context);
        session.traceActive = true;
      }
    } catch (error) {
      session.traceError = asBrowserRunnerError(error, { phase: "trace", statusCode: 502 }).toJSON();
      await this.runner.closeContext(context).catch(() => {});
      this.sessions.delete(sessionId);
      if (profileDir) this.profileOwners.delete(profileDir);
      throw new BrowserRunnerError("TRACE_REQUIRED", "浏览器 trace 无法启动，拒绝创建无审计 session。", { statusCode: 502, phase: "trace", details: session.traceError });
    }
    session.state = "ready";
    if (options.url) {
      const response = await this.navigate(sessionId, { url: options.url, deadlineMs: options.deadlineMs });
      if (response.status !== "succeeded") {
        await this.close(sessionId).catch(() => {});
        const error = new BrowserRunnerError(response.errorCode, response.error?.message || "初始地址打开失败。", { statusCode: response.httpStatus || 502, phase: response.phase });
        throw error;
      }
    }
    return publicSession(session);
  }

  async close(sessionId) {
    const session = this.get(sessionId);
    if (session.operation) session.operation.budget.cancel("cancel");
    if (session.traceActive) await this.stopTrace(session).catch(() => {});
    await this.runner.closeContext(session.context).catch(() => {});
    if (session.profileDir && this.profileOwners.get(session.profileDir) === sessionId) this.profileOwners.delete(session.profileDir);
    session.state = "closed";
    session.updatedAt = nowIso();
    session.operation = null;
    return publicSession(session);
  }

  async reconnect(sessionId, options = {}) {
    const session = this.get(sessionId);
    if (session.operation) throw new BrowserRunnerError("TAB_BUSY", "当前 tab 正在执行其他操作，不能重连。", { statusCode: 409, phase: "lease" });
    await this.runner.closeContext(session.context).catch(() => {});
    session.state = "new";
    session.updatedAt = nowIso();
    session.instanceId = randomUUID();
    session.tabId = `tab-${randomUUID()}`;
    const reconnectProfileDir = options.profileDir ? path.resolve(options.profileDir) : session.profileDir;
    if (reconnectProfileDir && reconnectProfileDir !== session.profileDir) {
      const owner = this.profileOwners.get(reconnectProfileDir);
      if (owner && owner !== sessionId) {
        session.state = "stale";
        session.staleReason = "重连目标 profile 正在被其他 session 使用。";
        throw new BrowserRunnerError("PROFILE_BUSY", session.staleReason, { statusCode: 409, phase: "lease", details: { ownerSessionId: owner } });
      }
    }
    let newContext;
    try {
      newContext = await this.runner.createContext({
        sessionId,
        profileDir: reconnectProfileDir,
        baseURL: options.baseURL || session.baseURL,
        locale: options.locale || session.locale,
      });
      session.page = await this.runner.newPage(newContext);
    } catch (error) {
      if (newContext) await this.runner.closeContext(newContext).catch(() => {});
      session.state = "stale";
      session.staleReason = "浏览器 session 重连失败。";
      throw error;
    }
    if (session.profileDir && session.profileDir !== reconnectProfileDir && this.profileOwners.get(session.profileDir) === sessionId) this.profileOwners.delete(session.profileDir);
    if (reconnectProfileDir) this.profileOwners.set(reconnectProfileDir, sessionId);
    session.profileDir = reconnectProfileDir;
    session.profile = reconnectProfileDir ? "persistent" : "ephemeral";
    session.context = newContext;
    session.traceActive = false;
    session.traceError = null;
    if (session.traceEnabled) {
      try { await this.runner.startTrace(session.context); session.traceActive = true; }
      catch (error) {
        session.traceError = asBrowserRunnerError(error, { phase: "trace", statusCode: 502 }).toJSON();
        await this.runner.closeContext(session.context).catch(() => {});
        session.state = "stale";
        session.staleReason = "浏览器 trace 无法重新建立。";
        throw new BrowserRunnerError("TRACE_REQUIRED", "浏览器 trace 无法重新建立。", { statusCode: 502, phase: "trace", details: session.traceError });
      }
    }
    session.state = "ready";
    session.staleReason = null;
    session.reconnectCount += 1;
    session.lastHeartbeatAt = nowIso();
    session.leaseExpiresAt = new Date(Date.now() + this.leaseMs).toISOString();
    if (options.url) {
      const result = await this.navigate(sessionId, { url: options.url, deadlineMs: options.deadlineMs });
      if (result.status !== "succeeded") throw new BrowserRunnerError(result.errorCode, result.error?.message || "重连后的初始地址打开失败。", { statusCode: result.httpStatus || 502, phase: result.phase });
    }
    return publicSession(session);
  }

  async stopTrace(session) {
    if (!session.traceActive) return session.traceRefs;
    await mkdir(path.join(this.traceRoot, session.sessionId), { recursive: true, mode: 0o700 });
    const tracePath = path.join(this.traceRoot, session.sessionId, `trace-${Date.now()}.zip`);
    await this.runner.stopTrace(session.context, tracePath);
    session.traceActive = false;
    if (this.evidenceStore) {
      const saved = await this.evidenceStore.saveTrace(session.sessionId, `trace-${Date.now()}`, tracePath);
      session.traceRefs = [...session.traceRefs, saved.ref];
    } else {
      session.traceRefs = [...session.traceRefs, `file://${tracePath}`];
    }
    return session.traceRefs;
  }

  async getTrace(sessionId, options = {}) {
    const session = this.get(sessionId);
    if (session.operation) return errorEnvelope(new BrowserRunnerError("TAB_BUSY", "当前 tab 正在执行其他操作。", { statusCode: 409, phase: "lease" }), { operationId: options.operationId || randomUUID(), sessionId, tabId: session.tabId }, 0);
    const operationId = options.operationId || randomUUID();
    const started = Date.now();
    try {
      let refs = session.traceRefs || [];
      if (options.stop !== false) refs = await this.stopTrace(session);
      return {
        operationId,
        sessionId,
        tabId: session.tabId,
        status: "succeeded",
        elapsedMs: Date.now() - started,
        phase: "trace",
        errorCode: null,
        evidenceRefs: refs,
        traceActive: session.traceActive,
      };
    } catch (error) {
      return errorEnvelope(error, { operationId, sessionId, tabId: session.tabId, phase: "trace" }, Date.now() - started);
    }
  }

  async cancel(sessionId, operationId = null) {
    const session = this.get(sessionId);
    const operation = session.operation;
    if (!operation || (operationId && operation.operationId !== operationId)) {
      return { operationId: operationId || randomUUID(), sessionId, tabId: session.tabId, status: "failed", elapsedMs: 0, phase: "cancel", errorCode: "NO_ACTIVE_OPERATION", error: { code: "NO_ACTIVE_OPERATION", message: "当前 tab 没有可取消的操作。", phase: "cancel", retryable: false, details: null }, evidenceRefs: [], httpStatus: 409 };
    }
    operation.budget.cancel("cancel");
    await this.runner.cancelPage(session.page).catch(() => {});
    return { operationId: operation.operationId, sessionId, tabId: session.tabId, status: "cancelling", elapsedMs: 0, phase: "cancel", errorCode: null, evidenceRefs: [] };
  }

  async withOperation(sessionId, kind, input, handler) {
    let session;
    try { session = this.get(sessionId); } catch (error) {
      const operationId = String(input?.operationId || randomUUID());
      return errorEnvelope(error, { operationId, sessionId, tabId: input?.tabId || null, phase: "session" }, 0);
    }
    const operationId = String(input?.operationId || randomUUID());
    const meta = { operationId, sessionId, tabId: session.tabId, phase: kind };
    if (input?.tabId && String(input.tabId) !== session.tabId) return errorEnvelope(new BrowserRunnerError("TAB_NOT_FOUND", "session 与 tabId 不匹配。", { statusCode: 404, phase: "session" }), meta, 0);
    if (session.state === "stale") return errorEnvelope(new BrowserRunnerError("STALE_SESSION", session.staleReason || "session 已失效，请重新建立浏览器 session。", { statusCode: 409, phase: "session", details: { state: session.state } }), meta, 0);
    if (session.state === "closed") return errorEnvelope(new BrowserRunnerError("TAB_CLOSED", "目标 tab 已关闭。", { statusCode: 409, phase: "session" }), meta, 0);
    if (session.operation) return errorEnvelope(new BrowserRunnerError("TAB_BUSY", "当前 tab 正在执行其他操作；不会在同一 tab 上并发执行。", { statusCode: 409, phase: "lease", details: { operationId: session.operation.operationId } }), meta, 0);
    const budget = createOperationBudget({
      operationId,
      sessionId,
      tabId: session.tabId,
      deadlineMs: input?.deadlineMs,
      totalBudgetMs: input?.totalBudgetMs,
      deadlineAt: input?.deadlineAt,
      totalDeadlineAt: input?.totalDeadlineAt,
    });
    session.operation = { operationId, budget, kind, startedAt: Date.now() };
    session.state = "busy";
    session.updatedAt = nowIso();
    this.operations.set(operationId, session);
    let evidenceRefs = [];
    const started = Date.now();
    const sensitiveValues = runtimeSensitiveValues(input);
    try {
      const evidenceBase = this.evidenceStore ? await this.evidenceStore.begin({ operationId, sessionId, tabId: session.tabId, kind, startedAt: nowIso(), request: input }) : null;
      if (evidenceBase) evidenceRefs.push(evidenceBase);
      const data = await budget.run(() => handler({ page: session.page, context: session.context, session, budget }), { onCancel: () => this.runner.cancelPage(session.page) });
      if (data && this.evidenceStore) evidenceRefs = [...evidenceRefs, ...(await this.evidenceStore.saveOperationResult(sessionId, operationId, data, { sensitiveValues, suppressScreenshots: session.suppressPixelEvidence }))];
      return { operationId, sessionId, tabId: session.tabId, status: "succeeded", elapsedMs: Date.now() - started, phase: "completed", errorCode: null, evidenceRefs, data: publicOperationResult(data) };
    } catch (error) {
      const normalized = asBrowserRunnerError(error, { operationId, sessionId, tabId: session.tabId, phase: kind });
      if (this.evidenceStore && error?.evidenceResult) {
        try { evidenceRefs = [...evidenceRefs, ...(await this.evidenceStore.saveOperationResult(sessionId, operationId, error.evidenceResult, { sensitiveValues, suppressScreenshots: session.suppressPixelEvidence }))]; } catch {}
      }
      if (this.evidenceStore) {
        try { evidenceRefs.push(await this.evidenceStore.writeJson(sessionId, operationId, "error", normalized.toJSON(), { sensitiveValues })); } catch {}
      }
      if (normalized.code === "BROWSER_OPERATION_FAILED" && /Target page, context or browser has been closed/i.test(normalized.message)) {
        session.state = "closed";
        normalized.code = "TAB_CLOSED";
        normalized.phase = "session";
      }
      if (["DEADLINE_EXCEEDED", "CANCELLED"].includes(normalized.code)) {
        session.state = "stale";
        session.staleReason = normalized.code === "DEADLINE_EXCEEDED"
          ? "浏览器操作超时；旧 tab 已淘汰，必须显式 reconnect。"
          : "浏览器操作被取消；旧 tab 已淘汰，必须显式 reconnect。";
        await this.runner.closeContext(session.context).catch(() => {});
      }
      return errorEnvelope(normalized, meta, Date.now() - started, evidenceRefs);
    } finally {
      this.operations.delete(operationId);
      session.operation = null;
      if (!["stale", "closed"].includes(session.state)) session.state = "ready";
      session.updatedAt = nowIso();
      session.lastHeartbeatAt = nowIso();
      session.leaseExpiresAt = new Date(Date.now() + this.leaseMs).toISOString();
    }
  }

  navigate(sessionId, input = {}) {
    return this.withOperation(sessionId, "navigate", input, ({ page, budget }) => this.runner.navigate(page, input, budget));
  }

  inspect(sessionId, input = {}) {
    return this.withOperation(sessionId, "inspect", input, ({ page, budget }) => this.runner.inspect(page, input, budget));
  }

  act(sessionId, input = {}) {
    return this.withOperation(sessionId, "act", input, ({ page, budget }) => this.runner.act(page, input, budget));
  }

  assert(sessionId, input = {}) {
    return this.withOperation(sessionId, "assert", input, ({ page, budget }) => this.runner.assert(page, input, budget));
  }

  list() {
    return [...this.sessions.values()].map(publicSession);
  }

  dispose() {
    clearInterval(this.timer);
    return Promise.all([...this.sessions.keys()].map((sessionId) => this.close(sessionId).catch(() => {})));
  }
}

export { publicSession };
