# AS-004: Establish pooling and continuation support for each harness

**Status:** Implemented in 0.2.0

## Why this matters

Native harnesses may differ in how authenticated capacity can be selected or changed. The product model should remain clear while actual support is established for each provider.

## Goal

Determine and document how each supported harness can participate in subscription pooling and preserve sessions across changes in supplying capacity.

## Desired outcomes

- The supported account-selection, concurrent-execution, capacity-reporting, and continuation behaviors are explicit per harness.
- Verified capabilities are distinguished from proposed or unsupported behaviors.
- Pooling retains the native harness capabilities on which existing consumers depend.
- Support for changing subscriptions within a provider is distinguished from any separate capability to move work between providers.

## Implementation (0.2.0)

- Every transport declares its capabilities in `TRANSPORTS` (resume, fork, rollback, interrupt, push, approvals, usage, limits, text-only, primed reset, billing), describing this package's implementation, with a `verified` level (`live` / `controlled` / `none`).
- Verified live on 2026-09-24: Claude CLI and Agent SDK (claude 2.1.281, SDK 0.3.281), Codex app-server and MCP (codex-cli 0.155.1). ACP and direct API are typed stubs.
- Per-harness pooling behavior: Codex and Claude logins are selected by profile directory; Codex serves concurrent threads on one login and one process; continuity within a provider depends on shared history (AS-003); moving between providers is not continuity.
