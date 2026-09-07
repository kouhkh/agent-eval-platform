import assert from "node:assert/strict";
import { test } from "node:test";
import { createOperationBudget } from "../lib/operation-budget.mjs";
import { evidenceTimeout, PlaywrightRunner } from "../lib/browser-runner.mjs";

test("absolute and total deadlines never extend a step deadline", async () => {
  const start = Date.now();
  const budget = createOperationBudget({ deadlineMs: 30, deadlineAt: start + 300000, totalBudgetMs: 300000 });
  assert.ok(budget.deadlineAt <= start + 35);
  await assert.rejects(budget.run(() => new Promise(() => {})), { code: "DEADLINE_EXCEEDED" });
});

test("earliest total/absolute/relative limit wins and null means unspecified", () => {
  const now = Date.now();
  assert.equal(createOperationBudget({ deadlineMs: 12000, totalDeadlineAt: now + 10 }).deadlineAt, now + 10);
  assert.equal(createOperationBudget({ deadlineMs: 12000, deadlineAt: now - 1 }).remainingMs(), 0);
  assert.ok(createOperationBudget({ deadlineAt: null, totalDeadlineAt: null, totalBudgetMs: null }).remainingMs() > 29000);
  assert.ok(createOperationBudget({ totalDeadlineAt: now + 300000, totalBudgetMs: 10 }).remainingMs() <= 10);
});

test("pixel evidence has an independent bounded timeout", () => {
  const budget = createOperationBudget({ deadlineMs: 60_000 });
  assert.ok(evidenceTimeout({}, budget).timeoutMs <= 5_000);
  assert.ok(evidenceTimeout({ evidenceTimeoutMs: 60_000 }, budget).timeoutMs <= 15_000);
  assert.ok(evidenceTimeout({ evidenceTimeoutMs: 123 }, budget).timeoutMs <= 123);
});

test("pixel timeout reports evidence failure without consuming the operation budget", async () => {
  const runner = new PlaywrightRunner();
  const budget = createOperationBudget({ deadlineMs: 60_000 });
  let screenshotTimeout = null;
  const page = {
    locator: () => ({ evaluate: async () => {} }),
    screenshot: async (options) => {
      screenshotTimeout = options.timeout;
      const error = new Error(`page.screenshot: Timeout ${options.timeout}ms exceeded`);
      error.name = "TimeoutError";
      throw error;
    },
    evaluate: async () => {},
    url: () => "http://example.test/heavy",
  };
  await assert.rejects(
    runner.captureAnnotatedScreenshot(page, { kind: "act", evidenceTimeoutMs: 75 }, "before", budget),
    (error) => error.code === "EVIDENCE_CAPTURE_TIMEOUT"
      && error.phase === "evidence"
      && error.details.evidencePhase === "before",
  );
  assert.ok(screenshotTimeout <= 75);
  assert.ok(budget.remainingMs() > 59_000);
});

test("operation budget exposes a bounded drain after cancellation", async () => {
  const budget = createOperationBudget({ deadlineMs: 20 });
  const result = budget.run(() => new Promise(() => {}));
  await assert.rejects(result, { code: "DEADLINE_EXCEEDED" });
  const startedAt = Date.now();
  assert.equal(await budget.drain(30), false);
  assert.ok(Date.now() - startedAt < 100);
});

test("deadline errors identify the last operation phase and prior phase timings", async () => {
  const budget = createOperationBudget({ deadlineMs: 20 });
  budget.setPhase("before-evidence");
  budget.setPhase("perform");
  await assert.rejects(
    budget.run(() => new Promise(() => {})),
    (error) => error.code === "DEADLINE_EXCEEDED"
      && error.details.operationPhase.current === "perform"
      && error.details.operationPhase.phases.some((item) => item.phase === "before-evidence"),
  );
});
