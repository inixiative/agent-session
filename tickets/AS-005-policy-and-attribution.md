# AS-005: Make pooled execution controllable and attributable

**Status:** Proposed goal

## Why this matters

Consumers need to control which capacity can power their work and understand what happened when allocation changes, without making subscription identity the identity of the session.

## Goal

Let callers supply pooling policies and observe capacity allocation, availability, and changes throughout a session.

## Desired outcomes

- Kastle can supply eligible pools, priorities, and work/personal restrictions; agent-session carries out allocation and continuation within those policies.
- Other consumers can use pooling without depending on a running Kastle.
- Execution history identifies which capacity powered each part of the work without exposing authentication secrets.
- Allocation changes, unavailable capacity, and continuation failures can be understood by callers.
- Archive can retain that provenance alongside the session history without needing to perform allocation itself.
