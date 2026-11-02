# AS-008: Claude mid-turn steer

**Status:** ✅ Built for `claude-cli` (2026-11-02). `claude-agent-sdk` stays `push: 'none'`: the SDK stream's `command_lifecycle` frames are unverified.

## Goal

Implement `push()` for both Claude transports by writing a user message with `priority` into the running turn:

- **`claude-cli`:** a stream-json user message on stdin with `priority`. Today `push()` emits `push_ignored` (`src/claude-code-session.ts:503-513`).
- **`claude-agent-sdk`:** the same message on the SDK bridge's inbox (`src/claude-agent-sdk-session.ts:333`). This transport has no `push` override today either.

Then flip `TRANSPORTS[...].push` from `'none'` to `'steer'` for each transport that passes.

## Why

- Oracle COMPARISON adopt #2 (P0) has been open since 2026-10-11.
- Paseo (`priority: "next"`) and T3 Code (`priority` on `query.offer`, `ClaudeAdapterV2.ts:2068-2090`) both steer Claude through the Agent SDK, which drives the CLI over stream-json.
- Whether the bare CLI honours `priority` without the SDK needs one cassette to confirm. If it doesn't, the SDK transport is the steer path.

## Acceptance

- [x] A steer during a running Claude turn is consumed by that turn (cassette: `fixtures/claude-steer/`, `tests/claude-steer.test.ts`). The bare CLI honours `priority` (2.1.316): no SDK needed.
- [x] `TRANSPORTS` reflects what each transport really does.
- [x] Foundry CORE-001 can then gate on it.

## As built

- Taken in after a tool result: one result. Reply already final: the steer runs right after that result as a follow-on result; the session holds the turn open until it (send() settles once, usage summed).
- A stop withdraws a steer not yet started (`cancel_async_message`) before it interrupts.
- `push()` now returns `PushOutcome` (`steered` / `unknown` / `ignored` + reason) on every transport.

## Related

Oracle `docs/foundry/reference/COMPARISON.md` §0 (2026-10-31); Foundry CORE-001.
