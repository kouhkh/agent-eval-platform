import assert from "node:assert/strict";
import { test } from "node:test";
import { createOperationBudget } from "../lib/operation-budget.mjs";

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
