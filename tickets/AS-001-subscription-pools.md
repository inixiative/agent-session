# AS-001: Represent subscriptions as pooled execution capacity

**Status:** Implemented in 0.2.0

## Why this matters

A working session should not be tied to one subscription merely because that subscription powered its initial execution.

## Goal

Allow agent-session to use a configured pool of authenticated subscriptions as sources of execution capacity for working sessions.

## Desired outcomes

- A session retains its identity and working context independently of the subscription supplying capacity.
- Multiple subscriptions can be available to power the same workload, within the configured eligibility policies.
- Sessions can be assigned capacity without making users manually bind every session to a permanent subscription.
- Pool participation does not itself grant access to unrelated files or working sessions.

## Implementation (0.2.0)

- `SubscriptionPool` models each authenticated login as an **instance** of a transport (`transport` + `profileDirectory` → `CODEX_HOME` / `CLAUDE_CONFIG_DIR`). Sessions are opened on an instance through a lease; the session keeps its own identity and context.
- Pool membership grants nothing: callers supply the instances, organizations and preferences they may use; routing filters by them and never widens them.
- See [docs/transports-pools-routing.md](../docs/transports-pools-routing.md).

**Remaining:** instances are configured by the caller; enrollment of new logins and Kastle-supplied instance lists are out of scope here.
