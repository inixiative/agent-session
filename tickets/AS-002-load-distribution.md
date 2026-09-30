# AS-002: Spread session workloads across available capacity

**Status:** Implemented in 0.2.0

## Why this matters

When multiple subscriptions are available, work should be distributed across them rather than unnecessarily concentrating demand on one subscription.

## Goal

Allocate session execution across eligible subscriptions in the pool, taking available capacity and caller-supplied priorities into account.

## Desired outcomes

- Multiple active sessions can draw on different subscriptions in the same pool.
- Work can use another eligible source of capacity when the current source is unavailable or exhausted.
- Allocation respects the pool boundaries and priorities supplied by the caller.
- When no eligible capacity is available, the session remains understandable and recoverable rather than appearing to have completed.

## Implementation (0.2.0)

- Deterministic routing (`rankCandidates`, ported from the Foundry draft policy) over observed limits, active leases and local health: `quartile-balanced` (default), `owner-first`, `pinned`.
- Limits come from polls without a model turn (`probeCodexLimits`, `probeClaudeLimits`) and from `rate_limit` events on pooled sessions; stale or unknown observations exclude an instance.
- Exhausted, blocked or cooling-down instances are skipped; when nothing is eligible, `PoolExhaustedError` lists each instance's exclusion reason instead of appearing to complete.

**Remaining:** reservation estimates per lease are a flat configurable percentage; no cross-process lease coordination (one pool per process).
