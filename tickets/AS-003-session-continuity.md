# AS-003: Continue the same work when its supplying subscription changes

**Status:** Proposed goal

## Why this matters

A subscription supplies capacity; it does not own the session context. Moving to another subscription should not require the user to reconstruct the work.

## Goal

Preserve the logical working session when subsequent execution is powered by a different eligible subscription.

## Desired outcomes

- Files, conversation history, and relevant execution state remain associated with the working session.
- A change in supplying subscription does not itself start an unrelated task or silently discard context.
- Interrupted work has a clear continuation outcome; completed work is not silently repeated as a consequence of switching capacity.
- Any provider-specific limitation on continuity is visible, rather than hidden behind a claim of seamless continuation.
