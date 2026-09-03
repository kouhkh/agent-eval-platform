import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { BrowserRunnerError, asBrowserRunnerError } from "./operation-budget.mjs";
import { sanitizeUrl } from "./evidence-store.mjs";

async function loadPlaywright() {
  try {
    return await import("playwright");
  } catch (error) {
    throw new BrowserRunnerError(
      "PLAYWRIGHT_UNAVAILABLE",
      "未安装 Playwright。请在 browser-runner 包目录执行 npm install，并按需安装浏览器内核。",
      { statusCode: 503, phase: "launch", details: { cause: error instanceof Error ? error.message : String(error) } },
    );
  }
}

function trimText(value, max = 180) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
}

function safeTimeout(budget) {
  return Math.max(1, Math.floor(budget.remainingMs()));
}

function isHttpUrl(value) {
  return value === "about:blank" || /^https?:\/\//i.test(String(value || ""));
}

function locatorFor(page, target) {
  if (typeof target === "string") {
    if (/^(css=|xpath=|[.#\[])/i.test(target)) return page.locator(target);
    return page.getByText(target, { exact: true });
  }
  if (!target || typeof target !== "object") throw new BrowserRunnerError("INVALID_TARGET", "操作缺少有效 UI 元素定位信息。", { statusCode: 422, phase: "locate" });
  if (target.testId) return page.getByTestId(String(target.testId));
  if (target.role) {
    const options = {};
    if (target.name != null) options.name = String(target.name);
    if (target.exact != null) options.exact = Boolean(target.exact);
    return page.getByRole(String(target.role), options);
  }
  if (target.label) return page.getByLabel(String(target.label), { exact: target.exact !== false });
  if (target.placeholder) return page.getByPlaceholder(String(target.placeholder), { exact: target.exact !== false });
  if (target.text) return page.getByText(String(target.text), { exact: target.exact !== false });
  if (target.selector) return page.locator(String(target.selector));
  throw new BrowserRunnerError("INVALID_TARGET", "UI 元素没有 selector、role、label、text 或 testId。", { statusCode: 422, phase: "locate" });
}

function normalizeUrlPattern(expected) {
  const pattern = String(expected || "");
  if (pattern.startsWith("/")) return new RegExp(pattern.slice(1, pattern.lastIndexOf("/")) || "^$");
  return pattern;
}

async function waitForCondition(page, condition, budget) {
  if (!condition) return null;
  const type = String(condition.type || "");
  if (type === "load") {
    await budget.run(() => page.waitForLoadState(String(condition.state || "domcontentloaded"), { timeout: safeTimeout(budget) }));
    return { type, state: condition.state || "domcontentloaded" };
  }
  if (type === "url") {
    const expected = normalizeUrlPattern(condition.expected);
    await budget.run(() => page.waitForURL(expected, { timeout: safeTimeout(budget), waitUntil: "domcontentloaded" }));
    return { type, expected: String(condition.expected || "") };
  }
  const locator = locatorFor(page, condition.target);
  if (type === "visible" || type === "hidden" || type === "attached" || type === "detached") {
    const state = type === "visible" ? "visible" : type === "hidden" ? "hidden" : type;
    await budget.run(() => locator.waitFor({ state, timeout: safeTimeout(budget) }));
    return { type, target: condition.target };
  }
  if (type === "text") {
    const expected = String(condition.expected ?? "");
    await budget.run(async () => {
      while (true) {
        const actual = String(await locator.textContent({ timeout: safeTimeout(budget) }) || "");
        if (actual.includes(expected)) return;
        if (budget.remainingMs() <= 0) throw new BrowserRunnerError("DEADLINE_EXCEEDED", "等待文本条件超过截止时间。", { statusCode: 504, phase: "wait" });
        await new Promise((resolve) => setTimeout(resolve, Math.min(50, budget.remainingMs())));
      }
    });
    return { type, target: condition.target, expected };
  }
  throw new BrowserRunnerError("INVALID_WAIT_CONDITION", `不支持的等待条件：${type || "未填写"}。`, { statusCode: 422, phase: "wait" });
}

export class PlaywrightRunner {
  constructor(options = {}) {
    this.headless = options.headless !== false;
    this.browserName = options.browserName || "chromium";
    this.executablePath = options.executablePath || undefined;
    this.browserArgs = Array.isArray(options.browserArgs) ? options.browserArgs : [];
    this.profileRoot = path.resolve(options.profileRoot || path.join(process.cwd(), "data", "profiles"));
    this.browser = null;
    this.playwright = null;
    this.contexts = new Set();
    this.pages = new Set();
    this.disconnected = false;
    this.onDisconnected = options.onDisconnected || (() => {});
    this.loaded = false;
  }

  async launch() {
    if (this.browser?.isConnected?.()) return this.browser;
    this.playwright = this.playwright || await loadPlaywright();
    const type = this.playwright[this.browserName];
    if (!type?.launch) throw new BrowserRunnerError("UNSUPPORTED_BROWSER", `不支持的浏览器类型：${this.browserName}。`, { statusCode: 422, phase: "launch" });
    this.browser = await type.launch({ headless: this.headless, executablePath: this.executablePath, args: this.browserArgs });
    this.disconnected = false;
    this.loaded = true;
    this.browser.on("disconnected", () => {
      this.disconnected = true;
      this.onDisconnected();
    });
    return this.browser;
  }

  isAlive() {
    if (this.browser?.isConnected?.()) return true;
    return !this.disconnected && [...this.contexts].some((context) => !context.isClosed?.());
  }

  async health() {
    const browserConnected = Boolean(this.browser?.isConnected?.());
    return {
      ready: browserConnected || this.isAlive(),
      provider: "playwright",
      browserName: this.browserName,
      browserConnected,
      contextCount: this.contexts.size,
      pageCount: this.pages.size,
      playwrightLoaded: this.loaded,
    };
  }

  async createContext(options = {}) {
    let context;
    if (options.profileDir) {
      const profileDir = path.resolve(options.profileDir);
      if (!(profileDir === this.profileRoot || profileDir.startsWith(`${this.profileRoot}${path.sep}`))) {
        throw new BrowserRunnerError("PROFILE_OUTSIDE_ROOT", "专用浏览器 profile 必须位于配置的 profileRoot 内。", { statusCode: 403, phase: "launch" });
      }
      await mkdir(profileDir, { recursive: true, mode: 0o700 });
      this.playwright = this.playwright || await loadPlaywright();
      const type = this.playwright[this.browserName];
      context = await type.launchPersistentContext(profileDir, {
        headless: this.headless,
        executablePath: this.executablePath,
        args: this.browserArgs,
        baseURL: options.baseURL,
      });
    } else {
      const browser = await this.launch();
      context = await browser.newContext({ baseURL: options.baseURL, locale: options.locale });
    }
    this.contexts.add(context);
    context.on?.("close", () => this.contexts.delete(context));
    return context;
  }

  async newPage(context) {
    const page = await context.newPage();
    this.pages.add(page);
    this.installNetworkCapture(page);
    page.on?.("close", () => this.pages.delete(page));
    return page;
  }

  installNetworkCapture(page) {
    if (page.__agentEvalNetworkCaptureInstalled) return;
    page.__agentEvalNetworkCaptureInstalled = true;
    page.__agentEvalNetworkEvents = [];
    const add = (event) => {
      page.__agentEvalNetworkEvents.push(event);
      if (page.__agentEvalNetworkEvents.length > 500) page.__agentEvalNetworkEvents.splice(0, page.__agentEvalNetworkEvents.length - 500);
    };
    page.on?.("request", (request) => add({ kind: "request", method: request.method(), url: sanitizeUrl(request.url()), resourceType: request.resourceType() }));
    page.on?.("response", (response) => {
      const headers = response.headers?.() || {};
      const parsedBytes = Number(headers["content-length"] || headers["Content-Length"] || 0);
      add({ kind: "response", method: response.request().method(), url: sanitizeUrl(response.url()), resourceType: response.request().resourceType(), status: response.status(), bytes: Number.isFinite(parsedBytes) && parsedBytes > 0 ? parsedBytes : null });
    });
    page.on?.("requestfailed", (request) => add({ kind: "requestfailed", method: request.method(), url: sanitizeUrl(request.url()), resourceType: request.resourceType(), failed: true }));
  }

  networkSince(page, cursor = 0) {
    return { cursor: page.__agentEvalNetworkEvents?.length || 0, events: (page.__agentEvalNetworkEvents || []).slice(Math.max(0, Number(cursor) || 0)) };
  }

  async startTrace(context) {
    try {
      await context.tracing.start({ screenshots: true, snapshots: true, sources: false });
      return true;
    } catch (error) {
      throw asBrowserRunnerError(error, { phase: "trace", statusCode: 502 });
    }
  }

  async stopTrace(context, tracePath) {
    try {
      await context.tracing.stop({ path: tracePath });
      return tracePath;
    } catch (error) {
      throw asBrowserRunnerError(error, { phase: "trace", statusCode: 502 });
    }
  }

  async closeContext(context) {
    if (!context) return;
    await context.close();
    this.contexts.delete(context);
  }

  async close() {
    for (const context of [...this.contexts]) await context.close().catch(() => {});
    this.contexts.clear();
    if (this.browser) await this.browser.close().catch(() => {});
    this.browser = null;
    this.disconnected = false;
  }

  async cancelPage(page) {
    try {
      await page.evaluate(() => { try { window.stop(); } catch {} });
    } catch {}
  }

  async navigate(page, input, budget) {
    const url = String(input.url || "");
    if (!isHttpUrl(url)) throw new BrowserRunnerError("INVALID_URL", "只允许 http(s) 或 about:blank 地址。", { statusCode: 422, phase: "navigate" });
    const waitUntil = ["load", "domcontentloaded", "networkidle", "commit"].includes(input.waitUntil) ? input.waitUntil : "domcontentloaded";
    await budget.run(() => page.goto(url, { waitUntil, timeout: safeTimeout(budget) }), { onCancel: () => this.cancelPage(page) });
    return { url: sanitizeUrl(page.url()), waitUntil };
  }

  async inspect(page, input, budget) {
    const limit = Math.max(1, Math.min(300, Number(input.limit) || 120));
    const elements = await budget.run(() => page.evaluate((max) => {
      const nodes = [...document.querySelectorAll("a,button,input,select,textarea,[role],[data-testid]")];
      return nodes.slice(0, max).map((element, index) => {
        const rect = element.getBoundingClientRect();
        const type = element.getAttribute("type") || element.tagName.toLowerCase();
        const label = element.getAttribute("aria-label") || element.getAttribute("name") || element.textContent || "";
        const isSensitive = /password|token|secret|authorization/i.test(`${type} ${element.getAttribute("name") || ""} ${element.getAttribute("id") || ""}`);
        return {
          index,
          tag: element.tagName.toLowerCase(),
          role: element.getAttribute("role") || null,
          id: element.id || null,
          testId: element.getAttribute("data-testid") || null,
          label: isSensitive ? "<redacted:sensitive>" : String(label).replace(/\s+/g, " ").trim().slice(0, 180),
          inputType: type,
          visible: rect.width > 0 && rect.height > 0,
          disabled: Boolean(element.disabled || element.getAttribute("aria-disabled") === "true"),
          bounds: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
        };
      });
    }, limit), { onCancel: () => this.cancelPage(page) });
    const domSnapshot = {
      url: sanitizeUrl(page.url()),
      title: trimText(await budget.run(() => page.title(), { onCancel: () => this.cancelPage(page) }), 300),
      elements,
    };
    const output = { ...domSnapshot, domSnapshot, network: this.networkSince(page, input.networkCursor).events };
    if (input.screenshot === true) output.screenshotBuffer = await budget.run(() => page.screenshot({ type: "png" }), { onCancel: () => this.cancelPage(page) });
    return output;
  }

  async act(page, input, budget) {
    const action = String(input.action || "click");
    const target = input.target;
    if (action === "scroll") {
      if (target) {
        const locator = locatorFor(page, target);
        await budget.run(() => locator.scrollIntoViewIfNeeded({ timeout: safeTimeout(budget) }), { onCancel: () => this.cancelPage(page) });
      } else {
        const deltaY = Number(input.deltaY || input.amount || 600);
        await budget.run(() => page.mouse.wheel(0, deltaY), { onCancel: () => this.cancelPage(page) });
      }
    } else {
      const locator = locatorFor(page, target);
      if (action === "click") await budget.run(() => locator.click({ timeout: safeTimeout(budget) }), { onCancel: () => this.cancelPage(page) });
      else if (action === "dblclick") await budget.run(() => locator.dblclick({ timeout: safeTimeout(budget) }), { onCancel: () => this.cancelPage(page) });
      else if (action === "fill") await budget.run(() => locator.fill(String(input.value ?? ""), { timeout: safeTimeout(budget) }), { onCancel: () => this.cancelPage(page) });
      else if (action === "select") await budget.run(() => locator.selectOption(input.value, { timeout: safeTimeout(budget) }), { onCancel: () => this.cancelPage(page) });
      else if (action === "check") await budget.run(() => locator.check({ timeout: safeTimeout(budget) }), { onCancel: () => this.cancelPage(page) });
      else if (action === "uncheck") await budget.run(() => locator.uncheck({ timeout: safeTimeout(budget) }), { onCancel: () => this.cancelPage(page) });
      else if (action === "hover") await budget.run(() => locator.hover({ timeout: safeTimeout(budget) }), { onCancel: () => this.cancelPage(page) });
      else if (action === "press") await budget.run(() => locator.press(String(input.value || "Enter"), { timeout: safeTimeout(budget) }), { onCancel: () => this.cancelPage(page) });
      else throw new BrowserRunnerError("UNSUPPORTED_ACTION", `不支持的浏览器动作：${action}。`, { statusCode: 422, phase: "act" });
    }
    const waited = await waitForCondition(page, input.waitFor, budget);
    return { action, target: target || null, url: sanitizeUrl(page.url()), waitFor: waited };
  }

  async assert(page, input, budget) {
    const type = String(input.type || input.assertion || "visible");
    const expected = input.expected;
    if (type === "url") {
      const actual = page.url();
      const pass = typeof expected === "string" && (expected.startsWith("/") ? new RegExp(expected.slice(1, expected.lastIndexOf("/"))).test(actual) : actual === expected || sanitizeUrl(actual) === sanitizeUrl(expected));
      if (!pass) throw new BrowserRunnerError("ASSERTION_FAILED", `URL 断言失败：实际为 ${sanitizeUrl(actual)}。`, { statusCode: 422, phase: "assert", details: { type, expected, actual: sanitizeUrl(actual) } });
      return { type, expected, actual: sanitizeUrl(actual), passed: true };
    }
    if (type === "title") {
      const actual = await budget.run(() => page.title(), { onCancel: () => this.cancelPage(page) });
      const pass = String(actual).includes(String(expected ?? ""));
      if (!pass) throw new BrowserRunnerError("ASSERTION_FAILED", `页面标题断言失败：实际为 ${trimText(actual)}。`, { statusCode: 422, phase: "assert", details: { type, expected, actual } });
      return { type, expected, actual, passed: true };
    }
    const locator = locatorFor(page, input.target);
    let actual;
    let pass;
    if (type === "visible") { await budget.run(() => locator.waitFor({ state: "visible", timeout: safeTimeout(budget) }), { onCancel: () => this.cancelPage(page) }); actual = true; pass = true; }
    else if (type === "hidden") { await budget.run(() => locator.waitFor({ state: "hidden", timeout: safeTimeout(budget) }), { onCancel: () => this.cancelPage(page) }); actual = true; pass = true; }
    else if (type === "text") {
      const expectedText = String(expected ?? "");
      await waitForCondition(page, { type: "text", target: input.target, expected: expectedText }, budget);
      actual = trimText(await budget.run(() => locator.textContent(), { onCancel: () => this.cancelPage(page) }), 1000);
      pass = actual.includes(expectedText);
    }
    else if (type === "value") { actual = await budget.run(() => locator.inputValue(), { onCancel: () => this.cancelPage(page) }); pass = actual === String(expected ?? ""); }
    else if (type === "count") { actual = await budget.run(() => locator.count(), { onCancel: () => this.cancelPage(page) }); pass = actual === Number(expected); }
    else throw new BrowserRunnerError("UNSUPPORTED_ASSERTION", `不支持的断言类型：${type}。`, { statusCode: 422, phase: "assert" });
    if (!pass) throw new BrowserRunnerError("ASSERTION_FAILED", `断言失败：${type}。`, { statusCode: 422, phase: "assert", details: { type, expected, actual } });
    return { type, target: input.target, expected, actual, passed: true };
  }
}

export { locatorFor, waitForCondition };
