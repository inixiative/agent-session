# S1 continuation verification — offline preparation, 2026-09-07

Prepared by the continuing Astra lead. The supervisor accepted the previous bounded S1 **source** slice as count4; this preparation is **not accepted** and contains **no new native recording**. Fable remains reviewer; checkpoint is count6 or a serious regression. Foundry still runs registry agent-session0.1.0. All production source, the single-turn recorder entrypoint, dependencies and historical artifacts were preserved.

## Separate read-only memory verdict

Recommend **accepting the bounded memory-selection correction**, with no remaining production blocker found. Reviewed Fable Corrections2/3, the six unchanged independent files, actual selector/executor/layer/config/routes/browser cleanup source, and the supervisor's stable 19-case, baseline and historical UI evidence. Default oversized mandatory records are injected in full; opt-in block mode records the conflict and refuses before provider execution, including before native session creation through the real SessionBackedProvider facade. This is refusal evidence, not native retrieval or delivery acknowledgment.

Failed refresh/focus retries preserve the prior content/provenance with a stale state when focus differs. Restore/set/clear keep provenance honest. The same validator runs at source construction and load/save/global/project patch boundaries; invalid candidates do not replace live settings or the persisted file. Scope filtering and the full owned audit remain intact. The character budget is soft for mandatory records and excludes the summary/headings; it is not a token, latency or capacity guarantee. Selected/omitted accounting and matching ranges remain inspectable as prepared historical evidence. Instructions, domain knowledge and thread knowledge remain distinct decoration responsibilities.

During review I reproduced the nonblocking inherited-key validator issue with `constructor` and `toString`. Fable then supplied Correction4, independently owned: `Object.hasOwn` now guards the numeric-field lookup. I read that correction and the added unchanged independent own-fields file, and repeated the pure validator calls: both now reject. Its seven-file/24-case report and baseline are `.foundry/qa/2026-09-07T02-57-41.563Z-G3/report.json` and `.foundry/qa/2026-09-07T02-57-48.367Z-baseline/report.json` in Foundry; both show stable `dcf94540c74276c7b202bad080209c8b3324d375ec8b9fdea6146f83a5aea52a`. These are reviewed implementer/supervisor reports, not memory suites rerun by this preparation. The supervisor's historical UI333/390/1440 report remains `.foundry/qa/memory-selection-visual/2026-09-07T02-34-13.384Z/report.json`.

One Low QA-reporting follow-up remains at `packages/foundry/tests/browser/memory-selection-inspector.test.ts:69`: `released` records handle existence, and `passed` can remain true in that individual JSON if cleanup subsequently rejects. The runner still throws on `cleanupFailures`, so this does not turn the test run green or reopen the production memory correction. Set the individual report's passed/released fields from cleanup outcomes. The original missing-close/partial-launch leak is fixed: all created handles are attempted even after failed launch. No Foundry source/tests/shared graph were edited by Astra.

Before memory rollout: supervisor acceptance, controlled production-path Selection/refusal verification, then a separately authorized idle rollout with journal/binding/audit checkpoint and a prior-build rollback plan. No restart or rollout occurred here. A callable scoped native retrieval bridge remains T work; no native retention/performance acceptance is implied.

## Prepared recorder and bounded work

New files are `scripts/s0/continuation-plan.ts`, `continuation.ts`, `continuation-record.ts` and `tests/s1-continuation.test.ts`. `sanitize.ts` adds an explicit opt-in continuation profile; its default single-turn text policy remains unchanged. The existing FrameRecorder, CaptureState, lifecycle allowlists and actual ClaudeCodeSession/CodexMcpSession injected spawn paths are reused. This is recorder composition, not another engine or production parser change.

One fresh class instance and process per active engine, at most two send calls, no supplied native binding, restart/resume/fork/retry or app-server path. The second MCP `codex-reply` is a normal same-process continuation using the observed first binding. The production-generated argv is checked against the plan in fake-transport tests. Requested configurations remain Claude `claude-fable-5-1/max` and MCP `gpt-6-astra/xhigh`; only emitted configuration frames provide selected model/effort evidence. Missing fields are null/unknown, never inferred from argv. Account identity, capacity and subscription continuity stay unknown.

Each future capture creates a new controlled temporary directory with two independent files:

- `sentinel-one.txt`: `S1_FIRST_SENTINEL_29\n`; first response marker `S1_FIRST_DONE`.
- `sentinel-two.txt`: `S1_SECOND_SENTINEL_83\n`; second response marker `S1_SECOND_DONE`.

Each prompt asks for `bun --version && cat <that-file>` and a short response, forbidding edits, other directories, agents and unrelated work. Neither prompt asks for first-turn recall. Exact prompts, CLI argv, requested settings, version commands, paths and limits are printed by plan mode. Accepted command forms are the exact combined command or its two individual commands, using Bash/shell, with an optional zsh/bash `-c`/`-lc` wrapper. Original in-memory arguments are checked before redaction; matching output alone cannot validate an unrelated command. An unexpected pattern fails verification without replay or rewriting the evidence.

Second admission requires first local resolution **and** correlated native completion, matching native binding, observed terminal/start/RPC relationships as applicable, joined native tool-call IDs with actual sentinel/version output, the expected final marker, healthy transport and no observer/checkpoint failure. The guard is rechecked after the pre-second checkpoint. API-error precedence fields are explicitly preserved by the continuation sanitizer, including synthetic false-is_error/429 robustness coverage. A local send/RPC result is not a native terminal.

Send calls, actual local admission IDs and observed turn-write counts are separate. A pre-send hook failure cannot borrow the previous admission's ID or unowned startup events. Normalized events are stored once, with explicit per-turn event indices and wire frame boundaries. Stable pseudonyms join session/thread/turn/item/call/message IDs where emitted; reasoning, arbitrary strings/numeric content, credentials/environment and usable native handles are excluded. Observer exception payloads are never serialized. Sanitized frames retain the existing exact chunk provenance.

The future CLI records actual CLI/Bun/package versions, revision/source hashes, controlled directory-entry and file-manifest hashes, lifecycle times, and owned exit. File inspection does not follow a replaced sentinel symlink or read arbitrary extra file contents. Artifact changes stop further admission. Output directories are reserved exclusively before any model/version process; checkpoints and final JSON use exclusive writes. Collisions cannot replace historical files. Checkpoint-write failure retains the completed result in memory and prevents task two. Cleanup remains attached even when an evidence write fails.

Start deadline15s; each send deadline180s; post-result observation50ms. These bound admission waiting, **not native cancellation or total process lifetime**. Unknown work prevents another send, retains ownership and waits for its own late terminal or process exit. Cleanup uses the current admission, never an earlier terminal. A kill request does not count as observed exit. The CLI remains attached if an outcome or owned exit is unresolved; no automatic timeout/cancel/retry or alternate subscription is implemented.

## Commands and evidence

The following plan commands were actually run with exit0; they do not launch model/version processes or create recording directories:

```sh
bun scripts/s0/continuation-record.ts --plan claude s1-continuation-20260907T040000Z
bun scripts/s0/continuation-record.ts --plan codex-mcp s1-continuation-20260907T040000Z
```

Their outputs are `.qa/s1-continuation-claude-plan-final.json` and `.qa/s1-continuation-mcp-plan-final.json`. The example run ID is not reserved. The same commands with `--capture` are prepared **for separate supervisor authorization only**; neither was run. Choose a fresh timestamp run ID after review. The CLI owns its new temporary directory and child, never a work/review session.

- Focused preparation: `.qa/s1-continuation-preparation-focused.log`, **53 passing offline tests**. Covers malformed/partial framing, timeout/late evidence, foreign/missing/duplicate IDs, wrong call joins, unexpected commands, failed native versus unresolved RPC outcomes, first success then transport/checkpoint failure, pre-send hook failure, all observer seams, post-forward write failure, output collisions, symlink replacement, reasoning/numeric redaction, and kill without observed exit.
- Final sibling runner: `.qa/s0-2026-09-07T03-17-37.390Z/report.json`, passed. **163 Bun passes = 161 ordinary + 2 expected S4 failures**, 1191 assertions, seven files. Source/test and explicit script typechecks using the existing Foundry TypeScript/typeRoots workaround pass, as does diff check. Before=after fingerprint: `b5695b5dbdb9aad6955b52d8c626c18bae512fd534b12ed352bf4356d98d093c`.
- Explicit four-file cross-check: `.qa/s0-cross-2026-09-07T03-17-38.410Z/report.json`. Sibling manifest before=after: `806d5405afeab3f251034d063d750383bdd216b04ebfd586d1c1213565d560c1`.
- Foundry: `.foundry/qa/2026-09-07T03-17-38.429Z-G5/report.json`, **all14 unchanged independent cases**, 41 assertions, typecheck/diff pass. Explicitly named historical-evidence, terminal-evidence, turn-ownership and recording-safety files. Foundry before=after: `50f7b8f9d29a018e15586a7c98cf537ca03b87dea2b9132063629b83fe099917`.
- Before manifest: `.qa/s1-continuation-preparation-before/manifest.json`. Final preservation/whitespace report: `.qa/s1-continuation-preparation-integrity.json`. All13 historical artifacts, all sibling production source and the single-turn `record.ts` remain unchanged.

Test history is retained: the first run caught a syntax error, the next exposed the missing explicit per-turn normalized-event join, and typechecking caught a control-flow narrowing issue. Later boundary review added pre-hook identity and original-command verification tests. No failed assertion was weakened to claim native behavior. All new envelopes are labeled synthetic; the existing real recordings remain the separate S0 evidence. Expected S4 failures remain unresolved capability regressions.

## Durable next action and full scope

Supervisor inspects the runner, exact plan outputs, redaction and guard tests; Fable reviews this preparation read-only. Only then consider separately authorizing one real two-admission disposable capture per active engine. Astra would own capture lifecycle/evidence, supervisor independent artifact inspection, Fable opposite-model review. Any missing/unknown result stops that path without replay; a source correction requires a new bounded assignment. No self-acceptance or native S1/G5 acceptance follows this offline pass.

Preserve CORE-002/003/004/005 and AS-001–005: I package adoption and T callable scoped tools; central25-turn/model-effort gaps; live tool streams, cancellation, usage and measured retention; attachments/tags/artifact/lineage inspection; native fork/rewind/subsessions; all three parallel decoration segments; recovery/memory and subscription-independent logical work continuity. App-server repair remains separate. No native model process, dependency integration/install, credential/binding change, server restart, detached agent, commit or publication was performed. Lead count remains4, next checkpoint6 or a serious regression.
