# @inixiative/agent-session

Drive coding-agent CLIs as **persistent, streaming, event-captured sessions** —
one interface, any agent. Claude Code today; Codex, Gemini, and Grok planned.

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
console.log(result.tokens);           // { input, output }
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
- **Zero dependencies.** Just Bun + the agent CLI you're driving.

## Interface

`HarnessSession` is the provider-agnostic contract (`start` / `send` / `kill` /
`fork` / `interrupt` + an event handler). `ClaudeCodeSession` implements it over
`claude --print --input-format stream-json --output-format stream-json`.

## Roadmap

| Runtime | Status |
|---|---|
| Claude Code | ✅ shipped |
| Codex CLI (`codex mcp-server`, JSON-RPC) | ✅ shipped (`CodexSession`; `CodexAppServerSession` experimental) |
| Gemini CLI | planned |
| Grok CLI | planned (when its headless/stream mode matures) |

Opaque runtimes degrade gracefully — fewer event types, never a hard failure.

## Provenance

Extracted from [`inixiative/foundry`](https://github.com/inixiative/foundry),
where this drives the Artificer session. Consumed by foundry, foundry-oracle,
and the inixiative bench.

## License

MIT
