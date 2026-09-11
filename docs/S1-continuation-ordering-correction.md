# S1 continuation recorder: admission-deadline ordering correction (Fable, 2026-09-07 ~03:38-03:44Z)

Status: bounded corrective slice complete and self-verified. NOT self-approved.
Astra reviews read-only after its current selection slice; the supervisor decides
acceptance. No native capture was run; `--capture` remains unauthorized. Astra
provisional lead count 4, next checkpoint 6.

## Defect (supervisor reproduction, synthetic ordering evidence)
`fixtures/harness-qa/acceptance/native-continuation-ordering.test.ts` (Foundry,
unchanged): a fixed 50 ms settle after local RPC settlement acted as the effective
native-completion deadline. A matching `task_complete` 90 ms after the RPC inside a
300 ms admission deadline stopped the capture as evidence-incomplete after ~58 ms;
an RPC-only completion stopped after ~53 ms despite a 140 ms deadline.
RED reproduced before edits: 0 pass / 2 fail at ~03:38Z, matching
`../foundry/.foundry/qa/2026-09-07T03-37-43.055Z-G5/report.json`.
This is synthetic ordering evidence through the production `CodexMcpSession` and
the recorder, not an observed real capture failure.

## Changes (recorder scripts and offline tests only)
- `scripts/s0/continuation.ts`
  - Each admission records `deadlineAt = admission time + sendDeadlineMs`: one
    monotonic deadline covering local settlement, the current admission's native
    outcome and trailing frames. No phase receives a fresh full timeout.
  - New `awaitOwnedOutcome(turn)`: after local settlement (resolved or rejected),
    wait until THIS admission's terminal is known, the owned process exits, or the
    deadline passes. Foreign and duplicate terminals never satisfy it because the
    engine does not attribute them to the admission. Returns
    `known | deadline | process-exited | no-admission`, recorded per turn and in a
    new `admission-settled` lifecycle event.
  - `settleMs` now only lets trailing frames land and is capped by the remaining
    deadline. Verification, checkpoint and second-admission guards are unchanged.
  - New stop state `native-deadline`: deadline passed with the owned outcome still
    unknown. Admission stops permanently; ownership is retained; `cleanupAllowed`
    stays false until the same late terminal or owned process exit; `run()` cannot
    be resumed (already enforced); nothing is re-sent, forked or re-identified.
  - `turn.result` remains the immutable local settlement snapshot; `attempt` in the
    snapshot is the current native evidence. Documented in the snapshot.
  - Tool-output guard uses the exported `PINNED_BUN_VERSION` instead of a literal.
- `scripts/s0/continuation-plan.ts`: exported `PINNED_BUN_VERSION = "1.3.14"` with
  the pin rationale; `limits.admissionDeadline`/`afterDeadline` state the semantics;
  new `preflight { pinnedBunVersion, pinned: true, portability }` makes the
  portability limit explicit in every plan and provenance record.
- `scripts/s0/continuation-record.ts`: preflight compares the probed Bun version to
  `plan.preflight.pinnedBunVersion`, records `preflight` and `preflightFailures` in
  the final `version-preflight-failed` record with `modelProcessStarted: false`,
  and prints the failure. No model process is started on mismatch.
- `scripts/s0/cross-check.ts`: `native-continuation-ordering` added as the fifth
  allowlisted independent file; the original four are unchanged.
- New `tests/s1-continuation-ordering.test.ts` (8 offline cases, production
  `CodexMcpSession` over a controlled transport): terminal after RPC inside the
  deadline gives two verified admissions with `known` waits; RPC-only waits one
  monotonic deadline (elapsed bounded, not RPC delay plus a fresh deadline), stops
  `native-deadline`, unknown, one send, cleanup refused, no kill; a late matching
  terminal after the deadline reconciles the original admission, permits cleanup
  only, does not resume `run()` and re-sends nothing; foreign terminal inside the
  deadline never satisfies the admission; duplicate first terminal cannot complete
  admission two; transport exit before terminal ends the wait as `process-exited`,
  blocks task two and permits cleanup without a kill; observer failure during task
  two is evidence-incomplete; plan states the pin and deadline contract.

## Evidence (after the last edit; no source change during these runs)
- Supervisor ordering file, unchanged: 2 pass (RED 0/2 before).
- Own ordering tests: 8 pass. Existing offline suites (s1-continuation,
  s1-ownership, s1-lifecycle, s0-sanitizer, s0-recordings, s0-observation): 149 pass.
- Sibling runner `bun scripts/s0/check.ts`: `.qa/s0-2026-09-07T03-42-55.069Z/report.json`
  passed; 171 Bun passes across 8 files = 169 ordinary + 2 expected S4 failures
  (up from 163 with the 8 new ordering cases); source/test and script typechecks via
  the existing Foundry TypeScript and typeRoots path, diff check; fingerprint before = after
  `c22072c92441f6ffdc2f71ab699acb268382f0dce90f86794ab8db16fdd6715a`. Two expected
  S4 accounting failures remain, as before. (A raw `bunx tsc -p tsconfig.s0.json`
  without the typeRoots workaround cannot find `bun` types; that is the known
  environment limitation, not a source error.)
- Explicit FIVE-file cross-check (previous 14 cases + 2 = 16):
  `.qa/s0-cross-2026-09-07T03-42-58.769Z/report.json` passed; sibling manifest
  before = after `cca7e249a568d44d5128f77ce55583a7f74c46618038928321171a827f45363d`.
  Foundry `.foundry/qa/2026-09-07T03-42-58.783Z-G5/report.json` passed, source
  before = after `49dcc6583fc8a8b21c064401c3a073b29d012e9625a1a3070fd6c25b670c1325`,
  `sourceChangedDuringChecks: false`.
- Plan mode for both engines ran with exit 0 and created no run directory; both
  plans show the pinned preflight and deadline semantics.
- Untouched: sibling production engine sources (only Astra's earlier S1 diffs
  present), the 13 historical recordings under `fixtures/s0/`, Foundry production,
  independent tests, shared ledgers, dependency files, single-turn `record.ts`.

## Limitations, stated plainly
- Portability: the experiment is pinned to Bun 1.3.14 and the sanitizer's
  controlled literals. Another version fails preflight before any model process.
  No claim is made for other versions.
- Ordering cases are synthetic; they prove recorder contracts against the
  production MCP engine over a controlled transport, not native continuation,
  retention, cancellation or capacity.
- `native-deadline` is a recorder stop reason, not a native cancellation. Unknown
  work stays owned until its own late terminal or process exit.
- Claude ordering is unchanged in behaviour: its local settlement is the terminal
  result, so the wait returns `known` immediately; the RPC-versus-terminal race is
  MCP-specific.

## Correction 2 (~03:48-03:52Z): irreversible admission latch at the deadline boundary

Status: complete and self-verified. NOT self-approved. No capture authorized.

### Defect (supervisor reproduction, third ordering case)
A controlled matching terminal delivered after `awaitOwnedOutcome` returned
`deadline` but before final verification was observed by the trailing-frame pause
and verify path, and task two was sent (2 sends instead of 1). RED before edits:
2 pass / 1 fail at ~03:48Z, matching `../foundry/.foundry/qa/2026-09-07T03-46-20.261Z-G5/report.json`.

### Changes (recorder scripts and offline tests only)
- `scripts/s0/continuation.ts`
  - Permanent latch: when the owned-outcome wait ends with anything other than
    `known` (`deadline`, `process-exited`, `no-admission`), `closed = { reason, at }`
    and the stop reason are set synchronously before any further await, checkpoint
    or trailing-frame pause. A new `admission-closed` lifecycle event records it.
  - After the latch the trailing pause and `verify` still run, as evidence about
    what arrived late only; the loop returns unconditionally when `closed` is set.
    `run()` cannot be resumed; nothing is re-sent, forked or re-identified.
  - The stop reason is never rewritten once set: a late completion enriches the
    attempt evidence (snapshot `nativeOutcome` becomes `completed`) and permits
    owned cleanup, while `stop` stays `native-deadline`.
  - Deadline edge audit: the wait loop now checks the remaining deadline before
    checking for a known terminal. A terminal that becomes visible at or after
    expiration, before the next loop check, is classified `deadline`, not `known`.
  - Snapshot exposes `admissionClosed: { reason, at } | null`.
- `scripts/s0/lifecycle.ts`: `admission-settled` (fields `nativeWait`, `verified`)
  and `admission-closed` (field `reason`) added to the typed lifecycle allowlist;
  values are restricted to the known wait enum, otherwise `unknown`. Without this
  the two events introduced in correction 1 were being recorded as kind `unknown`.
- `tests/s1-continuation-ordering.test.ts`: new case reproducing the boundary
  injection; asserts one send, `native-deadline`, `admissionClosed.reason ===
  "deadline"`, the `admission-closed` lifecycle event, and that after the late
  terminal the outcome reads `completed` while the stop reason is unchanged and
  cleanup is permitted. Now 9 offline cases.

### Evidence (after the last edit; no source change during these runs)
- Supervisor ordering file, unchanged: 3 pass (RED 2/1 before).
- Own ordering tests plus all existing sibling offline suites: 158 pass.
- Sibling runner `bun scripts/s0/check.ts`: `.qa/s0-2026-09-07T03-50-56.609Z/report.json`
  passed; 172 Bun passes across 8 files = 170 ordinary + 2 expected S4 failures;
  source/test and script typechecks (Foundry TypeScript with typeRoots) and diff
  check exit 0; fingerprint before = after
  `68be4d9102e243792b9af14a49e071881d0aca4ec419fc7d5be049714408324a`.
- Explicit FIVE-file cross-check, 17 independent cases (14 + 3):
  `.qa/s0-cross-2026-09-07T03-51-03.108Z/report.json` passed; sibling manifest
  before = after `33f70a9b2d3c7a1f7762da255178eb96354852e6aabab52dcf09b8447b35f595`.
  Foundry `.foundry/qa/2026-09-07T03-51-03.122Z-G5/report.json` passed, source
  before = after `21a30528b86211cb94c9065112bf8fbdd7e9c64ba38a578b25c3346cdfffe9c7`,
  `sourceChangedDuringChecks: false`. Note the Foundry fingerprint differs from
  correction 1 because Astra's concurrent Foundry work landed in between; it is
  stable within this run.
- Untouched: sibling production engine sources, the 13 historical recordings,
  version pin, single-turn `record.ts`, independent tests, shared ledgers.

## Next
Astra read-only review, supervisor acceptance. Only then consider separately
authorizing one two-admission disposable capture per active engine, followed by
I/T adoption and the callable scoped-tool bridge. The full CORE-002/003/004/005
and AS-001..005 goal is unchanged.
