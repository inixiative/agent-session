# AS-003: Continue the same work when its supplying subscription changes

**Status:** Implemented in 0.2.0, limited to shared native history

## Why this matters

A subscription supplies capacity; it does not own the session context. Moving to another subscription should not require the user to reconstruct the work.

## Goal

Preserve the logical working session when subsequent execution is powered by a different eligible subscription.

## Desired outcomes

- Files, conversation history, and relevant execution state remain associated with the working session.
- A change in supplying subscription does not itself start an unrelated task or silently discard context.
- Interrupted work has a clear continuation outcome; completed work is not silently repeated as a consequence of switching capacity.
- Any provider-specific limitation on continuity is visible, rather than hidden behind a claim of seamless continuation.

## Implementation (0.2.0)

- `SubscriptionPool.continueOn` moves a thread to another instance only when both transports resume natively, the instances share a **continuation key**, and the old session has no native work of unknown outcome (so work is not repeated or forked silently).
- The default continuation key is the native history home, so distinct logins share continuity only where the caller arranged shared history (e.g. a shared Codex sessions directory). Refusals are explicit (`ContinuityError.reason`: `no-shared-history`, `resume-unsupported`, `unresolved-native-work`, `targets-unavailable`).

**Remaining:** building shared-history overlays for separate logins, and lossy continuation across different histories or providers (transcript replay), are not implemented.
