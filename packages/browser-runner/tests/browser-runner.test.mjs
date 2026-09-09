import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createBrowserService } from "../server.mjs";
import { EvidenceStore, sanitizeUrl } from "../lib/evidence-store.mjs";
import { BrowserRunnerError } from "../lib/operation-budget.mjs";
import { materializeOperationStep } from "../lib/setup-fixture.mjs";

class FakePage {
  constructor() { this.currentUrl = "about:blank"; this.closed = false; this.cancelled = false; }
  isClosed() { return this.closed; }
  url() { return this.currentUrl; }
  async close() { this.closed = true; }
}

class FakeRunner {
  constructor() { this.alive = true; this.contexts = new Set(); this.disconnectHandler = null; this.cancelCount = 0; this.calls = []; }
  set onDisconnected(value) { this.disconnectHandler = value; }
  async health() { return { ready: this.alive && [...this.contexts].some((item) => !item.closed), provider: "fake", browserConnected: this.alive }; }
  async createContext(options = {}) { const context = { closed: false, traceStarted: false, traceStartCount: 0, options }; this.contexts.add(context); this.calls.push({ operation: "createContext", options }); return context; }
  async newPage() { return new FakePage(); }
  async startTrace(context) { context.traceStarted = true; context.traceStartCount += 1; }
  async stopTrace(_context, tracePath) { await writeFile(tracePath, "fake trace"); }
  async closeContext(context) { context.closed = true; this.contexts.delete(context); }
  async close() { this.alive = false; for (const context of this.contexts) context.closed = true; this.contexts.clear(); }
  async cancelPage(page) { page.cancelled = true; this.cancelCount += 1; }
  async navigate(page, input, budget) {
    const delay = Number(input.delayMs || 0);
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    budget.throwIfExpired();
    page.currentUrl = input.url;
    this.calls.push({ operation: "navigate", url: input.url });
    return { url: input.url, waitUntil: "domcontentloaded" };
  }
  async inspect(page) {
    return {
      url: page.currentUrl,
      title: "测试页",
      elements: [{ label: "保存", tag: "button", visible: true }],
      domSnapshot: { url: page.currentUrl, elements: [{ label: "保存" }] },
      network: [{ kind: "request", method: "GET", url: "http://example.test/api/data?token=secret" }],
      screenshotBuffer: Buffer.from("fake png"),
    };
  }
  async act(page, input) { this.calls.push({ operation: "act", action: input.action, target: input.target || null, value: input.value }); if (input.action === "fixture-fail") throw new BrowserRunnerError("FIXTURE_STEP_FAILED", "fixture requested failure", { statusCode: 422, phase: "act" }); if (input.action === "navigate") page.currentUrl = input.value; return { action: input.action, target: input.target || null, debugValue: input.value, screenshotBuffer: input.value == null ? undefined : Buffer.from(String(input.value)) }; }
  async assert(_page, input) { this.calls.push({ operation: "assert", type: input.type, expected: input.expected }); return { type: input.type || "visible", passed: true }; }
}

async function serviceWithFake(options = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "agent-eval-browser-test-"));
  const runner = new FakeRunner();
  const service = createBrowserService({ ...options, runner, dataRoot: root, evidenceStore: new EvidenceStore({ root: path.join(root, "evidence") }), heartbeatMs: 10 });
  await new Promise((resolve) => service.server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${service.server.address().port}`;
  return { root, runner, service, baseUrl };
}

async function readFilesRecursively(root) {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  const chunks = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const parentPath = entry.parentPath || entry.path;
    chunks.push(await readFile(path.join(parentPath, entry.name), "utf8"));
  }
  return chunks.join("\n");
}

async function closeService(item) {
  await item.service.manager.dispose();
  await new Promise((resolve) => item.service.server.close(resolve));
  await rm(item.root, { recursive: true, force: true });
}

test("creates session and exposes the required operation envelope", async () => {
  const item = await serviceWithFake();
  try {
    const createdResponse = await fetch(`${item.baseUrl}/api/sessions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url: "http://example.test/start" }) });
    assert.equal(createdResponse.status, 201);
    const created = await createdResponse.json();
    assert.equal(created.session.state, "ready");
    const inspected = await fetch(`${item.baseUrl}/api/sessions/${created.session.sessionId}/inspect`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ screenshot: true, password: "do-not-persist" }) }).then((response) => response.json());
    assert.equal(inspected.status, "succeeded");
    assert.match(inspected.operationId, /^[0-9a-f-]{36}$/);
    assert.equal(inspected.sessionId, created.session.sessionId);
    assert.equal(inspected.tabId, created.session.tabId);
    assert.equal(inspected.phase, "completed");
    assert.ok(inspected.evidenceRefs.length >= 4);
    const network = JSON.parse(await readFile(path.join(item.root, "evidence", created.session.sessionId, inspected.operationId, "network.json"), "utf8"));
    assert.equal(network[0].url, "http://example.test/api/data");
    const requestEvidence = await readFile(path.join(item.root, "evidence", created.session.sessionId, inspected.operationId, "operation.json"), "utf8");
    assert.doesNotMatch(requestEvidence, /do-not-persist/);
  } finally { await closeService(item); }
});

test("stale sessions fail immediately with structured STALE_SESSION", async () => {
  const item = await serviceWithFake();
  try {
    const session = await item.service.manager.createSession();
    item.runner.alive = false;
    await item.service.manager.heartbeat();
    const started = Date.now();
    const result = await item.service.manager.inspect(session.sessionId);
    assert.ok(Date.now() - started < 1000);
    assert.equal(result.status, "failed");
    assert.equal(result.errorCode, "STALE_SESSION");
    assert.equal(result.phase, "session");
  } finally { await closeService(item); }
});

test("deadline and cancel stop an operation without a blind same-tab retry", async () => {
  const item = await serviceWithFake();
  try {
    const session = await item.service.manager.createSession();
    const timedOut = await item.service.manager.navigate(session.sessionId, { url: "http://example.test/slow", delayMs: 100, deadlineMs: 20 });
    assert.equal(timedOut.errorCode, "DEADLINE_EXCEEDED");
    assert.equal(item.runner.cancelCount, 1);
    assert.equal(item.service.manager.get(session.sessionId).state, "stale");

    await item.service.manager.reconnect(session.sessionId);

    const running = item.service.manager.navigate(session.sessionId, { url: "http://example.test/cancel", delayMs: 500, deadlineMs: 1000 });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const operationId = item.service.manager.get(session.sessionId).operation.operationId;
    const cancel = await item.service.manager.cancel(session.sessionId, operationId);
    assert.equal(cancel.status, "cancelling");
    const cancelled = await running;
    assert.equal(cancelled.errorCode, "CANCELLED");
    assert.equal(item.service.manager.get(session.sessionId).state, "stale");
  } finally { await closeService(item); }
});

test("same tab is single-flight and browser disconnect marks it stale", async () => {
  const item = await serviceWithFake();
  try {
    const session = await item.service.manager.createSession();
    const first = item.service.manager.navigate(session.sessionId, { url: "http://example.test/one", delayMs: 80, deadlineMs: 500 });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await item.service.manager.navigate(session.sessionId, { url: "http://example.test/two", deadlineMs: 500 });
    assert.equal(second.errorCode, "TAB_BUSY");
    await first;
    item.runner.alive = false;
    item.runner.disconnectHandler?.();
    assert.equal(item.service.manager.get(session.sessionId).state, "stale");
  } finally { await closeService(item); }
});

test("reconnect replaces a stale tab explicitly and starts a fresh trace", async () => {
  const item = await serviceWithFake();
  try {
    const session = await item.service.manager.createSession();
    const oldTabId = session.tabId;
    item.runner.alive = false;
    item.runner.disconnectHandler?.();
    item.runner.alive = true;
    const reconnected = await item.service.manager.reconnect(session.sessionId);
    assert.equal(reconnected.state, "ready");
    assert.notEqual(reconnected.tabId, oldTabId);
    assert.equal(reconnected.traceActive, true);
  } finally { await closeService(item); }
});

test("control plane persists a case with assertions and records runs", async () => {
  const item = await serviceWithFake();
  try {
    const created = await item.service.controlPlane.create({ title: "登录页 smoke", project: "sample-app", approvedScope: "允许此测试用例修改本地测试数据", startUrl: "http://example.test/login", steps: [{ action: "click", target: { role: "button", name: "登录" } }], assertions: [{ type: "visible", target: { testId: "home" } }], policy: { gate: true } });
    assert.equal(created.version, 1);
    const result = await item.service.controlPlane.run(created.id, item.service.manager, { closeAfterRun: false });
    assert.equal(result.status, "passed");
    assert.equal(result.executionStatus, "completed");
    assert.equal(result.businessVerdict, "passed");
    assert.equal(result.caseVersion, 1);
    assert.equal(result.caseSnapshot.version, 1);
    assert.equal(result.caseSnapshot.runs, undefined);
    assert.match(result.caseSnapshotDigest, /^[a-f0-9]{64}$/);
    assert.ok(result.sessionId);
    const loaded = await item.service.controlPlane.get(created.id);
    assert.equal(loaded.runs.length, 1);
    await item.service.manager.close(result.sessionId);
  } finally { await closeService(item); }
});

test("control plane keeps both step limits and an anchored run deadline", async () => {
  const item = await serviceWithFake();
  try {
    const created = await item.service.controlPlane.create({ title: "budget regression", steps: [{ operation: "navigate", url: "http://example.test/slow", delayMs: 100 }] });
    const result = await item.service.controlPlane.run(created.id, item.service.manager, { deadlineMs: 20, totalBudgetMs: 300000 });
    assert.equal(result.status, "failed");
    assert.equal(result.operations[0].errorCode, "DEADLINE_EXCEEDED");
    const second = await item.service.controlPlane.run(created.id, item.service.manager, { deadlineMs: 300000, totalBudgetMs: 20 });
    assert.equal(second.status, "failed");
    assert.equal(second.operations[0].errorCode, "DEADLINE_EXCEEDED");
  } finally { await closeService(item); }
});

test("top-level steps interleave act, relative navigate, and assert while preserving ordered evidence", async () => {
  const item = await serviceWithFake();
  try {
    const created = await item.service.controlPlane.create({
      title: "save refresh assert restore",
      approvedScope: "允许此用例修改和恢复本地测试记录",
      environment: { baseUrl: "http://example.test/app/" },
      steps: [
        { operation: "act", action: "click", target: { role: "button", name: "Save" } },
        { operation: "navigate", url: "./record/1" },
        { operation: "assert", type: "url", expected: "./record/1" },
        { operation: "act", action: "click", target: { role: "button", name: "Restore" } },
      ],
    });
    const result = await item.service.controlPlane.run(created.id, item.service.manager, { closeAfterRun: false });
    assert.equal(result.status, "passed");
    assert.equal(result.executionStatus, "completed");
    assert.equal(result.businessVerdict, "passed");
    assert.deepEqual(item.runner.calls.filter((call) => call.operation !== "createContext").map((call) => call.operation), ["act", "navigate", "assert", "act"]);
    assert.equal(item.runner.calls.find((call) => call.operation === "navigate").url, "http://example.test/app/record/1");
    assert.equal(item.runner.calls.find((call) => call.operation === "assert").expected, "http://example.test/app/record/1");
    assert.equal(result.operations.length, 4);
    assert.deepEqual(result.evidenceRefs, result.operations.flatMap((operation) => operation.evidenceRefs || []));
    assert.ok(result.operations.every((operation) => operation.evidenceRefs.length >= 2));
    await item.service.manager.close(result.sessionId);
  } finally { await closeService(item); }
});

test("legacy top-level steps without operation remain act steps", async () => {
  const item = await serviceWithFake();
  try {
    const created = await item.service.controlPlane.create({
      title: "legacy action sequence",
      approvedScope: "允许点击本地测试页面",
      steps: [{ action: "click", target: { role: "button", name: "Legacy save" } }],
    });
    assert.equal(created.steps[0].operation, "act");
    const result = await item.service.controlPlane.run(created.id, item.service.manager, { closeAfterRun: false });
    assert.equal(result.status, "completed");
    assert.equal(result.executionStatus, "completed");
    assert.equal(result.businessVerdict, "not_evaluated");
    assert.deepEqual(item.runner.calls.filter((call) => call.operation !== "createContext").map((call) => call.operation), ["act"]);
    await item.service.manager.close(result.sessionId);
  } finally { await closeService(item); }
});

test("top-level fill keeps an explicit non-secret value", async () => {
  const item = await serviceWithFake();
  try {
    const created = await item.service.controlPlane.create({
      title: "ordinary editable field",
      approvedScope: "允许修改本地测试显示名",
      steps: [{ operation: "act", action: "fill", target: { label: "Display name" }, value: "temporary test name" }],
    });
    const result = await item.service.controlPlane.run(created.id, item.service.manager, { closeAfterRun: false });
    assert.equal(result.status, "completed");
    assert.equal(result.executionStatus, "completed");
    assert.equal(result.businessVerdict, "not_evaluated");
    const fillCall = item.runner.calls.find((call) => call.operation === "act");
    assert.equal(fillCall.value, "temporary test name");
    await item.service.manager.close(result.sessionId);
  } finally { await closeService(item); }
});

test("a failed interleaved step records failure evidence and short-circuits later steps", async () => {
  const item = await serviceWithFake();
  try {
    const created = await item.service.controlPlane.create({
      title: "short circuit",
      approvedScope: "允许执行本地失败测试夹具",
      environment: { baseUrl: "http://example.test/" },
      steps: [
        { operation: "act", action: "click", target: { text: "Before" } },
        { operation: "navigate", url: "/refresh" },
        { operation: "act", action: "fixture-fail", target: { text: "Fail" } },
        { operation: "assert", type: "url", expected: "/must-not-run" },
        { operation: "act", action: "click", target: { text: "After" } },
      ],
    });
    const result = await item.service.controlPlane.run(created.id, item.service.manager, { closeAfterRun: false });
    assert.equal(result.status, "failed");
    assert.equal(result.errorCode, "FIXTURE_STEP_FAILED");
    assert.deepEqual(item.runner.calls.filter((call) => call.operation !== "createContext").map((call) => call.operation), ["act", "navigate", "act"]);
    assert.equal(result.operations.length, 3);
    assert.equal(result.operations[2].status, "failed");
    assert.deepEqual(result.evidenceRefs, result.operations.flatMap((operation) => operation.evidenceRefs || []));
    assert.ok(result.operations[2].evidenceRefs.length >= 1);
    const evidence = await readFilesRecursively(path.join(item.root, "evidence"));
    assert.match(evidence, /fixture-fail/);
    assert.doesNotMatch(evidence, /must-not-run|After/);
    await item.service.manager.close(result.sessionId);
  } finally { await closeService(item); }
});

test("draft assets and unresolved issues hard-block execution before a session is created", async () => {
  const item = await serviceWithFake();
  try {
    const created = await item.service.controlPlane.create({
      title: "incomplete imported trace",
      assetState: "draft",
      draftIssues: [{ code: "MISSING_LOCATOR", stepId: "s01", message: "缺少唯一定位" }],
      steps: [],
    });
    const result = await item.service.controlPlane.run(created.id, item.service.manager);
    assert.equal(result.status, "blocked");
    assert.equal(result.executionStatus, "not_started");
    assert.equal(result.businessVerdict, "not_evaluated");
    assert.equal(result.errorCode, "TEST_CASE_NOT_EXECUTABLE");
    assert.equal(item.runner.calls.length, 0);
  } finally { await closeService(item); }
});

test("cleanup runs after a completed main sequence and keeps cleanup failure evidence visible", async () => {
  const item = await serviceWithFake();
  try {
    const created = await item.service.controlPlane.create({
      title: "cleanup evidence",
      approvedScope: "允许执行和清理本地测试夹具",
      steps: [{ action: "click", target: { text: "Create temporary record" } }],
      cleanup: { steps: [{ operation: "act", action: "fixture-fail", target: { text: "Remove temporary record" } }] },
    });
    const result = await item.service.controlPlane.run(created.id, item.service.manager, { closeAfterRun: false });
    assert.equal(result.status, "failed");
    assert.equal(result.executionStatus, "completed");
    assert.equal(result.businessVerdict, "not_evaluated");
    assert.equal(result.errorCode, "FIXTURE_STEP_FAILED");
    assert.equal(result.cleanup.status, "failed");
    assert.equal(result.cleanup.operations.length, 1);
    assert.deepEqual(result.evidenceRefs, [
      ...result.operations.flatMap((operation) => operation.evidenceRefs || []),
      ...result.cleanup.evidenceRefs,
    ]);
    await item.service.manager.close(result.sessionId);
  } finally { await closeService(item); }
});

test("owned session close failures are visible in the same run", async () => {
  const item = await serviceWithFake();
  try {
    const created = await item.service.controlPlane.create({
      title: "close failure evidence",
      steps: [],
    });
    const manager = {
      createSession: async () => ({ sessionId: "synthetic-close" }),
      close: async () => {
        throw new BrowserRunnerError("SESSION_CLOSE_FAILED", "generic close message", {
          phase: "close",
          details: { failures: [{ code: "SYNTHETIC_DISK_FULL", phase: "trace", message: "must not persist" }] },
        });
      },
    };
    const result = await item.service.controlPlane.run(created.id, manager);
    assert.equal(result.status, "failed");
    assert.equal(result.executionStatus, "completed");
    assert.equal(result.errorCode, "SESSION_CLOSE_FAILED");
    assert.equal(result.cleanup.status, "failed");
    assert.equal(result.cleanup.sessionClose.status, "failed");
    assert.equal(result.cleanup.sessionClose.failures[0].code, "SYNTHETIC_DISK_FULL");
    assert.equal(result.cleanup.sessionClose.failures[0].phase, "trace");
    assert.doesNotMatch(JSON.stringify(result.cleanup.sessionClose), /must not persist/);
  } finally { await closeService(item); }
});

test("a run finishing after a case update appends history to the latest version", async () => {
  const item = await serviceWithFake();
  try {
    const created = await item.service.controlPlane.create({
      title: "version one",
      steps: [{ action: "click", target: { text: "A" } }],
    });
    let release;
    let entered;
    const barrier = new Promise((resolve) => { release = resolve; });
    const started = new Promise((resolve) => { entered = resolve; });
    const manager = {
      createSession: async () => ({ sessionId: "synthetic-update" }),
      act: async () => {
        entered();
        await barrier;
        return { status: "succeeded", evidenceRefs: [] };
      },
      close: async () => ({}),
    };
    const runPromise = item.service.controlPlane.run(created.id, manager);
    await started;
    const updated = await item.service.controlPlane.update(created.id, {
      title: "version two",
      steps: [{ action: "click", target: { text: "B" } }],
    });
    release();
    const run = await runPromise;
    const stored = await item.service.controlPlane.get(created.id);
    assert.equal(run.caseVersion, 1);
    assert.equal(run.caseSnapshot.title, "version one");
    assert.equal(updated.version, 2);
    assert.equal(stored.version, 2);
    assert.equal(stored.title, "version two");
    assert.equal(stored.runs.length, 1);
    assert.equal(stored.runs[0].caseVersion, 1);
    const disk = JSON.parse(await readFile(path.join(item.root, "test-cases.json"), "utf8"));
    assert.equal(disk.cases[0].version, 2);
    assert.equal(disk.cases[0].runs.length, 1);
  } finally { await closeService(item); }
});

test("HTTP returns 200 for execution-only completion and 422 for draft blocking", async () => {
  const item = await serviceWithFake();
  try {
    const headers = { "content-type": "application/json" };
    const runnable = await fetch(`${item.baseUrl}/api/test-cases`, {
      method: "POST", headers, body: JSON.stringify({ title: "execution only", steps: [] }),
    }).then((response) => response.json());
    const completedResponse = await fetch(`${item.baseUrl}/api/test-cases/${runnable.testCase.id}/runs`, {
      method: "POST", headers, body: "{}",
    });
    assert.equal(completedResponse.status, 200);
    assert.equal((await completedResponse.json()).status, "completed");

    const draft = await fetch(`${item.baseUrl}/api/test-cases`, {
      method: "POST", headers, body: JSON.stringify({ title: "draft", assetState: "draft", steps: [] }),
    }).then((response) => response.json());
    const blockedResponse = await fetch(`${item.baseUrl}/api/test-cases/${draft.testCase.id}/runs`, {
      method: "POST", headers, body: "{}",
    });
    assert.equal(blockedResponse.status, 422);
    assert.equal((await blockedResponse.json()).errorCode, "TEST_CASE_NOT_EXECUTABLE");
  } finally { await closeService(item); }
});

test("serves the independent control-plane console without an application frontend", async () => {
  const item = await serviceWithFake();
  try {
    const pageResponse = await fetch(`${item.baseUrl}/`);
    assert.equal(pageResponse.status, 200);
    assert.match(pageResponse.headers.get("content-type"), /text\/html/);
    const page = await pageResponse.text();
    assert.match(page, /评测控制台/);
    assert.match(page, /\/console\.js/);

    const scriptResponse = await fetch(`${item.baseUrl}/console.js`);
    assert.equal(scriptResponse.status, 200);
    const script = await scriptResponse.text();
    assert.match(script, /assetState\s*===\s*'runnable'/);
    assert.match(script, /业务未评估/);
    assert.match(script, /清理失败/);
    assert.match(script, /caseSnapshot/);
    assert.match(script, /runRequestErrors\.set/);
    assert.match(script, /执行请求状态未确认/);
  } finally { await closeService(item); }
});

test("control plane proxies read-only DSH proposals and persists human review", async () => {
  const confirmations = [{ id: "scope", question: "确认覆盖范围？", proposedValue: "保存与切章", blocking: true, evidence: ["event-1"] }];
  const job = { id: "11111111-1111-4111-8111-111111111111", kind: "test-proposal", status: "succeeded", permissionMode: "read-only", createdAt: new Date().toISOString(), result: { structuredOutput: { summary: "只读提案", confirmations, proposedSuites: { gate: [], nightly: [], manual: [] }, unknowns: [] } } };
  let submitted = null;
  const dsh = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    if (request.method === "POST") submitted = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    response.setHeader("content-type", "application/json");
    if (request.url === "/api/health") response.end(JSON.stringify({ ok: true, ready: true }));
    else if (request.url.startsWith("/api/jobs?")) response.end(JSON.stringify({ jobs: [job] }));
    else if (request.url === `/api/jobs/${job.id}`) response.end(JSON.stringify({ job }));
    else if (request.url === "/api/test-proposals") { response.statusCode = 202; response.end(JSON.stringify({ job, pollUrl: `/api/jobs/${job.id}` })); }
    else { response.statusCode = 404; response.end("{}"); }
  });
  await new Promise((resolve) => dsh.listen(0, "127.0.0.1", resolve));
  const dshUrl = `http://127.0.0.1:${dsh.address().port}`;
  const item = await serviceWithFake({ dshBridgeUrl: dshUrl, proposalPreset: async () => ({ workspace: "/allowed", trace: { events: [{ type: "click" }] } }) });
  try {
    assert.equal((await fetch(`${item.baseUrl}/api/test-proposals/health`).then((value) => value.json())).ready, true);
    const created = await fetch(`${item.baseUrl}/api/test-proposals/jobs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ preset: "current-trace" }) }).then((value) => value.json());
    assert.equal(created.job.permissionMode, "read-only");
    assert.deepEqual(submitted, { workspace: "/allowed", trace: { events: [{ type: "click" }] } });
    const draft = await fetch(`${item.baseUrl}/api/test-proposals/jobs/${job.id}/review`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: "pending", answers: [{ id: "scope", value: "先保存草稿" }] }) }).then((value) => value.json());
    assert.equal(draft.testCase.humanConfirmation.status, "pending");
    const oversizedResponse = await fetch(`${item.baseUrl}/api/test-proposals/jobs/${job.id}/review`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: "confirmed", answers: [{ id: "scope", value: `长${"x".repeat(4000)}DO_NOT_GENERATE` }] }) });
    assert.equal(oversizedResponse.status, 422);
    const afterRejection = await fetch(`${item.baseUrl}/api/test-proposals/jobs/${job.id}`).then((value) => value.json());
    assert.equal(afterRejection.review.humanConfirmation.status, "pending");
    assert.equal(afterRejection.review.humanConfirmation.items[0].humanValue, "先保存草稿");
    assert.deepEqual(afterRejection.review.runs, []);
    const saved = await fetch(`${item.baseUrl}/api/test-proposals/jobs/${job.id}/review`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: "confirmed", answers: [{ id: "scope", value: "只覆盖保存与切章" }] }) }).then((value) => value.json());
    assert.equal(saved.testCase.humanConfirmation.status, "confirmed");
    assert.equal(saved.testCase.humanConfirmation.items[0].humanValue, "只覆盖保存与切章");
    assert.equal((await fetch(`${item.baseUrl}/api/test-proposals/jobs/${job.id}`).then((value) => value.json())).review.metadata.kind, "dsh-proposal");
  } finally { await closeService(item); await new Promise((resolve) => dsh.close(resolve)); }
});

test("generic setup fixture resolves baseUrl plus env and secretRef values without persisting plaintext", async () => {
  const username = "fixture-user-never-persist";
  const password = "fixture-password-never-persist";
  const item = await serviceWithFake({
    env: { FIXTURE_USERNAME: username },
    secretResolver: async (reference) => reference === "qa/login/password" ? password : undefined,
  });
  try {
    const created = await item.service.controlPlane.create({
      title: "generic authenticated setup",
      project: "sample-app",
      approvedScope: "允许使用指定测试账号登录并执行本地回归用例",
      environment: { name: "local", baseUrl: "http://example.test/" },
      setup: {
        steps: [
          { operation: "navigate", url: "/login" },
          { operation: "act", action: "fill", target: { label: "Username" }, valueFrom: { env: "FIXTURE_USERNAME" } },
          { operation: "act", action: "fill", target: { label: "Password" }, valueFrom: { secretRef: "qa/login/password" } },
          { operation: "act", action: "click", target: { role: "button", name: "Sign in" } },
          { operation: "assert", type: "url", expected: "/dashboard" },
        ],
      },
      startUrl: "/workspace",
      assertions: [{ type: "url", expected: "/workspace" }],
    });
    assert.equal(created.environment.baseUrl, "http://example.test/");
    assert.deepEqual(created.setup.steps[1].valueFrom, { env: "FIXTURE_USERNAME" });
    const result = await item.service.controlPlane.run(created.id, item.service.manager, { closeAfterRun: false });
    assert.equal(result.status, "passed");
    assert.deepEqual(result.tracePolicy, { playwrightTrace: "suppressed", reason: "runtime-value setup may contain credentials" });

    const relevantCalls = item.runner.calls.filter((call) => call.operation !== "createContext");
    assert.deepEqual(relevantCalls.map((call) => call.operation), ["navigate", "act", "act", "act", "assert", "navigate", "assert"]);
    assert.equal(relevantCalls[0].url, "http://example.test/login");
    assert.equal(relevantCalls[1].value, username);
    assert.equal(relevantCalls[2].value, password);
    assert.equal(relevantCalls[4].expected, "http://example.test/dashboard");
    assert.equal(relevantCalls[5].url, "http://example.test/workspace");
    assert.equal(relevantCalls[6].expected, "http://example.test/workspace");
    assert.equal(item.service.manager.get(result.sessionId).traceActive, false);

    const persisted = await readFile(path.join(item.root, "test-cases.json"), "utf8");
    const evidence = await readFilesRecursively(path.join(item.root, "evidence"));
    const allArtifacts = await readFilesRecursively(item.root);
    const evidenceFiles = await readdir(path.join(item.root, "evidence"), { recursive: true });
    const publicRun = JSON.stringify(result);
    for (const sensitive of [username, password]) {
      assert.doesNotMatch(persisted, new RegExp(sensitive));
      assert.doesNotMatch(evidence, new RegExp(sensitive));
      assert.doesNotMatch(allArtifacts, new RegExp(sensitive));
      assert.doesNotMatch(publicRun, new RegExp(sensitive));
    }
    assert.match(persisted, /FIXTURE_USERNAME/);
    assert.match(persisted, /qa\/login\/password/);
    assert.equal(evidenceFiles.some((file) => String(file).endsWith(".png")), false);
    assert.equal(evidenceFiles.some((file) => String(file).endsWith("trace.zip")), false);
    await item.service.manager.close(result.sessionId);
  } finally { await closeService(item); }
});

test("Planora local login example uses an exact submit target and waits for its redirect", async () => {
  const fixture = JSON.parse(await readFile(new URL("../fixtures/generic-login-planora-local.example.json", import.meta.url), "utf8"));
  const login = fixture.setup.steps.find((step) => step.operation === "act" && step.action === "click");
  assert.deepEqual(login.target, { role: "button", name: "登录", exact: true });
  assert.deepEqual(login.waitFor, { type: "url", expected: "dashboard/projects" });
  const materialized = await materializeOperationStep(login, { baseUrl: fixture.environment.baseUrl });
  assert.equal(materialized.input.waitFor.expected, "http://127.0.0.1:3019/liutianci/dashboard/projects");
  const response = await materializeOperationStep({
    operation: "act",
    action: "click",
    target: { testId: "generate" },
    waitFor: { type: "response", url: "api/generate", method: "POST" },
  }, { baseUrl: fixture.environment.baseUrl });
  assert.deepEqual(response.input.waitFor, {
    type: "response",
    url: "http://127.0.0.1:3019/liutianci/api/generate",
    method: "POST",
  });
});

test("local Planora login example is executable using runtime env references only", async () => {
  const username = "planora-example-user-never-persist";
  const password = "planora-example-password-never-persist";
  const item = await serviceWithFake({ env: { EVAL_PLANORA_USERNAME: username, EVAL_PLANORA_PASSWORD: password } });
  try {
    const fixture = JSON.parse(await readFile(new URL("../fixtures/generic-login-planora-local.example.json", import.meta.url), "utf8"));
    assert.doesNotMatch(JSON.stringify(fixture), new RegExp(`${username}|${password}`));
    assert.deepEqual(fixture.setup.steps[1].valueFrom, { env: "EVAL_PLANORA_USERNAME" });
    assert.deepEqual(fixture.setup.steps[2].valueFrom, { env: "EVAL_PLANORA_PASSWORD" });
    assert.deepEqual(fixture.setup.steps[3].target, { role: "button", name: "登录", exact: true });
    const created = await item.service.controlPlane.create(fixture);
    const result = await item.service.controlPlane.run(created.id, item.service.manager);
    assert.equal(result.status, "passed");
    assert.equal(result.tracePolicy.playwrightTrace, "suppressed");
    const artifacts = await readFilesRecursively(item.root);
    assert.doesNotMatch(artifacts, new RegExp(`${username}|${password}`));
    assert.match(artifacts, /EVAL_PLANORA_USERNAME/);
    assert.match(artifacts, /EVAL_PLANORA_PASSWORD/);
    assert.equal((await readdir(item.root, { recursive: true })).some((file) => String(file).endsWith("trace.zip") || String(file).endsWith(".png")), false);
  } finally { await closeService(item); }
});

test("setup fixture rejects inline fill values before writing a test asset", async () => {
  const item = await serviceWithFake();
  try {
    await assert.rejects(
      item.service.controlPlane.create({
        title: "unsafe setup",
        setup: { steps: [{ operation: "act", action: "fill", target: { label: "Password" }, value: "must-not-be-written" }] },
      }),
      (error) => error?.code === "INLINE_SETUP_FILL_VALUE_FORBIDDEN",
    );
    await assert.rejects(readFile(path.join(item.root, "test-cases.json"), "utf8"), (error) => error?.code === "ENOENT");
  } finally { await closeService(item); }
});

test("runtime-backed setup refuses a caller-owned session whose trace may already be active", async () => {
  const item = await serviceWithFake({ env: { FIXTURE_USERNAME: "safe-in-memory-only" } });
  try {
    const session = await item.service.manager.createSession();
    const created = await item.service.controlPlane.create({
      title: "runtime setup",
      setup: { steps: [{ operation: "act", action: "fill", target: { label: "Username" }, valueFrom: { env: "FIXTURE_USERNAME" } }] },
    });
    const result = await item.service.controlPlane.run(created.id, item.service.manager, { sessionId: session.sessionId });
    assert.equal(result.status, "failed");
    assert.equal(result.errorCode, "SENSITIVE_SETUP_REQUIRES_OWN_SESSION");
    assert.equal(item.service.manager.get(session.sessionId).traceActive, true);
    await item.service.manager.close(session.sessionId);
  } finally { await closeService(item); }
});

test("operation budget rejects an expired deadline before calling the runner", async () => {
  const item = await serviceWithFake();
  try {
    const session = await item.service.manager.createSession();
    const result = await item.service.manager.navigate(session.sessionId, { url: "http://example.test/expired", deadlineAt: Date.now() - 1 });
    assert.equal(result.errorCode, "DEADLINE_EXCEEDED");
  } finally { await closeService(item); }
});

test("public callers cannot disable mandatory trace", async () => {
  const item = await serviceWithFake();
  try {
    await assert.rejects(
      item.service.manager.createSession({ trace: false }),
      (error) => error?.code === "TRACE_POLICY_FORBIDDEN",
    );
  } finally { await closeService(item); }
});

test("invalid target is a 422 structured runner error", async () => {
  const error = new BrowserRunnerError("INVALID_TARGET", "bad", { statusCode: 422, phase: "locate" });
  assert.deepEqual(error.toJSON(), { code: "INVALID_TARGET", message: "bad", phase: "locate", retryable: false, details: null });
});

test("URL evidence strips query data without corrupting about:blank", () => {
  assert.equal(sanitizeUrl("about:blank"), "about:blank");
  assert.equal(sanitizeUrl("https://example.test/path?token=secret#fragment"), "https://example.test/path");
});

test("core starts without an application-specific adapter", async () => {
  const item = await serviceWithFake();
  try {
    const spec = await fetch(`${item.baseUrl}/api/spec`).then((response) => response.json());
    assert.deepEqual(spec.integrations, []);
    assert.doesNotMatch(JSON.stringify(spec), /planora/i);
  } finally { await closeService(item); }
});
