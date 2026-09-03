---
name: direct-cdp-browser
description: Use Agent Eval Platform's isolated Playwright runner for fast, auditable browser checks without Codex's managed browser bridge.
---

# Audited browser runner

The skill id is retained for compatibility. Despite the historical name, the canonical runtime is now `packages/browser-runner` in this repository; do not call the frozen `agent-browser-runtime` scripts.

## Boundaries

- Verify the exact environment and host before remote work. Never transfer facts between test, customer and intranet environments.
- Use an ephemeral context by default. A persistent profile must be dedicated to this runner and located below `packages/browser-runner/data/profiles`; never copy a normal Chrome/Codex profile.
- Use REST, CLI or MCP only. Do not attach an unrecorded Playwright/CDP client and claim audited results.
- Every mutating `act` must include a concise user-approved `approvedScope` describing target and purpose.
- `approvedScope` authorizes only the described UI mutation; it does not confer a business role or approval authority. Agent/browser checks are 研发自测, not the tester acceptance action used by the Feishu tracker. They may support moving an explicitly authorized record to “待验收”, but must not be used to decide or write “验收通过，待上线”“验收不通过”“复测未通过” or other 上线/关闭 decisions. A request such as “测完没问题就更新飞书” is not a tester decision.
- Agent/browser evidence must not manufacture a tester decision. After a fresh fix is deployed and the user explicitly requests another acceptance round, a negative decision (`验收不通过`, `复测未通过`, or `仍需改进`) may be moved back to `待验收`; accepted, release-ready, released, and closed statuses remain protected.
- If a native dialog is expected, declare `dialogAction: "accept"` or `"dismiss"`. An undeclared dialog is dismissed and the operation fails with `DIALOG_REQUIRED`.
- A deadline or cancellation makes the session stale. Inspect the result and explicitly reconnect only when retrying is justified.
- A successful action only proves that the action completed. Product correctness comes from a separately recorded assertion.

## Start and use

```sh
PLATFORM=/Users/ltc/CodexProject/中交机电局项目/agent-eval-platform
cd "$PLATFORM"
npm run start:browser
```

In another shell:

```sh
cd "$PLATFORM"
npm --workspace @agent-eval-platform/browser-runner run eval -- browser health
npm --workspace @agent-eval-platform/browser-runner run eval -- browser create \
  '{"url":"https://example.com"}'
npm --workspace @agent-eval-platform/browser-runner run eval -- browser inspect SESSION_ID
npm --workspace @agent-eval-platform/browser-runner run eval -- browser act SESSION_ID \
  '{"action":"click","target":{"role":"button","name":"Save"},"approvedScope":"user-approved test fixture change"}'
npm --workspace @agent-eval-platform/browser-runner run eval -- browser assert SESSION_ID \
  '{"type":"text","target":{"testId":"status"},"expected":"Saved"}'
npm --workspace @agent-eval-platform/browser-runner run eval -- browser trace SESSION_ID
```

Use `AGENT_EVAL_URL` for a non-default local endpoint. Pass larger JSON bodies as `@/absolute/path/request.json`. Start with `AGENT_EVAL_HEADLESS=false` only when a user must sign into a dedicated persistent profile.

## Evidence

Normal sessions fail closed if Playwright trace cannot start. Each operation saves a structured request/result/error record, sanitized network summary and annotated screenshot; mutating actions save before and after screenshots. Visible text is capped at 8,000 characters and reports the uncapped size. A run containing runtime setup values suppresses pixel/trace capture for the whole run, because later page states can still display earlier inputs; the values are also redacted from assets, results and structured evidence.
