# S0 native protocol evidence — review pending

One probe per existing path was authorized and run. No runtime source, installed
package, dependency, lockfile or engine default changed. Foundry still resolves
registry agent-session0.1.0; these tests import the clean sibling source revision
4336603026fa64a15dbea5e0b8c61a12d6e14657. Each recording includes source hashes,
CLI/package versions, timestamps, requested configuration and owned PID lifecycle.

| Path | Actual evidence | Cleanup |
| --- | --- | --- |
| ClaudeCodeSession | Claude2.1.258; started00:38:06.018Z; native result success/end_turn00:38:18.024Z; tool result contains Bun1.3.14 and S0_SENTINEL_OK | PID9648 exited143 after native terminal; exit observed00:38:18.918Z |
| CodexMcpSession | Codex0.153.4; started00:38:06.018Z; native task_complete00:38:18.364Z; exec_command_end exit0 with both controlled outputs | PID9649 exited143 after native terminal; exit observed00:38:18.375Z |
| CodexAppServerSession | Codex0.153.4; started00:39:38.390Z; WebSocket listener announced; stdin initialize received no response for15s; zero turn requests | PID11517 exited0 at00:39:53.412Z after explicit no-turn evidence; no native completion claimed |

The app-server failure is a transport observation, not a successful turn fixture.
Installed help says stdio is the default and WebSocket is selected explicitly.
The unchanged class requests `--listen ws://127.0.0.1:0` while sending JSON to
stdin. Generated TurnStartParams requires `input` as an array; current source
passes a string. The latter is a schema mismatch found statically, not an observed
turn/start rejection, because the handshake never completed. See
app-server-preflight.json and the official source consulted:
https://developers.openai.com/codex/app-server . No alternate transport was used.

## Capability loss table

| Fact | Sanitized protocol evidence | Existing normalized interface | Next owner |
| --- | --- | --- | --- |
| Native model | MCP session_configured acknowledges gpt-6-astra/xhigh; Claude init acknowledges claude-fable-5-1 | Selection events absent; requested Claude max is not an effort acknowledgment | S1 identity/outcome; S5 model selection |
| Native completion | MCP task_complete carries turn ref-3; Claude result success, is_error=false, stop_reason=end_turn | MCP local send resolves without an explicit terminal event; Claude result retains terminal facts only in raw | S1 additive terminal outcome |
| Native IDs | MCP session/thread ref-1, turn ref-3, call ref-10; Claude session ref-2, tool-use/result ref-12 | MCP turn/call IDs only in raw tool events; Claude tool-result is dropped | S1 identities; S3 event bridge |
| Item IDs | MCP item_started/completed contain id:string in unknown item schemas | Item IDs omitted by this recorder's unknown-type policy; no item correlation proof from these fixtures | S1 follow-up capture allowlist, then S3 |
| Tool lifecycle | One begin/end pair in MCP; one Claude tool_use and matching user/tool_result, both read-only outputs verified | MCP emits two tool_use events for one call; Claude emits zero tool_result events | S3 normalization/deduplication |
| Usage | MCP total input27954/output121/cached4992; last input14059/output27/cached0. Claude input58/output276/cache creation15103/cache read35801 | MCP result has no tokens; Claude retains only input/output | S4 total/last/cache semantics |
| Unknown shapes |48 MCP unknown event shapes plus unknown nested item shapes, retained structurally | Cannot distinguish sanitizer omission from parser loss for those values | Explicit missing evidence; no fabricated IDs/types |
| Account/capacity | No supported identity/capacity query performed | Unknown | AS-001–005 capacity/continuity branch |

Recorded refs are stable only within one recording and are never native session
handles. They cannot be used to resume a probe. Controlled directories were new,
contained only sentinel.txt, and had equal before/after hashes. No repository work
or nested agents were requested. Real probes are not performance comparisons.

## Recording and replay boundaries

`scripts/s0/record.ts` uses each existing class's spawn injection seam. It forwards
the exact stdin/stdout bytes while parsing an observational copy in memory, and
records normalized onEvent observations independently. Before persistence an
explicit recursive allowlist removes auth/environment/private fields and entire
reasoning payloads. Only known controlled text literals survive free-text fields;
unknown shapes retain known-key primitive types and omitted-field counts, never
arbitrary names/values. Native ID values become stable redacted refs.

No raw tape, raw reasoning or original byte chunks are persisted. Chunk sizes,
timestamps and frame indices describe observed framing. `firstChunk` is the
buffer's conservative lower bound and can include the preceding chunk when the
buffer was empty; exact original byte offsets are not claimed. Replays serialize
the sanitized frames and use 1-byte,7-byte and whole-frame splits through the
existing production classes. They reproduce non-reasoning normalized events;
they are not byte-for-byte replays of secret-bearing original data. Tool command
strings retain only the observed allowed command fragments, not shell wrappers.

Recorder omissions are explicit: Claude effort acknowledgment, unknown item-ID
values/type names, modelUsage map details and artifact aggregate counters were
not retained. These must not be reported as native protocol absence or adapter
loss. The recorded model, terminal, tool pair, main usage fields and correlation
refs above are directly available in the allowlisted transport records.

## Checks and follow-ups

Run `bun scripts/s0/check.ts`. It runs all existing mocked tests, new sanitizer and
fixture-integrity/replay tests, both the provided source/test typecheck workaround
and explicit `tsconfig.s0.json` checking every added script, then diff checks.
It writes timestamped logs/report under `.qa`. Six `test.failing` tests run the
current parsers against real recordings and assert desired S1/S3/S4 behavior;
their expected failures are regression evidence, not capability acceptance. When
a later implementation fixes one, promote it to a normal test. Do not weaken it.

The manifest hashes the four protocol/preflight artifacts. Recorded native probe
commands were `bun scripts/s0/record.ts claude`, `... codex-mcp`, and
`... codex-app-server`; the exclusive attempt directory prevents repeating them.
Do not delete it to retry. Offline replay spawns no native process.

Next proposed S1 slice: sibling lead owns additive native session/turn/call IDs and
explicit terminal outcomes in HarnessSession/SessionEvent/SessionResult; repair
app-server's existing transport and schema usage only after independent review,
then obtain its first successful fixture in a separately authorized probe. Start
with installed-schema tests for stdio handshake and typed turn input, then offline
terminal/correlation tests. Foundry provider/journal integration is a separate
reviewed owner/interface change; no sibling installation is implied by S0.

S3 owns duplicate begins, Claude user/tool_result handling, item correlation and
success-output consistency; S4 owns last versus cumulative and cache usage. Expand
the lead's future persistence/transport matrix with native success followed by
observer failure, transport close, journal/cache rejection and recorder write
failure. Each must retain the original terminal fact and completed output without
false durable acknowledgment or replay; do not equate a timeout with cancellation.

Independent Fable review and supervisor artifact inspection are still required.
The larger graph retains real native fork/rewind/subsessions, tools, artifacts,
attachments/tags/history inspection, all three decoration segments, model/effort
parity and logical continuity across eligible subscriptions. No capacity parity,
seamless migration or full G4/S0 acceptance is claimed by these recordings.
