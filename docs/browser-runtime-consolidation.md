# Browser runtime consolidation

## Decision

`packages/browser-runner` is the only active browser runtime owned by Agent Eval Platform. It uses Playwright as the default engine and exposes the same runtime through REST, CLI, and MCP.

`agent-browser-runtime` is retained as an immutable migration source at commit `8917906`. It is not a second production runner and must not receive independent feature work. CDP remains an implementation option below the runner boundary only if a measured Playwright limitation justifies it; it does not get a separate session, evidence, or policy implementation.

## Migrated contracts

- isolated ephemeral or explicitly selected persistent profiles;
- session lease, heartbeat, single-flight operations, stale invalidation, cancel and explicit reconnect;
- mandatory Playwright trace for ordinary sessions; only the internal runtime-value setup path may create a trace/pixel-suppressed session;
- annotated post-operation screenshots, plus before/after screenshots for mutations;
- explicit `approvedScope` for mutating actions;
- safe default dismissal for undeclared native dialogs, returning `DIALOG_REQUIRED`;
- absolute-path, existence and regular-file checks for uploads;
- bounded visible text with total-length and truncation metadata;
- sanitized URLs/network evidence and runtime-value redaction;
- structured operation envelopes and stable error codes.

## Version ownership

The runtime package version, Playwright version, migration-source commit and Codex skill compatibility version are recorded together in `compatibility.yaml`. The repository copy of `docs/skills/direct-cdp-browser.md` is the canonical skill instruction. The installed file under `~/.codex/skills` is only an adapter copy and must point back here.

The platform's own Git commit is intentionally not written into `compatibility.yaml`: a file cannot reliably contain the hash of the commit that contains itself. Releases and deployments record that commit externally; tested application revisions remain per-case/per-run `sourceRevision` values.

## Non-goals

- no Planora adapter or Planora-specific browser package;
- no custom browser engine;
- no automatic conversion of a recorded trajectory into an authoritative test;
- no blind retry on the same tab after timeout or cancellation;
- no copying credentials, cookies, localStorage or a user's ordinary browser profile.

## Deliberately retired prototype surfaces

The old `auth-required` / `wait-auth` / `auth-ready` epoch protocol and the one-shot timing executable were not copied as parallel compatibility code. Authentication is represented once through a generic runtime-value setup fixture or a headed dedicated profile. If explicit multi-agent login coordination or a timing profiler is needed again, it must be added behind this platform's session/evidence contract rather than reviving the old runner.
