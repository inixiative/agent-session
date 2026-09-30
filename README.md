# @inixiative/agent-session

Drive coding-agent CLIs as **persistent, streaming, event-captured sessions** —
one interface, any agent, over interchangeable **transports**. Claude Code
(CLI or Agent SDK) and Codex (MCP or app-server) today; Gemini and Grok planned.
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
- **fork / resume / interrupt** and pre-send hooks (rewrite the outgoing
  message — e.g. inject just-in-time context per turn).
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

const kind = "codex-app-server";            // or claude-cli, claude-agent-sdk, codex-mcp
if (TRANSPORTS[kind].capabilities.interrupt === "acknowledged") { /* … */ }
const session = createSession(kind, { cwd, model: "gpt-6-luna", env: { CODEX_HOME: profile } });
```

| | claude-cli | codex-mcp | codex-app-server | claude-agent-sdk | acp | api |
|---|---|---|---|---|---|---|
| Status | ✅ live | ✅ live | ✅ live | ✅ live | stub | stub |
| Resume / fork | native / native | loaded-only / same-thread | native / – | native / native | – | – |
| Interrupt | acknowledged | local-only | acknowledged | acknowledged | – | – |
| Push | – | – | steer | – | – | – |
| Approvals | mode | mode | refuse | callback | – | – |
| Limits stream / poll | ✅ / ✅ | – / – | ✅ / ✅ | ✅ / – | – | – |
| Primed reset | fork | – | fork | – | – | – |

Full matrix, notes and what is stubbed: [docs/transports-pools-routing.md](docs/transports-pools-routing.md).

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

Codex hosts every key as a thread of one `app-server` process per account and
forks the primed thread per cycle; Claude forks a persisted primed session with
a pre-spawned spare. Measured on a ChatGPT login: warm Codex decisions 2.45 s
median vs 3.9 s for `codex exec` per decision, with 34% fewer input tokens; warm
Claude (haiku) decisions 1.95 s with the whole primed prefix read from cache.

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
| Codex CLI (`codex mcp-server`, JSON-RPC) | ✅ shipped (`CodexSession`) |
| Codex app-server | ✅ shipped (`CodexAppServerSession`, `CodexPrimedSessions`) |
| Claude Agent SDK | ✅ shipped (`ClaudeAgentSdkSession`; caller supplies `query`) |
| ACP agents / direct API | typed stubs |
| Gemini CLI | planned |
| Grok CLI | planned (when its headless/stream mode matures) |

Opaque runtimes degrade gracefully — fewer event types, never a hard failure.

[Subscription pooling goals](tickets/README.md) (AS-001…005) are implemented as described in [docs/transports-pools-routing.md](docs/transports-pools-routing.md); each ticket lists what remains.

## Provenance

Extracted from [`inixiative/foundry`](https://github.com/inixiative/foundry),
where this drives the Artificer session. Consumed by foundry, foundry-oracle,
and the inixiative bench.

## License

MIT

## Runtime

Development and new continuation captures use Bun 1.4.2, pinned in `.bun-version` and `package.json`. Historical S0 recordings retain their original Bun 1.3.14 evidence; they are not new 1.4.2 captures.
