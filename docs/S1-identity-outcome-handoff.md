# S1 identity and ownership handoff — 2026-09-07

Status: implementation submitted for independent QA and Fable read-only review. S0 bounded recorded evidence is accepted (lead count 3); S1 is not self-accepted. Supervisor owns shared CORE-003/004/005 graph updates. Fable owns disjoint Foundry G3/G7 memory work. No Foundry production files or shared ledgers changed here. Foundry still resolves registry agent-session 0.1.0, not this checkout.

## Scope and dependency order

Read the latest CORE-003/004/005 ledgers and Fable's verbatim S0 review before work. Order: snapshot source and immutable recordings → failing argv/lifecycle and ownership tests → recorder allowlists → additive evidence types → existing-engine ownership and normalization → fixture replay and deterministic failure matrix → typechecks/cross-check → this handoff. `.qa/s1-before/manifest.json` pins 26 pre-change files; runtime sources were also copied there. Initial failures are in `.qa/s1-ownership-red.log`; subsequent diagnostic runs remain in `.qa/s1-*.log`. No native sessions were started in this assignment.

Recorder changes are future policy only (format 3): executable/flag/value allowlists, separated and equals forms, redacted base context/unknown options, stable pseudonyms for resume IDs and owned PIDs, typed version provenance, explicit lifecycle field allowlists. New session/event IDs are sanitized before recording, including numeric RPC identities. Original and corrective recordings, manifests and historical source copies remain immutable; they do not acquire the new policy retroactively. The recorder is still a single-send recorder, not a multi-turn engine or retry system.

## Public interface and ownership

`SessionEvent`/`SessionResult` add optional `admissionId`, `nativeSessionId`, `threadId`, `turnId`, `itemId`, `callId`, `messageId`, `rpcRequestId`, `correlation`, `nativeOutcome` and `terminal` evidence as applicable. IDs retain their separate namespaces. `externalSessionId` remains the compatible resume-binding alias. A configured binding is not copied into observed identity fields before wire evidence arrives.

`session.attempts` and `artifact().attempts` expose per-admission snapshots with dispatch (`not-dispatched`/`attempted`), local outcome, native outcome, transport outcome, optional RPC outcome, original content/events and terminal evidence. `SessionTurnError.cause` preserves the original error; its `attempt` getter reads current evidence, including late completion after caller rejection. A prior `SessionResult` is a snapshot; reconcile by admission ID against `attempts`, not by mutating the returned result.

```ts
import { SessionTurnError, type HarnessSession } from "@inixiative/agent-session";
async function submit(session: HarnessSession, prompt: string) {
  try {
    const result = await session.send(prompt);
    // `resolved` alone is not a native acknowledgment. Persist these independently.
    return { output: result.content, admissionId: result.admissionId,
      nativeOutcome: result.nativeOutcome ?? "unknown", terminal: result.terminal,
      rpcOutcome: result.rpcOutcome };
  } catch (error) {
    if (error instanceof SessionTurnError) {
      const evidence = error.attempt;
      // Preserve output even when local settlement failed; never replay unknown work.
      return { output: evidence.content, admissionId: evidence.admissionId,
        nativeOutcome: evidence.nativeOutcome, localFailure: evidence.localFailure };
    }
    throw error;
  }
}
```

Timeout and local interrupt reject the waiter but retain native ownership. Already queued and newly arriving sends are rejected with `dispatch: not-dispatched` while ownership is unresolved; none silently execute later. Late correlated completion updates the original admission. MCP releases ownership only after a matching native terminal and settlement of its owned call. A tools/call resolution without terminal returns an explicitly unknown result and continues blocking dispatch. Process loss or kill does not prove native cancellation; unresolved attempts prevent automatic resume, fresh-session fallback or fork. No cancellation request/acknowledgment protocol was added (S2).

Claude correlates its observed result UUID and session with the single ordered stream; its dedicated native turn ID stays absent. Duplicate known result UUIDs and foreign sessions are rejected. An unseen stale same-session result without a dedicated turn ID cannot be distinguished from a current result by the recorded protocol; do not claim that stronger guarantee. Claude fork initialization may adopt the child's emitted session ID while leaving the parent binding untouched; native fork/rewind acceptance remains outstanding. MCP's existing fork convenience still continues a thread; it is not native fork acceptance.

MCP binds task_started/task_complete turn IDs and checks envelope IDs, exposes native item lifecycle IDs, and joins exec begin/result via call ID without emitting a duplicate begin at exec end. An RPC error is an RPC failure, not a fabricated native failed/cancelled terminal. The actual recordings contain successful task_complete only: native MCP failure acknowledgment remains missing evidence. Claude's result error is classified native failed; unknown result statuses remain unknown. Observers (including async rejection) cannot replace original errors or terminal evidence. Terminal facts buffered before EOF/exit survive transport failure.

## Evidence and remaining capability losses

| Contract | Recorded wire / source result | Remaining limit |
| --- | --- | --- |
| Claude tool result | Real user-envelope tool_result now exposed with call ID and output | Tool deltas/UI still S3 |
| MCP tool relationship | One begin/result; native call/turn and item lifecycle IDs retained | Other tool types and streaming remain S3 |
| MCP terminal | Recorded task_complete exposed separately from tools/call settlement | Failed/cancelled native fixtures absent; unknown stays unknown |
| Claude terminal | Recorded result success/error shape; result UUID separate from admission | No dedicated native turn ID in these recordings |
| Usage | Missing result tokens remain undefined; legacy aggregate explicitly observed-only | Two S4 expected failures remain: MCP total/last/cache and Claude cache fields |
| Experimental app-server | Public schema inspected only; prior no-turn handshake failure retained | No transport/default/input repair or native probe here |
| Recovery | Timeout/transport ownership and original binding retained in this object | No durable adapter recovery, browser/journal integration or native continuity acceptance |

Public schema was generated without a native session into an owned temporary directory (`.qa/s1-schema-path.json`, exit 0). Existing preflight already proves stdio/default versus WebSocket mismatch and array input schema. No app-server defaults, transport arguments or input repair changed. Shared base ownership becomes conservative for this experimental path too; successful app-server operation remains unverified.

## Integration and next proposed bounded node

Foundry adoption requires a separately reviewed dependency/integration change. Its adapter should map Foundry logical turn → admission ID → native IDs explicitly; persist local, native, transport and journal outcomes separately; reconcile late evidence by admission ID; preserve completed output after subsequent infrastructure failure. Do not infer native failure/not-started from absent provider input, local promise settlement or successful Harness traces. Do not read optional zero-valued legacy totals as proof of complete usage accounting (`accounting: observed-only`). A regression reproduced native success followed by an MCP tools/call error overwriting completed text (`.qa/s1-post-success-red.log`); the fix keeps the completed output and original error separate, with RPC resolved and local rejected. Success followed by infrastructure failure is now part of this slice's own failure matrix and must remain in future persistence/transport coverage.

After independent review, propose a separately authorized bounded continuation verification: one disposable session per active engine, two sequential read-only sentinel sends through the same existing production class and process, with explicit first/second admission/terminal correlation, stable native session/thread observation where emitted, exact tool output, original binding and no extra execution. Extend/review the single-send capture observer for two admissions before recording; no automatic retry, no active work/review sessions as targets. Verify actual terminal and owned process exit, not local timeout/cancel inference. The app-server stdio/array-input repair and its one real probe remain a separate reviewed node, not part of this continuation check.

Full CORE-003/004/005 and AS-001–005 goals remain: all three decoration segments, recovery and memory, historical artifact/attachment/tag inspection, subsessions, native fork/rewind, model/effort parity, and logical session continuity independent of the eligible supplying subscription. None of this source-only pass establishes account identity/capacity, native parity, full G4, subscription continuity or whole-goal completion. No dependency/lockfile/node_modules edits, probes, binding changes, server restarts, agents, commits or publication occurred.

Exact final checks will be appended below after the stable cross-repository run.

## Final recorded checks

- Sibling `bun scripts/s0/check.ts`: `.qa/s0-2026-09-07T01-46-33.896Z/report.json`, passed. Bun **85 passes = 83 ordinary + 2 expected S4 failures**, 0 unexpected failures, **671 assertions**, six files. Both source/test and explicit script typechecks passed using Foundry's existing TypeScript/@types paths; tracked diff check passed. Source/fixture fingerprint before = after: `7f38f18236223dab1b96d47284f3b4a96c1d2e256dd5c46a95c4a7e3dfb21235`.
- Sibling `bun scripts/s0/cross-check.ts`: `.qa/s0-cross-2026-09-07T01-47-02.268Z/report.json`, passed. Its per-file sibling manifest aggregate before = after: `8c02b4826bb721e635e2e05d84bc50e652ece821eaf094f68965ee4c1f047488`. This uses a different aggregation format from the check runner; both full manifests/hashes are retained.
- Unchanged independent Foundry command: `bun scripts/harness-check.ts G5 fixtures/harness-qa/acceptance/native-recording-safety.test.ts`. Evidence: `../foundry/.foundry/qa/2026-09-07T01-47-02.285Z-G5/report.json`. All **3 safety tests** passed, plus Foundry typecheck/diff. Foundry fingerprint before = after: `7f28d4d7f9013ea2d1e890001eeea1069033d0ddb31029ae4cb8bd680b8f71c3`. Independent assertions were not changed.
- `.qa/s1-integrity-diff.json`: all **13 historical fixture/provenance files unchanged** against pre-S1 hashes; explicit no-index whitespace checks passed for **18 source/script/test/doc files**, including untracked additions. Handoff evidence text was appended after code verification; runner fingerprints cover source, scripts, tests, fixtures and configurations, not this progress document.

Durable next action: supervisor independent artifact/negative-case QA and Fable read-only S1 review, then decide whether the bounded continuation verification above is ready for authorization. Lead count remains 3 pending independent acceptance; next leadership checkpoint remains count 4 or a serious regression. No native continuity, cancellation, app-server success, Foundry adoption or whole-goal acceptance is claimed.

## S1 terminal/evidence correction — 2026-09-07, submitted for review

Read the latest shared ledgers, supervisor terminal review and unchanged independent terminal assertions. The correction reproduced **1 pass / 3 failures** at `../foundry/.foundry/qa/2026-09-07T01-59-47.704Z-G5/report.json`; sibling cross-repository report: `.qa/s0-cross-2026-09-07T01-59-47.692Z/report.json`. The **real retained Claude 429 envelope passed**. The two missing/false `is_error` variants are **synthetic robustness mutations**, not additional native captures. The third failure demonstrated shared mutable returned event/raw evidence. `.qa/s1-terminal-before/manifest.json` pins all 31 pre-correction files. Targeted tests first reproduced seven failures (`.qa/s1-terminal-targeted-red.log`).

Claude error precedence now matches the established Foundry provider: explicit `is_error`, an `error_` subtype, or numeric API status >=400 wins over subtype `success`; the explicit `terminal_reason: api_error` also establishes failure. `NativeTerminal` exposes optional `subtype`, `reason` and `apiErrorStatus` directly on events/results/attempt snapshots. Unrecognized evidence remains unknown, with its available reason retained. Transport and RPC errors still cannot manufacture native failure.

The owned-data boundary is `src/retained-evidence.ts`: clone each new native JSON event once, deeply freeze that owned data, and reuse it across observers, session history and attempt/result snapshots. A private WeakSet prevents re-copying a retained event at emission. No accumulated transcript is cloned on each event. Snapshots copy/freeze only their event-reference arrays and small state envelope; terminal/tokens are retained immutable data. Caller-owned input is detached without freezing the caller's original object. Both-engine tests attack nested tool/raw data, token counts, terminal metadata and public arrays through observers, returned results, snapshots and artifacts. Rejecting observers preserve original local errors, and late completion updates the same admission while old snapshots/results remain fixed. This is an ownership strategy with deterministic checks, not a measured latency or memory-overhead claim.

The cross-check runner now accepts an explicit allowlisted file list, preserving its recorder-only default. The final invocation explicitly named **all three** files:

```sh
bun scripts/s0/cross-check.ts \
  fixtures/harness-qa/acceptance/native-terminal-evidence.test.ts \
  fixtures/harness-qa/acceptance/native-turn-ownership.test.ts \
  fixtures/harness-qa/acceptance/native-recording-safety.test.ts
```

- Sibling suite/source/script typechecks and tracked diff: `.qa/s0-2026-09-07T02-03-30.052Z/report.json`, passed. **96 Bun passes = 94 ordinary + 2 expected S4 failures**, **747 assertions**, six files, zero unexpected failures. Source/fixture fingerprint before = after: `61da9800cc873578895b76928dc93bbee5574c3319275f65017d49f3ab858f01`.
- Explicit three-file cross-check: `.qa/s0-cross-2026-09-07T02-03-50.165Z/report.json`, passed. Sibling per-file-manifest aggregate before = after: `4f3879f69b16cb7a5bf23b56c6118a0684e8c5aab67b2dc5d7c3442d31424221`.
- Foundry evidence: `../foundry/.foundry/qa/2026-09-07T02-03-50.182Z-G5/report.json`. **All 11 independent cases passed** (4 terminal, 4 admission, 3 recorder), **27 assertions**, plus Foundry typecheck/diff. Foundry source before = after: `5148cefa665d56eaf896ac3f8197cfbdc67e1bcf4110ed7f5c0d675ea6cec6e8`. No independent assertions changed.
- `.qa/s1-terminal-integrity-diff.json`: all **13 historical recording/provenance files unchanged**; no-index whitespace checks passed for all **18 source/script/test files**, including untracked additions. This handoff update follows code verification and is outside the runner source fingerprint, as before.

No new native probes, forks, dependencies, integration, credentials, bindings, servers, commits, publication or agents were involved. Foundry still uses registry 0.1.0. No Foundry production/shared graph files were edited; Fable retains ownership of its active memory correction, and no review was dispatched. The maxTurns25 integration gap remains separately tracked, unchanged here.

Remaining limits are unchanged: Claude ordered-stream correlation lacks dedicated turn IDs; MCP native failed/cancelled terminal evidence remains absent; S2 cancellation, S3 streaming/UI, two S4 accounting failures, native continuation/fork/rewind/subsessions and Foundry adoption remain open. The full decoration/recovery/memory/inspection/model-effort/subscription-continuity goal remains intact. **Next action: supervisor independent QA, then Fable read-only review when available; no self-acceptance or probe dispatch. Lead count stays 3 and the count4/serious-regression checkpoint is unchanged.**

## S1 historical transport and unowned evidence correction — 2026-09-07

Read Fable's verbatim S1 review and the supervisor's unchanged historical cases before editing. The three independent cases reproduced RED at `../foundry/.foundry/qa/2026-09-07T02-25-39.524Z-G5/report.json` (0 pass / 3 fail; stable Foundry fingerprint `a8418b345746c9a8f13d4e37c119f42cb20adde372f3be3b17b9eda1746bee28`). `.qa/s1-historical-before/manifest.json` pins 34 sibling source/config/fixture files before this correction. Targeted ownership tests reproduced 9 failures in `.qa/s1-historical-targeted-red.log`; the added sanitizer assertion separately reproduced 1 failure in `.qa/s1-historical-sanitizer-red.log`. These are deterministic injected-transport cases, not new native recordings.

Both engines now attribute transport failure only to the still-owned admission. A session-level `session_end.transportOutcome: "failed"` preserves idle EOF evidence without rewriting earlier settled attempts. A buffered Claude terminal settles its stream send before exit; a buffered MCP terminal preserves native completion while an unanswered RPC still records local/transport failure. RPC-only resolution and timeout still retain unknown native ownership through later EOF. Existing returned results/snapshots remain fixed; late evidence updates the original admission. Cleanup does not replace an already recorded transport failure with `closed`.

Unowned Claude native envelopes and MCP notifications now remain deeply frozen in session history as `native_status`, with `correlation: "unknown"`, no admission ID, and an explicit `unattributedReason`. Reasons distinguish no admission, foreign session/turn, duplicate terminal, nonterminal evidence after an observed terminal, and an unrecognized event. MCP retains the original notification envelope so `params.id` remains inspectable. Foreign evidence cannot change the resume binding or resolve current work. Unrecognized and unowned evidence is retained as raw diagnostic history; it is not promoted to a successful admission or counted as tool execution/accounting. Claude still uses ordered-stream attribution where dedicated native turn identity is absent; this correction does not establish stronger native correlation than the wire provides. Fable's claim that MCP already retained all unowned events was too broad: its subclass also returned before classification, and is corrected here.

Low findings: both engines expose immutable `diagnostics.observerFailures.{synchronous,asynchronous}` snapshots on the session and artifact. Counters retain no exception text/object, create no recursive observer events, and preserve the original execution/transport error. Claude's unknown terminal now has `localFailure: "unrecognized-terminal"`, not `rpc`. The recorder explicitly allowlists these labels and typed count fields; adversarial nested/string/numeric payloads remain excluded. A deterministic two-admission sanitizer check verifies stable pseudonyms; no historical recording or historical sanitizer provenance was rewritten.

Public integration example (optional fields preserve existing consumers):

```ts
const history = session.events.filter(event => event.unattributedReason);
// These events have no admissionId. Inspect their native raw evidence separately.
const observations = session.diagnostics?.observerFailures;
const current = session.attempts?.find(a => a.admissionId === admittedId);
// Reconcile current by admissionId; never rewrite an earlier returned result.
```

Foundry adoption must persist session-level transport/diagnostic history separately from admission outcomes, and route unattributed events to historical inspection rather than the active conversation result. This is an interface requirement only: Foundry still resolves registry agent-session 0.1.0. No Foundry production, independent assertions or shared graph files were edited; Fable retains the memory correction.

### Recorded final checks

- `bun scripts/s0/check.ts`: `.qa/s0-2026-09-07T02-33-49.564Z/report.json`, passed. **110 Bun passes = 108 ordinary + 2 expected S4 failures**, 868 assertions, six files, zero unexpected failures. Source/test and explicit recorder/script TypeScript checks passed using the existing Foundry TypeScript/typeRoots workaround; tracked diff passed. Fingerprint before = after: `c4733e75ffd846267aaeea6d73701544ac142f26e2975532068d88096af8f4ae`.
- Explicit four-file cross-check: `.qa/s0-cross-2026-09-07T02-33-50.994Z/report.json`, passed. Sibling per-file manifest aggregate before = after: `29b206439c55e7e95b21fbf6365485bd6d7b2e38ead71bcf214aaaeeed29162b`.
- Foundry report: `../foundry/.foundry/qa/2026-09-07T02-33-51.018Z-G5/report.json`. **14 independent cases passed**, 41 assertions, plus Foundry typecheck/diff. Source before = after: `3c16b20bee7c155bbc0157dbf8a142a63da375e1533af6809a752f75bc21b082`. The invocation explicitly named `native-historical-evidence.test.ts` (3), `native-terminal-evidence.test.ts` (4), `native-turn-ownership.test.ts` (4) and `native-recording-safety.test.ts` (3). The cross-check allowlist now includes the historical file; its default remains recorder-only.
- Standalone strict check of the unchanged historical test used `--target ES2023 --module ESNext --moduleResolution bundler --types bun --strict --skipLibCheck --noEmit`; it passed. Final integrity/typecheck evidence is `.qa/s1-historical-final-integrity-diff.json`.
- All **13 historical recording/provenance files** match their pre-correction hashes. Explicit no-index whitespace checks cover all seven changed source/script/test files and this handoff, including untracked files. No fixture was overwritten.

Earlier checks are retained honestly: `.qa/s0-2026-09-07T02-30-26.377Z/report.json` passed tests but caught an optional-result-field assertion typing error, subsequently corrected with explicit `open` assertions. `.qa/s0-cross-2026-09-07T02-30-38.859Z/report.json` passed all 14 cases/typecheck/diff but Foundry changed during verification; it is not stable verification. The later final reports above supersede these checks, without replaying native work.

### Retention limit and next action

Blocked-refusal retention remains uncapped, deliberately unchanged. A controlled sample of 100 refused sends per engine retained 101 attempts and exactly one outbound turn: serialized snapshots measured **21,307 bytes (Claude)** and **21,347 bytes (MCP)** in the final suite log. These are JSON snapshot sizes, not heap, timing, native capacity or production-workload measurements. Refusal records grow linearly and reading all attempts allocates a full snapshot array.

Proposed separate retention work: agent-session owns cursor-based history reads and a permanently resident unresolved-admission record; a reviewed durable append/page boundary owns settled history and refusals. Eviction requires a verified durable acknowledgment, immutable sequence/correlation indexes, and independently tested reload/reconciliation. Measure bytes per event/refusal, sustained producer rate, read cost and storage-failure behavior before choosing budgets. Backpressure is required when the durable sink is unavailable; bounded memory plus lossless unlimited producer history cannot be promised. No lossy cap, coalescing, persistence engine or retry loop was added here.

Durable next action: supervisor independent QA and Fable read-only re-review. Only after independent acceptance and separate authorization, prepare the existing two-admission disposable recording node: same class/instance/process per active engine, two independent sentinel tasks, exactly two sends, stable pseudonymized native/session/turn/item/call relationships where actually emitted, actual terminal and owned process-exit evidence, no automatic retry. That node remains unexecuted. App-server schema/stdio repair stays separate; native cancellation, streams, the two S4 accounting gaps, continuation, native fork/rewind/subsessions and package integration remain open. No source-only pass establishes native or subscription continuity.

The entire CORE-002/003/004/005 and AS-001–005 goal remains: all native tools/streams/artifacts and attachment/tag/lineage inspection, subsessions, model/effort support, recovery, memory, all three decoration segments, and subscription-independent logical work continuity. No agents, probes, credentials/bindings, dependencies, restarts, commits or publication occurred. Lead count remains **3**, with the count4/serious-regression checkpoint unchanged. This is submitted evidence, not self-acceptance.
