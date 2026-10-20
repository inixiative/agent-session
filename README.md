# @inixiative/agent-session

Drive coding-agent CLIs as **persistent, streaming, event-captured sessions** —
one interface, any agent, over interchangeable **transports**. Claude Code
(CLI or Agent SDK) and Codex (app-server) today; Gemini and Grok planned.
Also: warm **primed decision sessions**, **subscription pools** with
deterministic routing, **limit polling** and **session continuity**.

Most ways to script a coding agent are one-shot (`claude -p "…"`) and lose the
process. `agent-session` keeps a single long-lived agent process, streams turns
in over stdin, and classifies **every** event coming back — text, thinking,
tool calls, tool results, usage — so you can drive multi-turn work and capture
exactly what the agent did. Built for eval harnesses, agent comparisons, and
multi-agent orchestration.

```ts
import { ClaudeCodeSession } from "@inixiative/agent-session";

const session = new ClaudeCodeSession({
  cwd: "/path/to/workdir",
  model: "sonnet",
  permissionMode: "bypassPermissions",
});
await session.start();

const result = await session.send("Build a CLI that …");
console.log(result.content);          // final text
console.log(result.tokens);           // input/output + reported cache/thinking counters
for (const e of result.events) {      // full classified event stream
  if (e.kind === "tool_use") console.log("tool:", e.toolName);
}

session.kill();
```

## Why it's different

- **Persistent, multi-turn.** One process per session; `send()` per turn,
  resolves on the runtime's `result` event. Not one-shot `-p`.
- **Full event capture.** A normalized `SessionEvent` taxonomy
  (`text` / `thinking` / `tool_use` / `tool_result` / `result` / `error` /
  `session_compact`) — the same shape regardless of runtime.
- **Subscription auth, no API billing.** The Claude Code adapter strips
  `ANTHROPIC_API_KEY` and authenticates via the CLI's subscription / an
  `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token` — works headless and in
  containers.
- **Images with a turn.** `send(text, { images: [{ mediaType, data }] })` (png, jpeg, gif or
  webp, base64) where the transport declares `capabilities.images`: Claude gets base64 `image`
  blocks in the same user message, Codex `image` inputs with a `data:` URL. Anything else is
  refused before a byte is written.
- **fork / resume / interrupt** and pre-send hooks (rewrite the outgoing
  message — e.g. inject just-in-time context per turn).
- **A resume whose native conversation is gone is typed.** Claude's cleanup of its transcripts
  ("No conversation found with session ID") and a Codex thread with no rollout ("no rollout found
  for thread id") both raise `NativeBindingMissingError` (`nativeBindingMissing(error)` finds it
  behind a turn error) with nothing sent, so the caller can start fresh from its own record. For
  Codex the attempt settles as a no-send instead of uncertain native work.
- **Transports with declared capabilities.** How a model is reached is a
  pluggable transport; switching it is a routing change, not a rewrite.
- **Zero dependencies.** Just Bun + the agent CLI you're driving. The Agent SDK
  transport takes the SDK's `query` from the caller.

## Interface

`HarnessSession` is the provider-agnostic contract (`start` / `send` / `kill` /
`fork` / `interrupt` + an event handler). Optional members where a transport
supports them: `transport` (its descriptor), `interruptNative()` (acknowledged
stop), `readLimits()` (account limits without a model turn). Account limits also
arrive as `rate_limit` events.

## Transports

```ts
import { createSession, TRANSPORTS } from "@inixiative/agent-session";

const kind = "codex-app-server";            // or claude-cli, claude-agent-sdk
if (TRANSPORTS[kind].capabilities.interrupt === "acknowledged") { /* … */ }
const session = createSession(kind, { cwd, model: "gpt-6-luna", env: { CODEX_HOME: profile } });
```

| | claude-cli | codex-app-server | claude-agent-sdk | acp | api |
|---|---|---|---|---|---|
| Status | ✅ live | ✅ live | ✅ live | stub | stub |
| Resume / fork | native / native | native / – | native / native | – | – |
| Interrupt | acknowledged | acknowledged | acknowledged | – | – |
| Push | – | steer | – | – | – |
| Approvals | callback | callback | callback | – | – |
| Limits stream / poll | ✅ / ✅ | ✅ / ✅ | ✅ / – | – | – |
| Primed reset | fork | fork | – | – | – |

Codex runs only over `codex app-server --listen stdio://` (`CodexAppServerSession`);
Codex CLI 0.155 has no `mcp-server` subcommand.

Full matrix, notes and what is stubbed: [docs/transports-pools-routing.md](docs/transports-pools-routing.md).

### Tool gate

`onToolRequest(gate)` puts a decision on each tool call. Gates compose in
registration order; the first deny wins and a throwing gate denies.

```ts
const session = new ClaudeCodeSession({ cwd, permissionMode: hostMode, toolGate: true });
session.onToolRequest(async (call) => {
  if (call.stage === "pre-use") return structural(call) ?? { behavior: "allow" };
  return askTheHuman(call, call.signal); // the runtime's own mode wanted to ask
});
```

- `pre-use` (Claude only) runs before every call in every mode,
  `bypassPermissions` included; only a deny counts. A PreToolUse callback over
  the control protocol; one the session cannot read is denied.
- `permission` is an ask the runtime's mode raised; the answer is final (no gate:
  denied). Claude: `--permission-prompt-tool stdio`; `decisionReason` says why it
  asked, `agentId` marks a subagent's call. Codex app-server: command and
  file-change `requestApproval`, answered accept/decline, under
  `appServer: codexPermissions(mode)`. File-change asks carry the item's
  `toolInput.changes` (path, kind, bounded diff); command asks carry
  `networkApprovalContext`. Gated threads pin `approvalsReviewer: "user"` and
  are refused if a config routes approvals elsewhere. Under the default `never`
  policy nothing is asked, so `onToolRequest` throws.
- `call.signal` aborts when the runtime withdraws the request or the session
  ends (kill, exit, transport failure); a decision after that is never written.
  A turn timeout does not withdraw a pending Claude ask; `interruptNative()` does.
- A fork starts with a snapshot of the parent's gates.

## Subagents

A subagent's activity reaches `onEvent`, but never becomes part of a turn:

- **Outside every admission.** Every subagent event, lifecycle included,
  carries `unattributedReason: "subagent"`. It is never in a turn's
  `result.events` and never its `content`. This holds whichever turn is in
  flight, because a background subagent outlives the turn that started it.
- **`parentToolUseId`** names the parent's tool call that spawned it. On
  Claude this is the frame's `parent_tool_use_id`, with the native envelope
  kept in `raw`. On Codex it is the collab `spawnAgent` item.
- **`kind: "subagent"`** carries its lifecycle in `subagent`:
  - `phase`: started, progress, updated or ended;
  - identity and shape: `taskId`, `toolUseId`, `parentTaskId`, `agentType`,
    `depth`, `backgrounded`;
  - outcome: `status`, `summary`, `prompt`, and running `usage`.
- **Claude** builds the lifecycle from its `system` task frames for
  `task_type: "local_agent"`. Background shells, monitors and workflows are
  tasks too, and they are not reported as subagents.
- **Codex** reports `started` on the spawn and `ended` on `closeAgent`, plus
  `updated` (with the turn's status) as each child turn ends. Child threads
  carry their final messages as text; their other items stay diagnostics.
  Approval requests from child threads are not routed to gates yet.

## Primed decision sessions

One live, warm session per middleware role, primed once with its role
instructions and stable context, reset to that primed state every cycle:

```ts
import { CodexPrimedSessions } from "@inixiative/agent-session";

const decisions = new CodexPrimedSessions({ model: "gpt-6-luna", effort: "low", cwd: privateDir });
const result = await decisions.decide(
  { key: `${threadId}:aux:domain:api`, instructions: rolePrompt, context: layerContent, hash: layerHash },
  { input: "## Message\n…", onAdmission: register },
);
```

Run Codex decisions on a private `CODEX_HOME` that holds only the login (link
`auth.json` from the account's home; a copy forks its refresh token): Codex has no
setting that drops the user's own `AGENTS.md`, and a decision thread that reports
any instruction source is refused.

Codex hosts every key as a thread of one `app-server` process per account and
forks the primed thread per cycle; Claude forks a persisted primed session with
a pre-spawned spare. Measured on a ChatGPT login: warm Codex decisions 2.45 s
median vs 3.9 s for `codex exec` per decision, with 34% fewer input tokens; warm
Claude (haiku) decisions 1.95 s with the whole primed prefix read from cache.

### In the main session's own process (Claude)

`ClaudeInSessionDecisions` holds decision roles as subagents of a main
`ClaudeCodeSession`, so a thread and all its decision roles are one process:

```ts
const decisions = new ClaudeInSessionDecisions({ model: "claude-haiku-5-5", effort: "low" });
const session = new ClaudeCodeSession({ model: "claude-opus-5-5", cwd, toolGate: true });
session.extend(decisions); // before start(): agents, an SDK MCP server, a PreToolUse claim
await session.start();     // one internal setup turn starts the root agent
decisions.prestart(threadId, roles.map((spec) => ({ spec, standby })));
await decisions.ready();
const result = await decisions.decide(spec, { input, standby });
```

- **Shape.** The setup turn asks the main model to start `foundry-root` in the
  background. The root never ends: it starts dispatcher generations
  (`foundry-dispatch`), which start members (`foundry-warden`), all in the
  background, through a `next` tool the host holds open. A member holds the
  host's `moment` tool until a decision answers it, and answers through
  `answer`. After setup, no member activity needs a main-model turn.
- **Pinned input.** Every spawn passes the session's PreToolUse callback,
  which replaces its prompt with the composed text, so agent definitions are
  generic and an edited role reaches the next spare without a relaunch.
  Spawns of these agent types from anywhere else are denied; the main agent's
  own subagents go to the tool gate untouched.
- **Fresh per call.** Each member serves one decision. A used one is replaced
  at once; a role with no held spare starts a member with its input inline.
- **Recycle.** A dispatcher's context grows ~700 tokens per member started;
  past `recycleTokens` (100k) a new generation takes over and the old one
  ends into the root once empty.
- **Orphans.** A nested agent whose parent ended reports its own end to the
  main thread, which wakes the main model (Claude Code 2.1.300). Members of a
  dispatcher that ended unasked are therefore never retired or stopped, and an
  orphan's `answer` call is held for the session's life. Past `maxOrphans`
  (40) the host stops serving and its caller falls back.
- **Limits.** Claude Code runs 20 subagents at once by default; the launch
  raises `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS` (`maxSubagents`, 96). The
  session declares `perTaskStopAffordance`, so the user's Stop spares
  background agents.

## Pools, routing and continuity

```ts
import { SubscriptionPool } from "@inixiative/agent-session";

const pool = new SubscriptionPool({ instances: [
  { id: "work", transport: "claude-cli", profileDirectory: "/profiles/work", organizationIds: ["org"] },
  { id: "spare", transport: "claude-cli", profileDirectory: "/profiles/spare", organizationIds: ["org"] },
] });
const { session, lease } = await pool.open({ runtime: "claude", model: "sonnet", organizationId: "org", preferredInstanceId: "work" });
```

Routing is deterministic (quartile-balanced, owner-first or pinned) over
observed limits, leases and health; stale or unknown limits exclude an instance
and every exclusion has a reason. `continueOn` moves a thread only between
instances that share native history, and says why when it cannot.

## Usage telemetry

Claude results preserve `cacheRead`, `cacheWrite`, `cacheWrite5m`, `cacheWrite1h`,
and `thinking` alongside `input`/`output`. Input excludes the disjoint cache
counters; thinking is already included in output and TTL counts are included in
cacheWrite. Unreported optional counters remain absent. `providerUsage` retains
the entire original usage object, including service tier and future tags.

`result` events and `send().tokens` carry the native turn aggregate. Session
`totalTokens` and artifact totals sum these completed results once. `usage`
events carry request snapshots with the original envelope (request/message IDs,
model and tags) in `raw`; they may repeat across content blocks. Do not sum
request snapshots together with result totals. Interrupted turns retain request
snapshots in the artifact but do not fabricate a completed-turn total.

## Roadmap

| Runtime | Status |
|---|---|
| Claude Code | ✅ shipped |
| Codex app-server | ✅ shipped (`CodexAppServerSession`, `CodexPrimedSessions`) |
| Claude Agent SDK | ✅ shipped (`ClaudeAgentSdkSession`; caller supplies `query`) |
| ACP agents / direct API | typed stubs |
| Gemini CLI | planned |
| Grok CLI | planned (when its headless/stream mode matures) |

Opaque runtimes degrade gracefully — fewer event types, never a hard failure.

[Subscription pooling goals](tickets/README.md) (AS-001…005) are implemented as described in [docs/transports-pools-routing.md](docs/transports-pools-routing.md); each ticket lists what remains.

## Provenance

Extracted from [`inixiative/foundry`](https://github.com/inixiative/foundry),
where this drives the Artificer session. Consumed by foundry, oracle,
and the inixiative bench.

## License

MIT

## Runtime

Development and new continuation captures use Bun 1.4.2, pinned in `.bun-version` and `package.json`. Historical S0 recordings retain their original Bun 1.3.14 evidence; they are not new 1.4.2 captures.
