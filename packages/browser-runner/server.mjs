import http from "node:http";
import { randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EvidenceStore } from "./lib/evidence-store.mjs";
import { PlaywrightRunner } from "./lib/browser-runner.mjs";
import { BrowserRunnerError } from "./lib/operation-budget.mjs";
import { SessionManager } from "./lib/session-manager.mjs";
import { TestControlPlane } from "./lib/test-control-plane.mjs";
import { ExternalCheckService } from "./lib/external-check-service.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONSOLE_ASSETS = new Map([
  ["/", { file: "index.html", type: "text/html; charset=utf-8" }],
  ["/console.js", { file: "console.js", type: "text/javascript; charset=utf-8" }],
  ["/console.css", { file: "console.css", type: "text/css; charset=utf-8" }],
]);
const MAX_BODY_BYTES = 2 * 1024 * 1024;

function sendJson(response, statusCode, value) {
  const body = JSON.stringify(value);
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "content-type, x-agent-eval-client",
    "x-content-type-options": "nosniff",
  });
  response.end(body);
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new BrowserRunnerError("REQUEST_TOO_LARGE", "请求体超过 2 MiB 限制。", { statusCode: 413, phase: "request" }));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); }
      catch { reject(new BrowserRunnerError("INVALID_JSON", "请求体不是有效 JSON。", { statusCode: 400, phase: "request" })); }
    });
    request.on("error", reject);
  });
}

function pathParts(url) {
  return url.pathname.split("/").filter(Boolean).map((value) => decodeURIComponent(value));
}

function statusFor(result) {
  return Number.isInteger(result?.httpStatus) ? result.httpStatus : result?.status === "succeeded" ? 200 : 502;
}

function sessionResult(session, startedAt, operationId = undefined, phase = "session") {
  return {
    operationId: operationId || randomUUID(),
    sessionId: session.sessionId,
    tabId: session.tabId,
    status: "succeeded",
    elapsedMs: Date.now() - startedAt,
    phase,
    errorCode: null,
    evidenceRefs: session.traceRefs || [],
    session,
  };
}

function errorResponse(error) {
  const normalized = error instanceof BrowserRunnerError ? error : new BrowserRunnerError("SERVICE_ERROR", error instanceof Error ? error.message : String(error), { statusCode: 500, phase: "service" });
  return { errorCode: normalized.code, error: normalized.toJSON(), phase: normalized.phase };
}

export function createBrowserService(options = {}) {
  const dataRoot = path.resolve(options.dataRoot || path.join(HERE, "data"));
  const evidenceStore = options.evidenceStore || new EvidenceStore({ root: path.join(dataRoot, "evidence") });
  const runner = options.runner || new PlaywrightRunner({
    headless: options.headless !== false,
    browserName: options.browserName || process.env.AGENT_EVAL_BROWSER || "chromium",
    executablePath: options.executablePath || process.env.AGENT_EVAL_BROWSER_EXECUTABLE,
    profileRoot: options.profileRoot || path.join(dataRoot, "profiles"),
  });
  const manager = options.manager || new SessionManager({ runner, evidenceStore, traceRoot: path.join(dataRoot, "traces"), leaseMs: options.leaseMs, heartbeatMs: options.heartbeatMs });
  const controlPlane = options.controlPlane || new TestControlPlane({
    statePath: path.join(dataRoot, "test-cases.json"),
    env: options.env,
    secretResolver: options.secretResolver,
  });
  const externalChecks = options.externalChecks || new ExternalCheckService({
    statePath: path.join(dataRoot, "external-check-runs.json"),
    adapter: options.externalCheckAdapter,
  });
  const dshBridgeUrl = options.dshBridgeUrl || process.env.AGENT_EVAL_DSH_URL || null;
  const dshRequest = async (pathname, init = {}) => {
    if (!dshBridgeUrl) throw new BrowserRunnerError("DSH_NOT_CONFIGURED", "DSH 服务尚未配置。", { statusCode: 503, phase: "dsh-bridge" });
    let response;
    try {
      response = await fetch(new URL(pathname, dshBridgeUrl), { ...init, signal: AbortSignal.timeout(init.timeoutMs || 10_000), headers: { "content-type": "application/json", ...init.headers } });
    } catch (error) {
      throw new BrowserRunnerError("DSH_UNREACHABLE", "暂时无法连接 DSH 服务。", { statusCode: 503, phase: "dsh-bridge", details: { cause: error?.name || "network" } });
    }
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new BrowserRunnerError("DSH_REQUEST_FAILED", payload?.error?.message || payload?.message || (typeof payload?.error === "string" ? payload.error : "DSH 请求失败。"), { statusCode: response.status, phase: "dsh-bridge" });
    return payload;
  };
  const integrations = Array.isArray(options.integrations) ? options.integrations.map((item) => ({
    id: String(item.id || ""),
    version: String(item.version || "0.1.0"),
    capabilities: Array.isArray(item.capabilities) ? item.capabilities.map(String) : [],
  })).filter((item) => item.id) : [];

  const server = http.createServer(async (request, response) => {
    if (request.method === "OPTIONS") { response.writeHead(204, { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type, x-agent-eval-client" }); response.end(); return; }
    try {
      const url = new URL(request.url, "http://127.0.0.1");
      const parts = pathParts(url);
      if (request.method === "GET" && CONSOLE_ASSETS.has(url.pathname)) {
        const asset = CONSOLE_ASSETS.get(url.pathname);
        const body = await readFile(path.join(HERE, "public", asset.file));
        response.writeHead(200, { "content-type": asset.type, "content-length": body.length, "cache-control": "no-store", "x-content-type-options": "nosniff" });
        response.end(body);
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/health") {
        const health = await runner.health();
        sendJson(response, 200, { ok: true, service: "agent-eval-browser-runner", mode: "dev", runner: health, sessionCount: manager.list().length, sessions: manager.list().map((item) => ({ sessionId: item.sessionId, tabId: item.tabId, state: item.state })) });
        return;
      }
      if (parts[0] === "api" && parts[1] === "test-proposals") {
        const resource = parts[2];
        const jobId = parts[3];
        const action = parts[4];
        if (request.method === "GET" && resource === "health") { sendJson(response, 200, await dshRequest("/api/health")); return; }
        if (request.method === "GET" && resource === "jobs" && !jobId) { sendJson(response, 200, await dshRequest(`/api/jobs?kind=test-proposal&limit=${Math.min(50, Number(url.searchParams.get("limit")) || 20)}`)); return; }
        if (request.method === "GET" && resource === "jobs" && jobId && !action) {
          const payload = await dshRequest(`/api/jobs/${encodeURIComponent(jobId)}`);
          if (options.proposalPreset) payload.proposalContext = (await options.proposalPreset("current-trace"))?.context || null;
          try { payload.review = await controlPlane.get(`dsh-proposal-${jobId}`); } catch (error) { if (error?.code !== "TEST_CASE_NOT_FOUND") throw error; }
          sendJson(response, 200, payload);
          return;
        }
        if (request.method === "POST" && resource === "jobs" && !jobId) {
          const body = await readJson(request);
          const proposalInput = body.preset && options.proposalPreset ? await options.proposalPreset(body.preset) : body;
          sendJson(response, 202, await dshRequest("/api/test-proposals", { method: "POST", body: JSON.stringify(proposalInput), timeoutMs: 15_000 }));
          return;
        }
        if (request.method === "PATCH" && resource === "jobs" && jobId && action === "review") {
          const body = await readJson(request);
          const payload = await dshRequest(`/api/jobs/${encodeURIComponent(jobId)}`);
          const output = payload.job?.result?.structuredOutput;
          if (!output || !Array.isArray(output.confirmations)) throw new BrowserRunnerError("PROPOSAL_NOT_READY", "DSH 提案尚未生成可确认内容。", { statusCode: 409, phase: "dsh-review" });
          const rawAnswers = Array.isArray(body.answers) ? body.answers : [];
          const oversizedAnswer = rawAnswers.find((item) => String(item?.value || "").length > 4000);
          if (oversizedAnswer) throw new BrowserRunnerError("CONFIRMATION_TOO_LONG", "单项确认内容不能超过 4000 个字符，请精简后再保存。", { statusCode: 422, phase: "dsh-review" });
          const answers = new Map(rawAnswers.map((item) => [String(item.id), String(item.value || "").trim()]));
          const items = output.confirmations.map((item, index) => ({
            id: String(item.id || `confirmation-${index + 1}`), question: String(item.question || "待确认项"), proposedValue: String(item.proposedValue || ""),
            humanValue: answers.get(String(item.id || `confirmation-${index + 1}`)) || "", blocking: item.blocking === true,
            status: answers.get(String(item.id || `confirmation-${index + 1}`)) ? "confirmed" : "unresolved", evidence: Array.isArray(item.evidence) ? item.evidence.map(String) : [],
          }));
          const requestedStatus = String(body.status || "pending");
          if (requestedStatus === "confirmed" && items.some((item) => item.blocking && !item.humanValue)) throw new BrowserRunnerError("CONFIRMATION_INCOMPLETE", "仍有必须确认的内容没有填写。", { statusCode: 422, phase: "dsh-review" });
          const id = `dsh-proposal-${jobId}`;
          const input = {
            id, title: `DSH 提案 · ${String(output.summary || "轨迹分析").slice(0, 80)}`, description: String(output.summary || ""), project: "DSH 只读轨迹分析",
            assetState: "draft", draftIssues: (output.unknowns || []).map((message) => ({ code: "DSH_UNKNOWN", message: String(message) })),
            metadata: { kind: "dsh-proposal", proposalId: jobId },
            humanConfirmation: { status: requestedStatus, questions: items.map((item) => item.question), items },
          };
          let testCase;
          try { await controlPlane.get(id); testCase = await controlPlane.update(id, input); }
          catch (error) { if (error?.code !== "TEST_CASE_NOT_FOUND") throw error; testCase = await controlPlane.create(input); }
          sendJson(response, 200, { testCase });
          return;
        }
      }
      if (request.method === "GET" && url.pathname === "/api/spec") {
        sendJson(response, 200, {
          service: "agent-eval-browser-runner",
          operations: {
            "POST /api/sessions": "创建常驻浏览器 context/page；可传 profileDir 和 url。",
            "GET /api/sessions/:id": "读取 session/tab 状态。",
            "GET /api/sessions/:id/health": "读取 session 健康状态。",
            "POST /api/sessions/:id/navigate": "导航到 URL，支持 deadlineMs/totalBudgetMs。",
            "POST /api/sessions/:id/inspect": "读取有界的脱敏 DOM 摘要并保存截图证据。",
            "POST /api/sessions/:id/act": "执行 click/fill/upload/scroll 等动作；写动作必须携带 approvedScope，弹框必须声明 dialogAction。",
            "POST /api/sessions/:id/assert": "执行 URL/title/visible/text/value/count 断言。",
            "POST /api/sessions/:id/cancel": "取消当前 operation，不在同一 tab 盲重试。",
            "POST /api/sessions/:id/close": "关闭 tab/context。",
            "POST /api/sessions/:id/reconnect": "显式重建 stale session；不会对原 tab 盲重试。",
            "GET /api/sessions/:id/trace": "停止并保存 Playwright trace；默认随后可重新建立 session。",
            "GET /api/test-cases": "列出控制平面中的测试资产。",
            "POST /api/test-cases": "创建测试资产（setup/步骤/断言/环境/门禁策略）。",
            "POST /api/test-cases/:id/runs": "执行 runnable 测试资产；draft 或待补全资产会被阻断。",
            "GET /api/checks": "列出外部适配器注册的固定回归检查及历史。",
            "POST /api/checks/:id/runs": "通过资产预绑定的白名单执行入口启动回归；不接受任意命令。",
            "GET|POST /api/test-proposals/jobs": "查看或启动 DSH 只读轨迹提案任务；不会应用代码。",
            "PATCH /api/test-proposals/jobs/:id/review": "把人工确认内容保存为控制平面测试资产。",
          },
          response: { operationId: "string", sessionId: "string", tabId: "string", status: "succeeded|failed|cancelling", elapsedMs: "number", phase: "string", errorCode: "string|null", evidenceRefs: "string[]" },
          setupFixture: {
            environment: { baseUrl: "http(s) URL", locale: "optional locale" },
            operations: ["navigate", "act", "assert"],
            runtimeInput: ["valueFrom.env", "valueFrom.secretRef"],
            inlineFillValue: "forbidden",
            playwrightTraceWithRuntimeInput: "suppressed",
          },
          testSteps: {
            operations: ["navigate", "act", "assert"],
            legacyWithoutOperation: "act",
            failureBehavior: "short-circuit",
            mutationAuthorization: "approvedScope required",
            nativeDialogPolicy: "explicit dialogAction=accept|dismiss; otherwise auto-dismiss and DIALOG_REQUIRED",
          },
          testRuns: {
            executionStatus: "not_started|completed|interrupted",
            businessVerdict: "passed|not_evaluated",
            noAssertions: "status=completed, businessVerdict=not_evaluated",
            cleanup: "records cleanup operations and session-close failures",
            versionEvidence: "caseVersion + caseSnapshot + caseSnapshotDigest",
          },
          evidencePolicy: {
            screenshots: "mandatory per operation; before+after for mutations",
            trace: "mandatory except runtime-value setup where screenshots/trace are suppressed",
            visibleTextLimit: 8000,
          },
          integrations,
        });
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/sessions") { sendJson(response, 200, { sessions: manager.list() }); return; }
      if (parts[0] === "api" && parts[1] === "sessions" && parts.length >= 3) {
        const sessionId = parts[2];
        const action = parts[3];
        if (request.method === "GET" && !action) { const startedAt = Date.now(); const session = manager.get(sessionId); sendJson(response, 200, sessionResult(session, startedAt, undefined, "session")); return; }
        if (request.method === "GET" && action === "health") {
          const session = manager.get(sessionId);
          const startedAt = Date.now();
          await manager.heartbeat();
          const currentSession = manager.get(sessionId); sendJson(response, 200, { ...sessionResult(currentSession, startedAt, undefined, "health"), runner: await runner.health() });
          return;
        }
        if (request.method === "GET" && action === "trace") { const result = await manager.getTrace(sessionId, { stop: url.searchParams.get("stop") !== "0" }); sendJson(response, statusFor(result), result); return; }
        const body = request.method === "POST" ? await readJson(request) : {};
        if (request.method === "POST" && !action) {
          const startedAt = Date.now();
          const session = await manager.close(sessionId);
          sendJson(response, 200, sessionResult(session, startedAt, body.operationId, "close"));
          return;
        }
        if (request.method === "POST" && action === "navigate") { const result = await manager.navigate(sessionId, body); sendJson(response, statusFor(result), result); return; }
        if (request.method === "POST" && action === "inspect") { const result = await manager.inspect(sessionId, body); sendJson(response, statusFor(result), result); return; }
        if (request.method === "POST" && action === "act") { const result = await manager.act(sessionId, body); sendJson(response, statusFor(result), result); return; }
        if (request.method === "POST" && action === "assert") { const result = await manager.assert(sessionId, body); sendJson(response, statusFor(result), result); return; }
        if (request.method === "POST" && action === "cancel") { const result = await manager.cancel(sessionId, body.operationId); sendJson(response, statusFor(result), result); return; }
        if (request.method === "POST" && action === "close") { const startedAt = Date.now(); const session = await manager.close(sessionId); sendJson(response, 200, sessionResult(session, startedAt, body.operationId, "close")); return; }
        if (request.method === "POST" && action === "reconnect") { const startedAt = Date.now(); const session = await manager.reconnect(sessionId, body); sendJson(response, 200, sessionResult(session, startedAt, body.operationId, "reconnect")); return; }
      }
      if (parts[0] === "api" && parts[1] === "sessions" && parts.length === 2 && request.method === "POST") {
        const startedAt = Date.now();
        const body = await readJson(request);
        const session = await manager.createSession(body);
        sendJson(response, 201, sessionResult(session, startedAt, body.operationId, "createSession"));
        return;
      }
      if (parts[0] === "api" && parts[1] === "test-cases") {
        const caseId = parts[2];
        const action = parts[3];
        if (request.method === "GET" && !caseId) { sendJson(response, 200, { cases: await controlPlane.list() }); return; }
        if (request.method === "GET" && caseId && !action) { sendJson(response, 200, { testCase: await controlPlane.get(caseId) }); return; }
        if (request.method === "POST" && !caseId) { const body = await readJson(request); sendJson(response, 201, { testCase: await controlPlane.create(body) }); return; }
        if (request.method === "PATCH" && caseId && !action) { const body = await readJson(request); sendJson(response, 200, { testCase: await controlPlane.update(caseId, body) }); return; }
        if (request.method === "DELETE" && caseId && !action) { sendJson(response, 200, { testCase: await controlPlane.remove(caseId) }); return; }
        if (request.method === "POST" && caseId && action === "runs") {
          const body = await readJson(request);
          const result = await controlPlane.run(caseId, manager, body);
          sendJson(response, ["passed", "completed"].includes(result.status) ? 200 : 422, result);
          return;
        }
      }
      if (parts[0] === "api" && parts[1] === "checks") {
        const checkId = parts[2];
        const action = parts[3];
        if (request.method === "GET" && !checkId) { sendJson(response, 200, { checks: await externalChecks.list() }); return; }
        if (request.method === "GET" && checkId && !action) { sendJson(response, 200, { check: await externalChecks.get(checkId) }); return; }
        if (request.method === "POST" && checkId && action === "runs") { sendJson(response, 202, { run: await externalChecks.start(checkId) }); return; }
      }
      sendJson(response, 404, { errorCode: "NOT_FOUND", error: { code: "NOT_FOUND", message: "没有对应的 API 路由。", phase: "router", retryable: false, details: null } });
    } catch (error) {
      const normalized = error instanceof BrowserRunnerError ? error : new BrowserRunnerError("SERVICE_ERROR", error instanceof Error ? error.message : String(error), { statusCode: 500, phase: "service" });
      sendJson(response, normalized.statusCode || 500, errorResponse(normalized));
    }
  });

  return { server, runner, manager, controlPlane, externalChecks, evidenceStore, integrations, dataRoot };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const port = Number(process.env.PORT || 4321);
  const host = process.env.HOST || "127.0.0.1";
  await mkdir(path.join(HERE, "data"), { recursive: true, mode: 0o700 });
  const service = createBrowserService({ headless: !/^(0|false|no)$/i.test(String(process.env.AGENT_EVAL_HEADLESS || "true")) });
  service.server.listen(port, host, () => console.log(`agent-eval browser runner listening on http://${host}:${port}`));
  const shutdown = async () => { await service.manager.dispose(); await service.runner.close().catch(() => {}); service.server.close(() => process.exit(0)); };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
