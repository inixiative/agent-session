# S1 correction: explicit native compaction evidence (Fable, 2026-09-07 ~04:24-04:30Z)

Bounded correction of the sibling Claude compaction/evidence boundary. Self-verified
only; not accepted. Astra opposite-model review and supervisor acceptance decide.
Astra provisional lead count 5, next checkpoint 6, unchanged.

## What was wrong
`ClaudeCodeSession` inferred compaction from a repeated `system/init` on the same
binding ("a second init means the session restarted"). Claude emits one init per
admission on one binding in print mode, so the second real admission of the
disposable capture produced a false `session_compact`. The same block also emitted a
second compaction after an explicit `compact_boundary` when the following init
arrived. Foundry invalidates its injection ledger on compaction, so adopting the
engine unchanged would have invalidated the ledger on every native turn.

## Correction (sibling source, two files)
- `src/claude-code-session.ts`: removed the `_sawInit` field and the repeated-init
  inference. Every `system/init` is now preserved once as an immutable
  `native_status` event with `unattributedReason: "session-configuration"`, its own
  `nativeSessionId`, and no `admissionId`; it returns before the turn path, so it is
  never attributed to the in-flight admission and never enters a turn's events or
  result. No payload comparison (model, tools, permission mode) is used to infer
  anything. Only an explicit `system/compact_boundary` on this session's binding emits
  `session_compact`, exactly once, with `compactionSource: "claude-code"`,
  `externalSessionId`, `nativeSessionId`, `correlation: "unknown"` and the frozen raw
  envelope. A repeated boundary is a duplicate only when its native `uuid` was
  already recorded (`_seenBoundaries`, emitted as `native_status`
  `"duplicate-boundary"`); boundaries without a uuid are never deduplicated by text
  equality. Foreign-binding envelopes still hit the pre-existing foreign-session
  refusal before this block, so a foreign boundary neither adopts its binding nor
  emits a compaction for this owner. First-init identity capture and fork-identity
  adoption are unchanged and still run before this block.
- `src/harness-session.ts`: additive union members `"session-configuration"` and
  `"duplicate-boundary"` on `SessionEvent.unattributedReason`, with doc comment.
  No other type changed; all existing members retained.

## Tests
- New focused file `tests/s1-compaction-evidence.test.ts` (6 cases), written and
  run RED first against the unchanged source (5 fail for the expected reasons; the
  foreign-boundary case already passed, so it is regression coverage): replayed
  actual two init envelopes from the frozen Claude capture (read-only), init during
  an inflight admission not attributed, differing init payloads not inferred, one
  boundary yields one compaction with native provenance and frozen raw, foreign
  boundary refused with binding unchanged, uuid-only duplicate handling with
  text-equal boundaries kept distinct.
- `tests/s1-ownership.test.ts`: one assertion updated. The Claude startup init is
  now found by `"session-configuration"` (Codex `session_configured` stays
  `"no-admission"`), and the test additionally asserts no compaction was emitted.
  Nothing else in that file changed.
- `scripts/s0/cross-check.ts`: seventh allowlisted independent file
  `native-compaction-evidence`, as permitted.
- Historical captures and the two new recordings were not touched or rewritten;
  their recorded normalizer output still shows the earlier false compaction, which
  is now the documented reason for this correction.

## Exact evidence
| Check | Result |
|---|---|
| Supervisor RED `fixtures/harness-qa/acceptance/native-compaction-evidence.test.ts` before | 0 pass / 2 fail (stable report `.foundry/qa/2026-09-07T04-20-00.582Z-G5`) |
| My focused file before correction | 1 pass / 5 fail (RED confirmed) |
| Supervisor file after | 2 pass / 0 fail |
| My focused file after | 6 pass / 0 fail |
| Sibling full suite `bun test` | 178 pass / 0 fail, 9 files |
| Sibling `bun scripts/s0/check.ts` (tests, `tsconfig.json`, `tsconfig.s0.json`, `git diff --check`) | passed, all four exit 0, manifest `13b665ad…1c2f` unchanged; report `.qa/s0-2026-09-07T04-28-15.764Z/report.json` |
| Cross-check, all SEVEN independent files explicitly | passed; Foundry G5 `.foundry/qa/2026-09-07T04-28-19.580Z-G5/report.json`: 21 pass / 0 fail across 7 files, `verification: passed`, `sourceChangedDuringChecks: false`, Foundry fingerprint `aa549645…c8b7` before and after; sibling manifest `6c6a7058…b5d3` before and after; `.qa/s0-cross-2026-09-07T04-28-19.566Z/report.json` |
| Foundry `bun run typecheck` (combined gate, recorded once, not fixed) | exit 0, 0 errors at 04:29Z |

The first check.ts run (`.qa/s0-2026-09-07T04-27-12.441Z`) failed on the single
ownership assertion above; types and whitespace passed. It was rerun once after the
one-line test change, not repeatedly.

## Limitations
- Offline replay and synthetic boundaries only. No native probe was run. The
  `compact_boundary` payload shape (`uuid`, `compact_metadata`) is synthetic; no
  retained capture contains a real boundary, so the positive path is unverified
  against the live protocol. Whether Claude can legitimately duplicate a boundary is
  unknown; uuid dedup is a guard, not an observed need.
- Foundry still runs the installed registry package 0.1.0, whose compaction
  heuristic is unchanged. This correction reaches Foundry only through the sibling
  source in the acceptance tests, not the runtime. Adoption remains unauthorized.
- The Codex engine's compaction path was not touched or reviewed here.
- Sibling `src/harness-session.ts` is shared with Astra's earlier S1 work; the change
  is a two-member additive union. If Astra has a concurrent edit in flight there,
  the combined report may be stale and should be rerun.

## Wording corrections acknowledged (for my earlier handoff)
Claude has no dedicated native turn ids; distinct admission/result uuids are not
turn ids. The supervisor did not inspect raw MCP stderr, so its meaning is unknown,
not verified benign. Rollback must preserve newly journaled records, never restore
an older snapshot over them. Publishing 0.2.0 is neither authorized nor required;
a reviewed local dependency mechanism is a separate proposal. The existing MCP cli
builds another thread in another process, so scoped tools need authoritative
runtime scoping and exact tool provenance, not a launch argument alone.
