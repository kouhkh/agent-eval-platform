import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { PlaywrightRunner } from "../lib/browser-runner.mjs";
import { EvidenceStore } from "../lib/evidence-store.mjs";
import { SessionManager } from "../lib/session-manager.mjs";
import { createBrowserService } from "../server.mjs";

test("delayed dialogs, postcondition listener lifetime, and long text assertions", { timeout: 30000 }, async () => {
  const item = await realManager();
  try {
    const created = await item.manager.createSession();
    const session = item.manager.get(created.sessionId);
    await session.page.setContent(`<button id="delayed" onclick="setTimeout(() => { document.querySelector('#state').textContent = confirm('Delayed fixture?') ? 'accepted' : 'dismissed'; }, 200)">Delayed</button><button id="noop">No dialog</button><p id="state">unset</p><main>${"prefix ".repeat(300)}MATCH_AT_END</main>`);
    const longText = await item.manager.assert(created.sessionId, { type: "text", target: { selector: "main" }, expected: "MATCH_AT_END" });
    assert.equal(longText.status, "succeeded");
    assert.ok(longText.data.actual.length <= 1000);
    for (const explicitExpectation of [false, true]) {
      const result = await item.manager.act(created.sessionId, {
        action: "click", target: { selector: "#delayed" }, approvedScope: "isolated regression fixture",
        dialogAction: explicitExpectation ? "dismiss" : "accept", dialogExpected: explicitExpectation,
        ...(explicitExpectation ? {} : { waitFor: { type: "text", target: { selector: "#state" }, expected: "accepted" } }),
      });
      assert.equal(result.status, "succeeded", JSON.stringify(result.error));
      assert.equal(result.data.interaction.dialog.handledAs, explicitExpectation ? "dismiss" : "accept");
      assert.equal(session.page.listenerCount("dialog"), 0);
    }
    const undeclared = await item.manager.act(created.sessionId, {
      action: "click", target: { selector: "#delayed" }, approvedScope: "isolated regression fixture", dialogExpected: true,
    });
    assert.equal(undeclared.errorCode, "DIALOG_REQUIRED");
    const trace = await item.manager.getTrace(created.sessionId);
    assert.equal(trace.status, "succeeded");
    assert.ok(trace.evidenceRefs.some((ref) => ref.endsWith("trace.zip")));
    const missing = await item.manager.act(created.sessionId, {
      action: "click", target: { selector: "#noop" }, approvedScope: "isolated regression fixture",
      dialogAction: "accept", dialogExpected: true, deadlineMs: 700, totalDeadlineAt: Date.now() + 300000,
    });
    assert.equal(missing.errorCode, "DEADLINE_EXCEEDED");
    assert.equal(item.manager.get(created.sessionId).state, "stale");
    assert.equal(session.page.listenerCount("dialog"), 0);
    const fresh = await item.manager.createSession();
    const freshSession = item.manager.get(fresh.sessionId);
    await freshSession.page.setContent('<button id="noop">No dialog</button>');
    const pending = item.manager.act(fresh.sessionId, {
      action: "click", target: { selector: "#noop" }, approvedScope: "isolated cancellation fixture",
      dialogExpected: true, dialogAction: "accept", deadlineMs: 5000,
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    await item.manager.cancel(fresh.sessionId);
    assert.equal((await pending).errorCode, "CANCELLED");
    assert.equal(freshSession.page.listenerCount("dialog"), 0);
  } finally {
    await item.manager.dispose();
    await item.runner.close();
    if (process.env.KEEP_RUNNER_EVIDENCE === "1") console.log(`Regression evidence: ${item.root}`);
    else await rm(item.root, { recursive: true, force: true });
  }
});

async function realManager() {
  const root = await mkdtemp(path.join(tmpdir(), "agent-eval-browser-real-"));
  const runner = new PlaywrightRunner({ headless: true, profileRoot: path.join(root, "profiles") });
  const manager = new SessionManager({
    runner,
    evidenceStore: new EvidenceStore({ root: path.join(root, "evidence") }),
    traceRoot: path.join(root, "traces"),
    heartbeatMs: 60_000,
  });
  return { root, runner, manager };
}

async function filesBelow(root) {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath || entry.path, entry.name));
}

test("act waits for one exact delayed HTTP response without persisting transport secrets", { timeout: 30_000 }, async () => {
  const sensitive = "response-wait-secret-never-persist";
  const http = createServer((request, response) => {
    if (request.url === "/") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end(`<!doctype html><button id="generate">Generate</button><script>
        document.querySelector('#generate').onclick = async () => {
          await fetch('/strategy');
          await fetch('/generate', { method: 'POST', headers: { 'x-fixture-secret': '${sensitive}' }, body: '${sensitive}' });
        };
      </script>`);
      return;
    }
    if (request.url === "/strategy") {
      setTimeout(() => { response.writeHead(200); response.end("strategy"); }, 40);
      return;
    }
    if (request.url === "/generate" && request.method === "POST") {
      request.resume();
      setTimeout(() => { response.writeHead(422, { "set-cookie": `fixture=${sensitive}` }); response.end(sensitive); }, 120);
      return;
    }
    if (request.url === "/slow" && request.method === "POST") {
      request.resume();
      setTimeout(() => { response.writeHead(200); response.end("late"); }, 2_000);
      return;
    }
    response.writeHead(404); response.end("missing");
  });
  await new Promise((resolve) => http.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${http.address().port}`;
  const item = await realManager();
  try {
    const created = await item.manager.createSession({ url: baseUrl });
    const page = item.manager.get(created.sessionId).page;
    const responseListenerCount = page.listenerCount("response");
    const result = await item.manager.act(created.sessionId, {
      action: "click",
      target: { selector: "#generate" },
      approvedScope: "isolated delayed-response fixture",
      waitFor: { type: "response", url: "/generate", method: "POST" },
      deadlineMs: 5_000,
    });
    assert.equal(result.status, "succeeded", JSON.stringify(result.error));
    assert.deepEqual(result.data.waitFor, { type: "response", url: `${baseUrl}/generate`, method: "POST", status: 422 });
    assert.equal(page.listenerCount("response"), responseListenerCount);

    const resultRef = result.evidenceRefs.find((ref) => ref.endsWith("result.json"));
    const resultPath = path.join(item.root, "evidence", ...resultRef.replace("evidence://", "").split("/"));
    const saved = JSON.parse(await readFile(resultPath, "utf8"));
    assert.deepEqual(saved.waitFor, { type: "response", url: `${baseUrl}/generate`, method: "POST", status: 422 });
    const networkRef = result.evidenceRefs.find((ref) => ref.endsWith("network.json"));
    const networkPath = path.join(item.root, "evidence", ...networkRef.replace("evidence://", "").split("/"));
    const network = JSON.parse(await readFile(networkPath, "utf8"));
    assert.ok(network.some((entry) => entry.method === "GET" && entry.url === `${baseUrl}/strategy` && entry.status === 200));
    assert.ok(network.some((entry) => entry.method === "POST" && entry.url === `${baseUrl}/generate` && entry.status === 422));
    for (const file of await filesBelow(path.join(item.root, "evidence"))) {
      assert.equal((await readFile(file)).includes(Buffer.from(sensitive)), false, file);
    }

    await page.setContent(`<button id="slow" onclick="fetch('${baseUrl}/slow', { method: 'POST' })">Slow</button>`);
    const startedAt = Date.now();
    const timedOut = await item.manager.act(created.sessionId, {
      action: "click",
      target: { selector: "#slow" },
      approvedScope: "isolated response deadline fixture",
      waitFor: { type: "response", url: `${baseUrl}/slow`, method: "POST" },
      deadlineMs: 700,
      evidenceTimeoutMs: 75,
    });
    assert.equal(timedOut.errorCode, "DEADLINE_EXCEEDED");
    assert.ok(Date.now() - startedAt < 2_000);
    assert.equal(page.listenerCount("response"), responseListenerCount);
    assert.equal(item.manager.get(created.sessionId).state, "stale");
  } finally {
    await item.manager.dispose();
    await item.runner.close();
    await new Promise((resolve) => http.close(resolve));
    await rm(item.root, { recursive: true, force: true });
  }
});

test("control-plane console keeps an unconfirmed run request error visible after refresh", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-eval-console-real-"));
  const runner = new PlaywrightRunner({ headless: true, profileRoot: path.join(root, "profiles") });
  const testCase = { id: "network-failure", title: "网络失败用例", assetState: "runnable", draftIssues: [], version: 1, steps: [], assertions: [], cleanup: { steps: [] }, runs: [] };
  const controlPlane = {
    list: async () => [testCase],
    get: async () => testCase,
    run: async () => { throw new Error("synthetic connection reset"); },
  };
  const service = createBrowserService({ runner, controlPlane, dataRoot: root, heartbeatMs: 60_000 });
  await new Promise((resolve) => service.server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${service.server.address().port}`;
  try {
    const created = await service.manager.createSession({ url: baseUrl });
    const page = service.manager.get(created.sessionId).page;
    await page.locator('[data-case-id="network-failure"]').click();
    await page.locator("#run").click();
    const error = page.locator("#run-request-error");
    await error.waitFor({ state: "visible" });
    assert.match(await error.textContent(), /执行请求状态未确认：synthetic connection reset/);
    assert.equal(await page.locator("#run").isEnabled(), true);
  } finally {
    await service.manager.dispose();
    await new Promise((resolve) => service.server.close(resolve));
    await runner.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a bounded before-screenshot failure prevents mutation and keeps the session inspectable", { timeout: 30_000 }, async () => {
  const item = await realManager();
  try {
    const created = await item.manager.createSession();
    const session = item.manager.get(created.sessionId);
    await session.page.setContent('<button id="mutate" onclick="window.mutations = (window.mutations || 0) + 1">Mutate</button>');
    const screenshot = session.page.screenshot.bind(session.page);
    session.page.screenshot = async (options) => {
      const error = new Error(`page.screenshot: Timeout ${options.timeout}ms exceeded`);
      error.name = "TimeoutError";
      throw error;
    };
    const startedAt = Date.now();
    const result = await item.manager.act(created.sessionId, {
      action: "click", target: { selector: "#mutate" }, approvedScope: "isolated evidence timeout fixture",
      deadlineMs: 60_000, evidenceTimeoutMs: 75,
    });
    assert.equal(result.errorCode, "EVIDENCE_CAPTURE_TIMEOUT");
    assert.equal(result.phase, "evidence");
    assert.equal(await session.page.evaluate(() => window.mutations || 0), 0);
    assert.equal(item.manager.get(created.sessionId).state, "ready");
    assert.ok(Date.now() - startedAt < 2_000);
    session.page.screenshot = screenshot;
    const inspected = await item.manager.inspect(created.sessionId, { deadlineMs: 5_000 });
    assert.equal(inspected.status, "succeeded");
  } finally {
    await item.manager.dispose();
    await item.runner.close();
    await rm(item.root, { recursive: true, force: true });
  }
});

test("inspect targets round-trip for multi-span controls without treating text as accessible name", { timeout: 30_000 }, async () => {
  const item = await realManager();
  try {
    const created = await item.manager.createSession();
    const session = item.manager.get(created.sessionId);
    await session.page.setContent('<button><span>2.1</span><span>工程名称</span></button><button aria-label="Explicit action"><span>ignored text</span></button>');
    const inspected = await item.manager.inspect(created.sessionId, { deadlineMs: 5_000 });
    const multiSpan = inspected.data.elements.find((element) => element.textContent === "2.1工程名称");
    assert.equal(multiSpan.labelSource, "textContent");
    assert.equal(multiSpan.labelIsLocator, false);
    assert.equal(multiSpan.accessibleName, null);
    assert.equal(multiSpan.accessibleNameStatus, "not-computed");
    assert.equal(multiSpan.recommendedTarget.stability, "ephemeral");
    const clicked = await item.manager.act(created.sessionId, {
      action: "click", target: multiSpan.recommendedTarget.target, approvedScope: "isolated multi-span locator fixture",
    });
    assert.equal(clicked.status, "succeeded");
    assert.equal(clicked.data.interaction.locator.matchCount, 1);
    assert.equal(clicked.data.interaction.locator.semantics, "selector");
    const explicit = inspected.data.elements.find((element) => element.ariaLabel === "Explicit action");
    assert.deepEqual(explicit.recommendedTarget, {
      target: { label: "Explicit action", exact: true }, stability: "explicit", semantics: "aria-label",
    });
  } finally {
    await item.manager.dispose();
    await item.runner.close();
    await rm(item.root, { recursive: true, force: true });
  }
});

test("locator timeout preserves match count, retry reason, and before evidence", { timeout: 30_000 }, async () => {
  const item = await realManager();
  try {
    const created = await item.manager.createSession();
    await item.manager.get(created.sessionId).page.setContent('<button aria-label="2.1 工程名称"><span>2.1</span><span>工程名称</span></button>');
    const result = await item.manager.act(created.sessionId, {
      action: "click", target: { role: "button", name: "2.1工程名称", exact: true },
      approvedScope: "isolated locator diagnostic fixture", deadlineMs: 3_000, evidenceTimeoutMs: 200,
    });
    assert.equal(result.errorCode, "BROWSER_OPERATION_FAILED");
    assert.equal(item.manager.get(created.sessionId).state, "ready");
    assert.ok(result.evidenceRefs.some((ref) => ref.endsWith("result.json")));
    const resultRef = result.evidenceRefs.find((ref) => ref.endsWith("result.json"));
    const resultPath = path.join(item.root, "evidence", ...resultRef.replace("evidence://", "").split("/"));
    const saved = JSON.parse(await readFile(resultPath, "utf8"));
    assert.equal(saved.interaction.locator.semantics, "role-accessible-name");
    assert.equal(saved.interaction.locator.matchCount, 0);
    assert.match(saved.interaction.locator.lastError, /getByRole|waiting|Timeout/i);
    assert.equal(saved.screenshots[0].phase, "before");
  } finally {
    await item.manager.dispose();
    await item.runner.close();
    await rm(item.root, { recursive: true, force: true });
  }
});

test("real Playwright runner enforces approval, dialog intent, bounded inspection, uploads, and evidence", { timeout: 30_000 }, async () => {
  const item = await realManager();
  try {
    const created = await item.manager.createSession();
    const session = item.manager.get(created.sessionId);
    await session.page.setContent(`<!doctype html>
      <title>runner contract</title>
      <button id="confirm" onclick="window.confirmed = confirm('Apply fixture change?'); document.querySelector('#state').textContent = String(window.confirmed)">Apply</button>
      <button id="replace" onclick="this.outerHTML = '<span id=&quot;next-view&quot;>next</span>'">Replace view</button>
      <span id="state">unset</span>
      <input id="upload" type="file">
      <main>${"visible-contract-text ".repeat(700)}</main>`);

    const inspected = await item.manager.inspect(created.sessionId, { label: "Inspect fixture" });
    assert.equal(inspected.status, "succeeded");
    assert.equal(inspected.data.visibleText.length, 8000);
    assert.equal(inspected.data.visibleTextTruncated, true);
    assert.ok(inspected.data.screenshots.every((shot) => !("buffer" in shot)));
    assert.ok(inspected.evidenceRefs.some((ref) => ref.endsWith(".png")));

    const denied = await item.manager.act(created.sessionId, { action: "click", target: { selector: "#confirm" } });
    assert.equal(denied.errorCode, "AUTHORIZATION_REQUIRED");

    const undeclaredDialog = await item.manager.act(created.sessionId, {
      action: "click",
      target: { selector: "#confirm" },
      approvedScope: "modify isolated fixture only",
    });
    assert.equal(undeclaredDialog.errorCode, "DIALOG_REQUIRED");
    assert.equal(await session.page.locator("#state").textContent(), "false");
    assert.ok(undeclaredDialog.evidenceRefs.some((ref) => ref.endsWith(".png")));

    const acceptedDialog = await item.manager.act(created.sessionId, {
      action: "click",
      target: { selector: "#confirm" },
      approvedScope: "modify isolated fixture only",
      dialogAction: "accept",
    });
    assert.equal(acceptedDialog.status, "succeeded");
    assert.equal(acceptedDialog.data.interaction.dialog.handledAs, "accept");
    assert.equal(await session.page.locator("#state").textContent(), "true");

    const replacedView = await item.manager.act(created.sessionId, {
      action: "click",
      target: { selector: "#replace" },
      approvedScope: "switch isolated fixture view only",
      deadlineMs: 5_000,
    });
    assert.equal(replacedView.status, "succeeded");
    assert.equal(await session.page.locator("#next-view").textContent(), "next");
    assert.equal(replacedView.data.screenshots.at(-1)?.found, false);
    assert.match(replacedView.data.screenshots.at(-1)?.targetError || "", /#replace|waiting|timeout/i);

    const relativeUpload = await item.manager.act(created.sessionId, {
      action: "upload",
      target: { selector: "#upload" },
      file: "fixture.txt",
      approvedScope: "attach isolated fixture only",
    });
    assert.equal(relativeUpload.errorCode, "UPLOAD_FILE_MUST_BE_ABSOLUTE");

    const uploadPath = path.join(item.root, "fixture.txt");
    await writeFile(uploadPath, "fixture", { mode: 0o600 });
    const uploaded = await item.manager.act(created.sessionId, {
      action: "upload",
      target: { selector: "#upload" },
      file: uploadPath,
      approvedScope: "attach isolated fixture only",
    });
    assert.equal(uploaded.status, "succeeded");
    assert.deepEqual(uploaded.data.interaction.files, [{ name: "fixture.txt", size: 7 }]);

    const trace = await item.manager.getTrace(created.sessionId);
    assert.equal(trace.status, "succeeded");
    assert.ok(trace.evidenceRefs.some((ref) => ref.endsWith("trace.zip")));

    const evidenceFiles = await filesBelow(path.join(item.root, "evidence"));
    assert.ok(evidenceFiles.some((file) => file.endsWith(".png")));
    assert.ok(evidenceFiles.some((file) => file.endsWith("trace.zip")));
    const screenshotMetadata = evidenceFiles.find((file) => file.endsWith("screenshots.json"));
    assert.ok(screenshotMetadata && existsSync(screenshotMetadata));
    assert.doesNotMatch(await readFile(screenshotMetadata, "utf8"), /"buffer"/);
  } finally {
    await item.manager.dispose();
    await item.runner.close();
    await rm(item.root, { recursive: true, force: true });
  }
});

test("persistent session reconnects when baseURL and locale are unset", { timeout: 30_000 }, async () => {
  const item = await realManager();
  try {
    const profileDir = path.join(item.root, "profiles", "reconnect-without-base-url");
    const created = await item.manager.createSession({ profileDir });
    const oldTabId = created.tabId;

    const reconnected = await item.manager.reconnect(created.sessionId);

    assert.equal(reconnected.state, "ready");
    assert.notEqual(reconnected.tabId, oldTabId);
    assert.equal(item.manager.get(created.sessionId).baseURL, null);
    assert.equal(item.manager.get(created.sessionId).locale, null);
    assert.equal(reconnected.reconnectCount, 1);
  } finally {
    await item.manager.dispose();
    await item.runner.close();
    await rm(item.root, { recursive: true, force: true });
  }
});
