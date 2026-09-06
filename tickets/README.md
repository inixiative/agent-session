# Goals and tickets

These tickets capture proposed product goals and outcomes. They do not prescribe implementation, APIs, scheduling algorithms, or a build sequence. Pooling is proposed work, not a claim about current package capabilities.

## Subscription pooling

**The session is the work; subscriptions supply capacity.** Files, conversation history, and execution state belong to the working session. A subscription powers execution without becoming the owner of that context.

The goal is to spread session workloads over available subscriptions and preserve continuity when the supplying subscription changes. Multiple sessions may draw capacity from one pool; a working session may draw capacity from different eligible subscriptions over its lifetime.

| Ticket | Goal | Status |
| --- | --- | --- |
| [AS-001](AS-001-subscription-pools.md) | Represent subscriptions as pooled execution capacity | Proposed |
| [AS-002](AS-002-load-distribution.md) | Spread session workloads across available capacity | Proposed |
| [AS-003](AS-003-session-continuity.md) | Continue the same work when its supplying subscription changes | Proposed |
| [AS-004](AS-004-provider-capabilities.md) | Establish pooling and continuation support for each harness | Proposed |
| [AS-005](AS-005-policy-and-attribution.md) | Make pooled execution controllable and attributable | Proposed |

## Responsibilities

- **agent-session:** manage sessions, allocate execution from configured pools, and continue work within caller-supplied policies.
- **Kastle:** supply the available capacity and policies, including priorities and work/personal boundaries.
- **Archive:** preserve and retrieve session history, including attribution of the capacity used.

Pooling should remain usable by consumers other than Kastle. It is not a prerequisite for Archive's storage, search, and sync MVP.

Provider-specific feasibility remains to be established. The architectural goal does not imply that every native harness already supports every account switch or that different providers are interchangeable.
