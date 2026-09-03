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

test("top-level steps interleave act, relative navigate, and assert while preserving ordered evidence", async () => {
  const item = await serviceWithFake();
  try {
    const created = await item.service.controlPlane.create({
      title: "save refresh assert restore",
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
      steps: [{ action: "click", target: { role: "button", name: "Legacy save" } }],
    });
    assert.equal(created.steps[0].operation, "act");
    const result = await item.service.controlPlane.run(created.id, item.service.manager, { closeAfterRun: false });
    assert.equal(result.status, "passed");
    assert.deepEqual(item.runner.calls.filter((call) => call.operation !== "createContext").map((call) => call.operation), ["act"]);
    await item.service.manager.close(result.sessionId);
  } finally { await closeService(item); }
});

test("top-level fill keeps an explicit non-secret value", async () => {
  const item = await serviceWithFake();
  try {
    const created = await item.service.controlPlane.create({
      title: "ordinary editable field",
      steps: [{ operation: "act", action: "fill", target: { label: "Display name" }, value: "temporary test name" }],
    });
    const result = await item.service.controlPlane.run(created.id, item.service.manager, { closeAfterRun: false });
    assert.equal(result.status, "passed");
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
    const publicRun = JSON.stringify(result);
    for (const sensitive of [username, password]) {
      assert.doesNotMatch(persisted, new RegExp(sensitive));
      assert.doesNotMatch(evidence, new RegExp(sensitive));
      assert.doesNotMatch(publicRun, new RegExp(sensitive));
    }
    assert.match(persisted, /FIXTURE_USERNAME/);
    assert.match(persisted, /qa\/login\/password/);
    await item.service.manager.close(result.sessionId);
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
