# Runner correctness fixes — 2026-09-04

## Verified facts

| Issue | Evidence | Change |
| --- | --- | --- |
| Absolute deadline replaced the per-operation limit | `lib/operation-budget.mjs:createOperationBudget`, introduced in `ae7df29` | Use the earliest step, absolute and total limits; null means unspecified. |
| Control plane sent the run deadline as a step deadline | `lib/test-control-plane.mjs:run`, `lib/session-manager.mjs:execute` | Forward an anchored `totalDeadlineAt`; do not reset the run budget each step. |
| Dialog listener ended before postcondition waiting | `lib/browser-runner.mjs:runWithDialogPolicy/act`, introduced in consolidation `dd17d02` | Keep listener through `waitFor`; optionally require a dialog before completing. |
| Text assertion matched a truncated display value | `lib/browser-runner.mjs:assert`, introduced in consolidation `dd17d02` | Match full text; keep returned `actual` capped at 1000 characters. |

## Calling contract

For a click whose asynchronous handler must show a native dialog:

```json
{
  "action": "click",
  "target": { "testId": "apply" },
  "approvedScope": "modify isolated test fixture",
  "dialogAction": "accept",
  "dialogExpected": true,
  "deadlineMs": 12000,
  "waitFor": { "type": "text", "target": { "testId": "status" }, "expected": "Saved" }
}
```

- `dialogExpected: true` waits for the first dialog within the operation budget. Absence times out; cancellation and timeout invalidate the session. Reconnect explicitly.
- `dialogAction` without `dialogExpected` retains optional-dialog behavior. The listener covers the action and declared `waitFor`, not arbitrary later background activity.
- An undeclared dialog is dismissed and reported; no automatic acceptance is added. Only one dialog intent per action is supported.
- Run callers may supply both `deadlineMs` and `totalBudgetMs`; a longer total budget cannot extend a step. This patch does not add a hard browser-launch budget.

## Validation

- `KEEP_RUNNER_EVIDENCE=1 npm test`: 24 Runner tests and 11 DSH Bridge tests passed.
- `tests/operation-budget.test.mjs`: relative/absolute/total precedence, expired and null deadlines.
- `tests/browser-runner.test.mjs`: both step-first and total-first expiry through the control plane.
- `tests/browser-runner-real.test.mjs`: delayed accept/dismiss, listener cleanup, missing dialog timeout, cancellation, long-text match and trace generation using isolated fixtures.
- Local retained evidence: `/var/folders/3y/f5vqv18131x_y5wqx2ht89j80000gn/T/agent-eval-browser-real-l6jFMq` (temporary-directory retention; not a portable artifact).

## Boundaries

- Local development self-tests only. No Planora business regression, remote deployment, main merge or existing-service restart in this change.
- The original 123 report remains source-provided evidence, not independently reproduced against 123 here.
- Existing running services do not load these changes until deliberately switched to this revision and restarted.
