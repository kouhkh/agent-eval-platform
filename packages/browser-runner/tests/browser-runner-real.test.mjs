import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { PlaywrightRunner } from "../lib/browser-runner.mjs";
import { EvidenceStore } from "../lib/evidence-store.mjs";
import { SessionManager } from "../lib/session-manager.mjs";

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
