# S0 recorder correction — independent review pending

This is a newly authorized recording run, not a retry of unknown work. All three
original attempts had recorded native-terminal/no-turn evidence and owned process
exit before this correction. The original ../2026-09-07 recordings, manifest,
README and source hashes remain byte-for-byte unchanged. Copies of the original
recorder/sanitizer source are under source-before and match their recorded hashes.
Their format1 firstChunk bounds are historical conservative bounds, not repaired
or reinterpreted as exact. These fresh format2 records use the corrected recorder.

## Offline defects corrected before the new captures

- Untyped numbers, including numbers inside nested content arrays, are replaced
  with type-only markers. Numeric retention requires an explicit protocol field
  and context, such as usage.input_tokens, normalized timestamp or command exit
  code. Numeric JSON-RPC request IDs remain typed request IDs; other numeric ID
  values are pseudonymized. Genuine observed usage counts remain available.
- Analysis phase/channel omits the whole payload even without type/kind. Reasoning
  items retain only explicitly allowed pseudonymized identity metadata and an
  omission marker. No reasoning text, arbitrary private content, environment or
  credentials are persisted or printed.
- Newline-byte framing tracks the actual chunk containing the first byte, including
  after exact newline boundaries and across incomplete UTF8 sequences. Original
  bytes remain unpersisted; replay uses sanitized JSON with independent chunking.
- CaptureState marks send admission immediately before calling the existing send.
  It independently counts attempted and observed writes. An outbound observer
  error, unrecognized/partial request or admitted send prevents a no-turn claim.
  The original write still occurs exactly once, and its original error propagates.
  Cleanup requires native terminal evidence, owned process exit, or affirmative
  no-send/observed-non-turn evidence. Empty observed frames alone are insufficient.
  Six deterministic observer/transport cases cover these states without a native
  timeout or cancellation probe.
- Explicit ID-field allowlists now retain stable pseudonyms on unknown items too.
  Payload/type-name redaction therefore no longer erases emitted item identity.
  Installed codex0.153.4 schema evidence is in schema-evidence.json; no generic
  raw-field passthrough or invented type acknowledgment was added.

The unchanged independent Foundry cases first failed again in
foundry/.foundry/qa/2026-09-07T00-51-58.925Z-G5/report.json. Before either capture,
all offline tests/typechecks passed in .qa/s0-2026-09-07T01-00-07.032Z/report.json,
and all three independent cases passed in the paired reports:

- .qa/s0-cross-2026-09-07T00-59-28.763Z/report.json (sibling hashes before/after).
- foundry/.foundry/qa/2026-09-07T00-59-28.778Z-G5/report.json (Foundry checks).

Paths beginning .qa are relative to the sibling repository; Foundry paths are in
the adjacent Foundry checkout. `bun scripts/s0/cross-check.ts` repeats that exact
independent command while recording a full sibling source/file-hash inventory.

## New native facts and preserved gaps

| Path | Actual terminal and cleanup | Identity evidence |
| --- | --- | --- |
| ClaudeCodeSession | PID31870; native result success/end_turn01:00:59.591Z; exited143 at01:01:00.446Z | Session ref-2; message refs10/22; tool-use/result ref-13. Dedicated turn_id/turnId fields were not emitted in the retained envelope fields. |
| CodexMcpSession | PID31869; native task_complete01:01:01.456Z; exited143 at01:01:01.461Z | Session/thread ref-2, turn ref-3; four item start/end pairs refs9/10/13/15; command item ref-13 equals exec call ref-13. |

Both ran one controlled read-only command, observed Bun1.3.14 and S0_SENTINEL_OK in
the actual tool result, and left the sentinel hash and file set unchanged. New
directories and run ID are distinct from the original attempts. All outgoing
writes were observed; send admission occurred once; no observer failures occurred.
No app-server capture was repeated. Its original handshake-only evidence remains
limited: no native turn, no model/effort selection acknowledgment, no success.

MCP item type names remain unknown/shape-only because the wire variants did not
match the explicit type-name allowlist. Their IDs and parent links are directly
retained and correlated, not reconstructed from old lossy records. Allowed ID
fields absent from a fresh record were absent at those observed locations; this
does not establish absence of unknown aliases elsewhere. Claude message IDs are
not relabeled as dedicated native turn IDs. IDs are pseudonyms local to each
recording, not live session handles.

MCP acknowledges gpt-6-astra/xhigh. Claude acknowledges claude-fable-5-1; requested
max effort is still not an observed effort acknowledgment. Account identity and
capacity remain unknown. Valid usage survives sanitization: MCP final total
input27972/output142/cached23552 and last input14073/output37/cached13696; Claude
input58/output296/cache creation15123/cache read35803. These are this recording's
observations, not quantitative performance or capacity claims.

All six desired S1/S3/S4 regressions remain unresolved: normalized native terminal,
first-class turn/call IDs, duplicate MCP begin events, dropped Claude tool results,
MCP total/last/cache usage and Claude cached usage. Existing classes replay both
old and corrected records across1/7/65536-byte splits; no production parser was
changed to make the regression assertions pass. Expected failures are explicitly
not capability acceptance.

## Reproduction and next action

The newly authorized commands were:

```
bun scripts/s0/record.ts claude 2026-09-07-correction-1
bun scripts/s0/record.ts codex-mcp 2026-09-07-correction-1
```

Existing attempt directories are exclusive. Do not remove them or create another
run ID to bypass the one-probe-per-active-path authorization. No original native
tape was used to reconstruct missing data. `manifest.json` pins both corrected
artifacts and every original manifest recording hash.

Run `bun scripts/s0/check.ts` for the full sibling suite, source/test and explicit
script typechecks using Foundry's installed compiler/type roots, and diff checks.
Run `bun scripts/s0/cross-check.ts` for unchanged independent safety cases with
stable cross-repository provenance. Final report links are in CORE-004's correction
work log. No dependencies were installed, runtime source changed, engine default
switched, binding altered, active server restarted, detached agent launched, or
package committed/published by this correction.

Return for Fable read-only review and supervisor artifact verification before S1.
S0 is not self-accepted; lead accepted-slice count remains2. Proposed S1 remains
additive identity/terminal interfaces plus the smallest separately reviewed
app-server transport/schema repair. Preserve the full native fork/rewind/subsession,
tool/artifact/attachment/tag/history inspection, three-segment decoration,
recovery/memory, model/effort and eligible-subscription continuity goals; never
replay unknown work or infer capacity identity from successful output.
