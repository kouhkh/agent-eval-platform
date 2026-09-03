import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createBrowserService } from "../server.mjs";
import { EvidenceStore } from "../lib/evidence-store.mjs";
import { BrowserRunnerError } from "../lib/operation-budget.mjs";

class FakePage {
  constructor() { this.currentUrl = "about:blank"; this.closed = false; this.cancelled = false; }
  isClosed() { return this.closed; }
  url() { return this.currentUrl; }
  async close() { this.closed = true; }
}

class FakeRunner {
  constructor() { this.alive = true; this.contexts = new Set(); this.disconnectHandler = null; this.cancelCount = 0; }
  set onDisconnected(value) { this.disconnectHandler = value; }
  async health() { return { ready: this.alive && [...this.contexts].some((item) => !item.closed), provider: "fake", browserConnected: this.alive }; }
  async createContext() { const context = { closed: false, traceStarted: false }; this.contexts.add(context); return context; }
  async newPage() { return new FakePage(); }
  async startTrace(context) { context.traceStarted = true; }
  async stopTrace(_context, tracePath) { await writeFile(tracePath, "fake trace"); }
  async closeContext(context) { context.closed = true; this.contexts.delete(context); }
  async close() { this.alive = false; for (const context of this.contexts) context.closed = true; this.contexts.clear(); }
  async cancelPage(page) { page.cancelled = true; this.cancelCount += 1; }
  async navigate(page, input, budget) {
    const delay = Number(input.delayMs || 0);
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    budget.throwIfExpired();
    page.currentUrl = input.url;
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
  async act(page, input) { if (input.action === "navigate") page.currentUrl = input.value; return { action: input.action, target: input.target || null }; }
  async assert() { return { type: "visible", passed: true }; }
}

async function serviceWithFake() {
  const root = await mkdtemp(path.join(tmpdir(), "agent-eval-browser-test-"));
  const runner = new FakeRunner();
  const service = createBrowserService({ runner, dataRoot: root, evidenceStore: new EvidenceStore({ root: path.join(root, "evidence") }), heartbeatMs: 10 });
  await new Promise((resolve) => service.server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${service.server.address().port}`;
  return { root, runner, service, baseUrl };
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

    const running = item.service.manager.navigate(session.sessionId, { url: "http://example.test/cancel", delayMs: 500, deadlineMs: 1000 });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const operationId = item.service.manager.get(session.sessionId).operation.operationId;
    const cancel = await item.service.manager.cancel(session.sessionId, operationId);
    assert.equal(cancel.status, "cancelling");
    const cancelled = await running;
    assert.equal(cancelled.errorCode, "CANCELLED");
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
    const created = await item.service.controlPlane.create({ title: "登录页 smoke", project: "sample-app", startUrl: "http://example.test/login", steps: [{ action: "click", target: { role: "button", name: "登录" } }], assertions: [{ type: "visible", target: { testId: "home" } }], policy: { gate: true } });
    assert.equal(created.version, 1);
    const result = await item.service.controlPlane.run(created.id, item.service.manager, { closeAfterRun: false });
    assert.equal(result.status, "passed");
    assert.ok(result.sessionId);
    const loaded = await item.service.controlPlane.get(created.id);
    assert.equal(loaded.runs.length, 1);
    await item.service.manager.close(result.sessionId);
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

test("invalid target is a 422 structured runner error", async () => {
  const error = new BrowserRunnerError("INVALID_TARGET", "bad", { statusCode: 422, phase: "locate" });
  assert.deepEqual(error.toJSON(), { code: "INVALID_TARGET", message: "bad", phase: "locate", retryable: false, details: null });
});

test("core starts without an application-specific adapter", async () => {
  const item = await serviceWithFake();
  try {
    const spec = await fetch(`${item.baseUrl}/api/spec`).then((response) => response.json());
    assert.deepEqual(spec.integrations, []);
    assert.doesNotMatch(JSON.stringify(spec), /planora/i);
  } finally { await closeService(item); }
});
