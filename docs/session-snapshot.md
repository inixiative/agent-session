# Keeping a Claude session across a host restart

A host (Foundry's daemon) can restart without stopping the Claude Code sessions it runs. Each CLI
is started through a **keeper**: a small detached process that owns the CLI's pipes. When the host
goes down, the CLI keeps working unwrapped. The new host process reattaches and carries on with
the same native session. Why: a restart for a Foundry-only change used to stop every running turn
(Aron, 2026-11-18, R-2026-11-18-05: "turn off the Foundry stuff that wraps it, and let the thread
run, and then pick it up again").

```
host ──unix socket── keeper ──pipes── claude CLI
```

Only the `claude-cli` transport can do this (`TransportCapabilities.survivesHostRestart`). A
session with an extension cannot, because its MCP servers live in the host process, so `detach()`
refuses it.

## The sequence

```ts
// Old host process
let proc: KeeperSubprocess | undefined;
const session = new ClaudeCodeSession({
  ...config,
  spawn: (cmd, opts) => (proc = spawnThroughKeeper(cmd, opts, { configDir, beatPath })),
});
// ...on restart:
const snapshot = await session.detach({ orphanDeadlineMs: 10 * 60_000 });
await Bun.write(path, JSON.stringify({ snapshot, keeper: proc?.keeper }));

// New host process
const { snapshot, keeper } = await Bun.file(path).json();
const again = await attachKeeper({ socketPath: keeper.socketPath, token: keeper.token });
const session = ClaudeCodeSession.fromSnapshot(snapshot, config);
session.onToolRequest(gate);          // gates first: resume raises pending approvals at once
session.resume(again);
const result = await session.adoptedTurn; // the turn that was running, if one was
```

`detach()`:

1. Returns every queued `send()` with a `SessionTurnError` whose cause is `SessionReturned` (its
   attempt's `localFailure` is `'returned'`). The host sends those again after the restart.
2. Waits up to `drainMs` (default 5 s) for every stdin write to reach the CLI's pipe. If one
   doesn't, it throws and the session keeps running attached.
3. Detaches the keeper with `orphanDeadlineMs` and processes every line already handed out, so
   the snapshot's `offset` is exact.
4. Withdraws each approval still waiting (its `ToolRequest.signal` aborts) and stores the request
   in `pendingControl`. The CLI is still waiting for the answer, so the new owner asks again.
5. Rejects the running `send()` with a `SessionTurnError` whose cause is `SessionDetached`
   (`localFailure: 'detached'`). The turn keeps running in the CLI. The new process settles it
   as `adoptedTurn`, under the same admission id.

It emits no `session_end`. The new session emits `session_start` with `raw: { resumed: true }`.

`resume(proc)` releases the keeper after the snapshot's offset. It replays `liveTasks` (so a new
owner learns the tasks still running), raises `pendingControl` again, and goes live. Two cases
are denied rather than guessed:

- A `can_use_tool` request raised again when no gate is registered is denied.
- A `hook_callback` this session has no gate for is denied before the tool runs.

## The snapshot

Plain JSON, `snapshotVersion: 1` (`CLAUDE_SESSION_SNAPSHOT_VERSION`). It holds state, never
configuration: `fromSnapshot` takes the session's own config again.

| Field | What it is |
|---|---|
| `snapshotVersion` | The shape's version. `fromSnapshot` refuses any other. |
| `externalSessionId` | The native session id. |
| `hookCallbackId` | The id the CLI's hook callbacks carry, so the new session can answer them. |
| `cliPid` | The kept CLI's pid. |
| `offset` | The last keeper frame this session processed. The new process reads from the next one. |
| `promptUuids`, `promptLifecycleSeen`, `steerUuids` | Which messages and steers the CLI has acknowledged. |
| `seenTerminals`, `seenBoundaries` | Results and turn boundaries already handled, so a replay doesn't handle them twice. |
| `liveTasks` | The `task_started` frames of tasks still running. |
| `pendingControl` | Approvals asked and not answered. |
| `inflight` | The running turn: `admissionId`, `identity`, `content` so far, `tokens`, `timeout`, its `prompt` and `steers` state, `held` (a result that arrived but was held back), `modelMissing`. |
| `wake`, `wakeCause` | A turn the CLI started by itself (see the README's wake section). |
| `turns`, `totalTokens` | The session's counters. |
| `baseContextDir` | The private directory holding the session's system-prompt file. |

`tests/fixtures/claude-snapshot.json` pins the key sets for each version. A test fails when the
type changes and the fixture doesn't. A released version's entry never changes: a new shape is a
new version.

`package.json` records what this build speaks, so a host can check before it restarts onto a
new build:

```json
"inixiative": { "keeperProtocol": 1, "attachCompat": 1 }
```

`keeperProtocol` is `KEEPER_PROTOCOL`. `attachCompat` is the snapshot version this build reads.
It is the same number as `CLAUDE_SESSION_SNAPSHOT_VERSION`, not a second constant. A host
restarts onto a build only when both match. Otherwise it falls back to the pause-and-resume
restart.

## The keeper

One keeper per CLI (`src/keeper/keeper.ts`). It does no session work. The only thing it reads is
the subtype of each control request, so it can count the approvals waiting while no host is
attached. It never answers one.

- **Protocol** (`KEEPER_PROTOCOL = 1`, one JSON object per line, `tests/fixtures/keeper-framing.json`).
  The host sends `auth`, `release`, `hold`, `ack`, `in`, `inEnd`, `kill` and `deadline`. The
  keeper sends `hello`, the numbered stream frames `out`, `err` and `exit`, then `inAck`, `held`
  and `refused`.
- **Auth.** A token in the launch, compared in constant time. One host at a time: a second is
  refused. The socket is mode 0600.
- **The stream.** Every stdout line, stderr line and the exit code is numbered and held in memory
  from the last acked frame. The client acks a frame once it has handed it out. Past
  `spoolMaxBytes` (default 64 MiB) the keeper stops reading the CLI's pipes. The CLI's own writes
  then stall and nothing is dropped.
- **Orphan deadline.** With no host attached, the keeper ends the CLI after the deadline (default
  10 minutes; `detach` sets it). A fresh heartbeat file (`beatPath`, touched by the host's
  supervisor in the last 90 s) keeps it waiting. Why: a host that never comes back must not
  leave CLIs running for ever.
- **Exit.** Once the exit frame is acked, the keeper removes its socket and the launch's
  `cleanup` paths, then exits.

The sweeper (`sweepOrphanedBaseContexts`) keeps a base-context directory whose `owner` file
names a live pid. `detach` writes the kept CLI's pid there, because the directory is named for
the host process that started it.

## Known limits

- An approval answered by the gate while `detach` is waiting for stdin to drain stays in the
  session if the drain then times out. The session is still attached and running, so that
  approval is answered as usual.
- Replaying `liveTasks` emits their `started` events again. This is intended: the new owner has
  never seen them.
- An approval left unanswered holds the CLI's call while no host is attached. Run
  `bun run probe:keeper` against each new CLI version; it checks this and a turn that finishes
  while detached. Passed on Claude Code 2.1.327 (2026-11-18, 20 s away).
