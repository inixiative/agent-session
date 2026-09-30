# AS-005: Make pooled execution controllable and attributable

**Status:** Implemented in 0.2.0

## Why this matters

Consumers need to control which capacity can power their work and understand what happened when allocation changes, without making subscription identity the identity of the session.

## Goal

Let callers supply pooling policies and observe capacity allocation, availability, and changes throughout a session.

## Desired outcomes

- Kingdom can supply eligible pools, priorities, and work/personal restrictions; agent-session carries out allocation and continuation within those policies.
- Other consumers can use pooling without depending on a running Kingdom.
- Execution history identifies which capacity powered each part of the work without exposing authentication secrets.
- Allocation changes, unavailable capacity, and continuation failures can be understood by callers.
- Archive can retain that provenance alongside the session history without needing to perform allocation itself.

## Implementation (0.2.0)

- Callers supply the policy inputs: eligible instances, organization, preferred instance and strategy per request (`PoolRequest`). The pool works without a running Kingdom.
- Pool events attribute capacity without secrets: `allocated` / `released` (lease, instance, strategy, utilization), `limits`, `failure`, `exhausted` (with exclusion reasons), `handoff` / `handoff-refused`.

**Remaining:** Archive persistence of these events and Kingdom policy wiring are consumer work.
