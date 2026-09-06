# AS-001: Represent subscriptions as pooled execution capacity

**Status:** Proposed goal

## Why this matters

A working session should not be tied to one subscription merely because that subscription powered its initial execution.

## Goal

Allow agent-session to use a configured pool of authenticated subscriptions as sources of execution capacity for working sessions.

## Desired outcomes

- A session retains its identity and working context independently of the subscription supplying capacity.
- Multiple subscriptions can be available to power the same workload, within the configured eligibility policies.
- Sessions can be assigned capacity without making users manually bind every session to a permanent subscription.
- Pool participation does not itself grant access to unrelated files or working sessions.
