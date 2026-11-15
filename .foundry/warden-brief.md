# agent-session, for its Wardens

agent-session (`@inixiative/agent-session`) drives coding-agent runtimes (Claude Code, Codex, Muse
Code) as persistent, streaming, event-captured sessions behind one contract, `HarnessSession`,
over transports with declared capabilities. It also holds warm primed decision sessions,
subscription pools with deterministic routing, limit polling, continuity and the secret scratch
pad. It is a published Bun/TypeScript package shipped as source; Foundry, Oracle, Archive and the
bench run their agent sessions on it. How subscription logins and capacity are held is decided in
`docs/rules/subscriptions-and-capacity.md` (the docs repo); a change that contradicts it goes to
Aron first.

## Shape of the repository

- Entries (`package.json` exports): `.` (`src/index.ts`, a barrel over every module) and
  `./routing` (`src/routing.ts`, also re-exported from `.`).
- Sessions: `claude-code-session.ts` (the `claude` CLI, stream-json), `claude-agent-sdk-session.ts`
  (the caller supplies the SDK's `query`), `codex-session.ts` (`codex app-server`, over
  `json-rpc.ts`), `muse-session.ts` (`muse serve` through `@muse-code/sdk`). `transport.ts` declares
  each transport's capabilities; `transports.ts` has `createSession` and the `acp`/`api` stubs.
- Primed decisions: `primed.ts` (the contract), `codex-primed.ts`, `claude-primed.ts`,
  `claude-subagents.ts`, `claude-in-session.ts`.
- Capacity: `limits.ts`, `limits-probe.ts`, `routing.ts`, `pool.ts`. Secrets: `secret-scratch.ts`.
- Not exported: `turn-state.ts`, `tool-gate.ts`, `retained-evidence.ts`.
- Docs: `README.md` and `docs/transports-pools-routing.md` are current; `tickets/` are work items;
  `fixtures/**/README.md` are recording history.
- Check: `bun run check` (`tsc --noEmit`, `biome check .`, `bun test`). Every test runs against
  scripted fakes or recorded fixtures; none needs a live login.

## Rules that hold everywhere

- Subscription billing only by default: API keys are stripped from Claude and Codex children,
  Muse bills its saved login, `allowedBilling` defaults to `['subscription']`, and no transport
  falls back to the `api` stub.
- Callers branch on `TRANSPORTS[kind].capabilities`, never on the kind. A capability is declared
  for this package's implementation, not for the runtime in principle.
- Subagent, account-limit and Muse-initiated events are never part of a turn's result
  (`unattributedReason`).
- Admission evidence is honest: a send states whether anything was dispatched and whether the
  native turn settled; there is no silent retry or fallback.
- Pool events and errors name instances and leases, never credentials; the scratch pad never
  returns a value.

## Words used here

session, turn, admission, native binding, transport, capability, steer, push, interrupt, tool gate,
pre-use, permission, subagent, task, primed session, prime, decision, fork, spare, standby,
dispatcher, side session, group, limit snapshot, window, probe, instance, lease, pool, ordering,
strategy, quartile, eligibility, continuity, continuation key, scratch pad, dagger, reference, held
file.
