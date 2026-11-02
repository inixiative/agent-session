# Goals and tickets

These tickets capture product goals and outcomes. Version 0.2.0 implements them as described in [docs/transports-pools-routing.md](../docs/transports-pools-routing.md); each ticket records what remains.

## Subscription pooling

**The session is the work; subscriptions supply capacity.** Files, conversation history, and execution state belong to the working session. A subscription powers execution without becoming the owner of that context.

The goal is to spread session workloads over available subscriptions and preserve continuity when the supplying subscription changes. Multiple sessions may draw capacity from one pool; a working session may draw capacity from different eligible subscriptions over its lifetime.

| Ticket | Goal | Status |
| --- | --- | --- |
| [AS-001](AS-001-subscription-pools.md) | Represent subscriptions as pooled execution capacity | Implemented (0.2.0) |
| [AS-002](AS-002-load-distribution.md) | Spread session workloads across available capacity | Implemented (0.2.0) |
| [AS-003](AS-003-session-continuity.md) | Continue the same work when its supplying subscription changes | Implemented for shared native history (0.2.0) |
| [AS-004](AS-004-provider-capabilities.md) | Establish pooling and continuation support for each harness | Implemented (0.2.0) |
| [AS-005](AS-005-policy-and-attribution.md) | Make pooled execution controllable and attributable | Implemented (0.2.0) |
| [AS-006](AS-006-session-proxy-terminals.md) | Serve many callers from a single-session login through a proxy terminal | Not started |

## Runner parity (2026-10-31)

Proposed after the T3 Code / Paseo refresh (Oracle `docs/foundry/reference/COMPARISON.md` §0).

| Ticket | Goal | Status |
| --- | --- | --- |
| [AS-007](AS-007-codex-plans-and-subagent-items.md) | Codex plans and collab sub-agent items reach the session stream | Proposed |
| [AS-008](AS-008-claude-mid-turn-steer.md) | Claude mid-turn steer (`priority`) on both Claude transports | ✅ claude-cli (2026-11-02); Agent SDK not verified |

## Secrets (2026-11-02)

| Ticket | Goal | Status |
| --- | --- | --- |
| [AS-009](AS-009-secret-scratch-pad.md) | `$$` secrets lifted into a scratch pad the agent uses through a tool that returns nothing; private paths blocked. Opt-in | Proposed |

## Responsibilities

- **agent-session:** manage sessions, allocate execution from configured pools, and continue work within caller-supplied policies.
- **Kingdom:** supply the available capacity and policies, including priorities and work/personal boundaries.
- **Archive:** preserve and retrieve session history, including attribution of the capacity used.

Pooling should remain usable by consumers other than Kingdom. It is not a prerequisite for Archive's storage, search, and sync MVP.

Provider-specific support is declared per transport (AS-004). It does not imply that every native harness supports every account switch or that different providers are interchangeable.
