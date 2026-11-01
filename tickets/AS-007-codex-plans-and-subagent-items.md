# AS-007: Codex plans and collab sub-agent items

**Status:** Proposed (not built)

## Goal

1. **Plans.** Map the app-server's `turn/plan/updated` notification to a plan event on the session stream. Today `src/codex-session.ts` has no handler. Foundry's ACP agent shows plans only from Claude TodoWrite or an `update_plan` tool row (foundry `packages/acp/src/tools.ts:70-86`), so Codex plans never reach a host.
2. **Sub-agents.** Collab calls are partly handled (`codex-session.ts:1561-1603`):
   - `spawnAgent` and `closeAgent` are handled;
   - `sendInput` and `wait` are dropped as diagnostics;
   - the child thread's own items are not followed.

   Emit them under the child's `kind: 'subagent'` id, so Foundry's observed child threads (`packages/foundry/src/turns/subagents.ts`) carry the child's work.

## Why

Both reference hosts show Codex plans. Paseo shows Codex children as launch markers (#8276) and T3 shows them as child threads. Ours shows an opaque spawn and close.

## Acceptance

- [ ] A Codex turn that plans emits plan events that Foundry's ACP agent forwards as `plan` updates.
- [ ] A collab child's items appear under its subagent id.
- [ ] VCR cassettes cover both.

## Related

Oracle `docs/foundry/reference/COMPARISON.md` §0 (2026-10-31); Foundry FEAT-002 (keep multi-agent on).
