# AS-002: Spread session workloads across available capacity

**Status:** Proposed goal

## Why this matters

When multiple subscriptions are available, work should be distributed across them rather than unnecessarily concentrating demand on one subscription.

## Goal

Allocate session execution across eligible subscriptions in the pool, taking available capacity and caller-supplied priorities into account.

## Desired outcomes

- Multiple active sessions can draw on different subscriptions in the same pool.
- Work can use another eligible source of capacity when the current source is unavailable or exhausted.
- Allocation respects the pool boundaries and priorities supplied by the caller.
- When no eligible capacity is available, the session remains understandable and recoverable rather than appearing to have completed.
