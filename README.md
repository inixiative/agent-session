# @inixiative/agent-session

> Part of [inixiative](https://www.inixiative.com), technology for cooperation. See [all the projects](https://github.com/inixiative).

Drive Claude Code and Codex as persistent streaming sessions behind one
interface. Claude Code runs over its CLI or the Agent SDK, Codex over its
app-server and Muse over `muse serve`; Gemini and Grok are planned. The package
also holds warm **primed decision sessions**, **subscription pools** with
deterministic routing, **limit polling** and **session continuity**.

A one-shot call (`claude -p "…"`) ends the process after one answer.
`agent-session` keeps one long-lived agent process per session, sends each turn
in over stdin, and classifies each event that comes back (text, thinking, tool
calls, tool results, usage), so you can drive multi-turn work and record what
the agent did. Foundry, Oracle and Archive run their agent sessions on it, as do
our eval harnesses and agent comparisons.

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

## What you get

- **Persistent, multi-turn.** One process per session; `send()` per turn,
  resolves on the runtime's `result` event.
- **Full event capture.** A normalized `SessionEvent` taxonomy
  (`text` / `thinking` / `tool_use` / `tool_result` / `result` / `error` /
  `session_compact`), the same shape for every runtime.
- **Subscription auth, no API billing.** The Claude Code adapter strips
  `ANTHROPIC_API_KEY` and authenticates via the CLI's subscription / an
  `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token`; it works headless and in
  containers.
- **Images with a turn.** `send(text, { images: [{ mediaType, data }] })` (png, jpeg, gif or
  webp, base64) where the transport declares `capabilities.images`: Claude gets base64 `image`
  blocks in the same user message, Codex `image` inputs with a `data:` URL. Anything else is
  refused before a byte is written.
- **fork / resume / interrupt** and pre-send hooks (rewrite the outgoing
  message, for example to add context for that turn). Resume is configuration, not a
  method: build the session with `externalSessionId`.
- **A resume whose native conversation is not found is typed.** Claude finding no transcript
  ("No conversation found with session ID": cleaned up, deleted, or under another project
  directory or config home) and Codex finding no rollout ("no rollout found for thread id") both
  raise `NativeBindingMissingError` (`nativeBindingMissing(error)` finds it behind a turn error,
  with the `cwd` the lookup ran in). No turn ran, so the attempt settles as a no-send instead of
  uncertain native work, and the caller can start fresh from its own record.
- **A model the runtime does not serve is typed.** Claude's `model_not_found`, Codex's
  `modelNotFound` and Muse's "model `<id>` does not exist" (what a retired model answers) reject
  the turn with `NativeModelMissingError` (`nativeModelMissing(error)` finds it, with the
  `model` the session asked for), so the caller can move the conversation to a successor. Plan,
  access and rate-limit refusals stay ordinary failed turns.
- **Transports with declared capabilities.** How a model is reached is a
  pluggable transport; switching it is a routing change.
- **Two dependencies.** `@inixiative/json-rules` and Meta's `@muse-code/sdk`
  (for the Muse transport), plus Bun and the agent CLI you're driving. The Agent
  SDK transport takes the SDK's `query` from the caller.

## Interface

`HarnessSession` is the provider-agnostic contract (`start` / `send` / `kill` /
`fork` / `interrupt` + an event handler). Optional members where a transport
supports them: `transport` (its descriptor), `interruptNative()` (acknowledged
stop), `readLimits()` (account limits without a model turn). Account limits also
arrive as `rate_limit` events.

## Transports

```ts
import { createSession, TRANSPORTS } from "@inixiative/agent-session";

const kind = "codex-app-server";            // or claude-cli, claude-agent-sdk, muse-serve
if (TRANSPORTS[kind].capabilities.interrupt === "acknowledged") { /* … */ }
const session = createSession(kind, { cwd, model: "gpt-6-luna", env: { CODEX_HOME: profile } });
```

| | claude-cli | codex-app-server | muse-serve | claude-agent-sdk | acp | api |
|---|---|---|---|---|---|---|
| Status | ✅ live | ✅ live | ✅ live | ✅ live | stub | stub |
| Resume / fork | native / native | native / – | native / native | native / native | – | – |
| Interrupt | acknowledged | acknowledged | acknowledged | acknowledged | – | – |
| Push | steer | steer | steer | – | – | – |
| Approvals | callback | callback | callback | callback | – | – |
| Limits stream / poll | ✅ / ✅ | ✅ / ✅ | ✅ / ✅ | ✅ / – | – | – |
| Primed reset | fork | fork | – | – | – | – |

Codex runs only over `codex app-server --listen stdio://` (`CodexAppServerSession`);
Codex CLI 0.155 has no `mcp-server` subcommand.

Muse Code runs over `muse serve` through Meta's `@muse-code/sdk` (`MuseSession`), pinned to
the CLI's version (1.4.20): a host serving another version is refused at start. It bills the
saved Muse login: metered keys and endpoints never reach it (nor Muse's own tool runs, which
inherit its environment: a repo command needing `OPENAI_API_KEY` will not see it under Muse),
and a resumed session must be on provider `meta`. Per-login isolation is `env: { XDG_CONFIG_HOME, XDG_DATA_HOME }` (login and
sessions). The session's `permissionMode` (default `default`, gated) goes through `musePermissions(mode)`
to an explicit permission profile, because the host default lets Muse's AI reviewer answer
approvals instead of the gates. Questions arrive
through `onUserInput()`; unanswered ones are cancelled with a reason. An approval offering
no approve-once or reject choice is reported as an `error` event and left open (the turn ends
at its timeout). Work Muse starts itself
(cron firings, monitors, goals, reminder agents) is emitted too, marked
`unattributedReason: "task"` with a `task` lifecycle typed `muse-cron`, `muse-monitor`, ….

Claude Code runs turns of its own too: a background task's notification wakes it into a turn
that answers with its own `result`. Each turn message is written with a `uuid`, so the CLI
reports its `command_lifecycle`; while the message is `queued` behind such a turn, that turn's
frames and result are emitted with `unattributedReason: "foreign-turn"` and the turn settles on
its own result, after the CLI reports the message `started`. Why: matched by stream order alone,
the notification's result closed the turn, and the turn's real answer arrived after it, owned by
nothing (Foundry showed every such reply empty, 2026-11-17).

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
  the control protocol; one the session cannot read is denied. An allow may
  carry `updatedInput`: the call runs with that input (the next gate sees it as
  `toolInput`), and the runtime's own mode still decides whether it runs.
  Foundry uses it to add the chorus's brief to a subagent's prompt. An allow may
  also carry `context`: text the model reads beside the call before it runs
  (PreToolUse `additionalContext`), the call unchanged; several gates' context
  joins in order. Foundry uses it for the chorus's notes at a milestone.
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
- **Held only.** A decision with `heldOnly` never starts a member: with no
  spare holding its standby, or if the held one is lost before delivery, it
  is refused unsent (`DecisionError`, `busy`, `not-dispatched`). A caller that
  would rather skip a decision than wait for a cold start (Foundry's
  per-project Warden host) gets the refusal at once. Only
  `ClaudeInSessionDecisions` reads it.
- **Deadline and abort.** An undelivered decision is refused unsent. A
  delivered one has its member stopped (`stop_task`) before the
  `DecisionError` is thrown, and the error is `settled` when nothing of it
  still runs: the member's task ended (its notification arrived after the
  stop), the member had already answered or never started, or the session
  ended. A `stop_task` ack only accepts the stop, so it does not settle by
  itself. The stop and the wait for the end share one 2 s budget, which can
  hold the rejection up to 2 s. An unacknowledged stop, an acknowledged one
  whose end is never seen within the budget, an orphan (which is never
  stopped) and a member with no task id yet are unsettled. Why: an unsettled
  failure makes a caller treat native state as unknown (Foundry's scheduler
  then closed admission for every decision until restart, 2026-11-16), so a
  member that really ended must say so.
- **Slices.** `dispatchers` (default 1) splits the roles into fixed slices,
  each started by its own dispatcher, so refills are written at once. A
  dispatcher writes one Agent call per member as output tokens: one
  dispatcher refilled 75 members in ~20 s (2026-11-02). A role keeps its
  slice while it is wanted; a new role joins the smallest.
- **Recycle.** A dispatcher's context grows ~700 tokens per member started;
  past `recycleTokens` (100k) a new generation of its slice takes over and
  the old one ends into the root once empty.
- **Orphans.** A nested agent whose parent ended reports its own end to the
  main thread, which wakes the main model (Claude Code 2.1.300). Members of a
  dispatcher that ended unasked are therefore never retired or stopped, and an
  orphan's `answer` call is held for the session's life. Past `maxOrphans`
  (40) `serving()` turns false and `setup` reports `degraded`; `decide()` does
  not refuse on its own, so the caller checks `serving()` and falls back.
- **Limits.** Claude Code runs 20 subagents at once by default; the launch
  raises `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS` to the user's own cap (20 when
  unset) plus `maxSubagents` (76), so 96 by default. The
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

Routing is deterministic over observed limits, priority, leases and health, by a
named strategy (`quartile-balanced` by default, `owner-first`, `priority-balanced`,
`priority-strict`, `least-used`) or an explicit term list; `pinned` restricts it to
the preferred instance. By default stale or unknown limits exclude an instance
(`unknownUtilization: 'rank-last'` ranks it last instead), and every exclusion has a
reason. `continueOn` moves a thread only between
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

## Secret scratch pad

A person can hand an agent a secret as `$$word`. `SecretScratchPad(dir)` lifts it out
of the message before the agent sees it (`lift`), into a private pad per thread
(`<thread>.pad`, 0600 in a 0700 directory), and leaves a reference in its place:
`†<message>.<n>` inside its thread, `†<thread>/<message>.<n>` from anywhere else.
`lift(text, at, { patterns })` also lifts matches of the caller's global regexes, for
tokens the person forgot to mark, and counts them as `recognised`.

The agent uses a value without reading it. `env` sets `KEY=value` in an env file,
`write` puts it in a file, and `pipe` runs a command with the value on its stdin,
from a reference, a key already in an env file, or `{ value }` the host already holds
(its keychain), whose files are held the same way; only the exit code comes back, and
a timeout kills the whole process group. `use(ref, from, fn)` hands the value to
the host's own code (a keychain that stores it), consuming only when `fn` succeeds. `consume` (or `consume: true` on a use)
removes a block, `list` shows what is pending without values, `scrub` swaps held
values in text back to references, and `clear` deletes a pad.

Files `env` and `write` touched are recorded (`heldFiles()`). `privatePathGate`
(or `privatePathDenial` inside your own gate) denies a tool call naming one of them,
a `.private` path, a `privatePaths` glob or the pad directory; `isOwnTool` exempts the
scratch tool's own calls. A `privatePathGate` keeps the `heldFiles` list it was built
with: rebuild it after `env` or `write`, or call
`privatePathDenial(request, { scratchDir: pad.dir, heldFiles: pad.heldFiles() })` in your
own gate on each request. `SECRET_SCRATCH_GUIDANCE` is the text to give the agent.
The gate reads names, not contents, and a pipe command can still copy a value out:
it keeps honest agents from reading secrets, it is not a sandbox. Design and
limits: [tickets/AS-009](tickets/AS-009-secret-scratch-pad.md).

## Roadmap

| Runtime | Status |
|---|---|
| Claude Code | ✅ shipped |
| Codex app-server | ✅ shipped (`CodexAppServerSession`, `CodexPrimedSessions`) |
| Claude Agent SDK | ✅ shipped (`ClaudeAgentSdkSession`; caller supplies `query`) |
| Muse Code | ✅ shipped (`MuseSession`, through `@muse-code/sdk`) |
| ACP agents / direct API | typed stubs |
| Gemini CLI | planned |
| Grok CLI | planned (when its headless/stream mode matures) |

A runtime that reports less produces fewer event types; it never fails a turn for that.

[Subscription pooling goals](tickets/README.md) (AS-001…005) are implemented as described in [docs/transports-pools-routing.md](docs/transports-pools-routing.md); each ticket lists what remains.

## Provenance

Extracted from [`inixiative/foundry`](https://github.com/inixiative/foundry),
where it runs Foundry's agent sessions. Foundry, Oracle, Archive and the
inixiative bench use it.

## License

MIT

## Runtime

Development and new continuation captures use Bun 1.4.4, pinned in `.bun-version` and `package.json`. Historical S0 recordings retain their original Bun 1.3.14 evidence; they are not new 1.4.4 captures.
