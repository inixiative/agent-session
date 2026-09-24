# Transports, primed sessions, pools and routing

Status: implemented in 0.2.0. Verified against codex-cli 0.155.1, claude 2.1.281 and
@anthropic-ai/claude-agent-sdk 0.3.281 on 2026-09-24.

## Ownership

- **agent-session** owns sessions, how they reach a model (transports), pools of
  subscription instances, routing across them, limit polling and continuity.
- **Foundry** decides which work needs what: roles, priorities, prompts, what is primed.
- **Kingdom/Kastle** owns authority and capacity accounting: which instances,
  organizations and preferences a caller may use. Routing never widens a grant.

## Transports

How a session reaches its model is a transport. Every transport implements the
same `HarnessSession` contract, so changing how a model is reached (for example
if native subscription use is withdrawn) is a routing change: pick another
`kind` in `createSession(kind, config)` or in a pool instance.

Each transport declares its real capabilities (`TRANSPORTS[kind].capabilities`),
describing this package's implementation rather than the runtime in principle.
Callers branch on capabilities, not on kinds.

| Capability | claude-cli | codex-mcp | codex-app-server | claude-agent-sdk | acp | api |
|---|---|---|---|---|---|---|
| Status | implemented | implemented | implemented | implemented | **stub** | **stub** |
| Verified | live | live | live | live | none | none |
| Resume by ID in a new process | native | loaded-only | native | native | – | – |
| Fork | native | same-thread | none | native | – | – |
| Rollback | none¹ | none | none² | none | – | – |
| Interrupt | acknowledged | local-only | acknowledged | acknowledged | – | – |
| Mid-turn push | none | none | steer | none | – | – |
| Approvals | mode | mode | refuse | callback | – | – |
| Usage per turn | yes | yes | yes | yes | – | – |
| Limits: stream / poll | yes / yes | no / no | yes / yes | yes / no | – | – |
| Text-only session | yes | no | no³ | yes | – | – |
| Primed reset | fork | none | fork | none | – | – |
| Billing | subscription | subscription | subscription | subscription | subscription | api |

¹ `--resume-session-at` exists natively but is not wired.
² codex-cli 0.155.1 refuses `thread/rollback` for ephemeral threads ("requires persisted
thread history") and for persisted ones ("paginated threads do not support thread/rollback").
³ `CodexAppServerSession` runs with the profile's tools; tool-free text sessions on this
transport are `CodexPrimedSessions` (the "Primed reset" row).

New optional `HarnessSession` members (existing implementers and consumers are unaffected):

- `transport` — the descriptor above.
- `interruptNative()` — asks the runtime to stop the turn and waits for its own
  terminal. Claude uses the CLI control protocol (`control_request: interrupt`),
  app-server uses `turn/interrupt`, the SDK uses `Query.interrupt()`. Unlike
  `interrupt()`, a confirmed stop settles native ownership.
- `readLimits()` — account limits without a model turn: Claude `get_usage`
  control request, Codex `account/rateLimits/read`.
- `push()` on app-server steers the owned in-flight turn (`turn/steer`); a refusal
  records `push_ignored`, no answer within 10 s records `push-unknown`.
- `rate_limit` events with `limits` (from Claude `rate_limit_event` and Codex
  `account/rateLimits/updated`). They are account-level (`unattributedReason:
  "account-status"`) and never part of an admission's output.

Stubs: `AcpSession` and `ApiSession` are typed and throw `TransportUnavailableError`.
No ACP agent is available locally to verify a client against, and the direct API
transport requires an explicit opt-in (`allowApiBilling: true`) and is not built.
Subscription transports never fall back to either.

### Agent SDK transport

`ClaudeAgentSdkSession` takes `query` from `@anthropic-ai/claude-agent-sdk` from
the caller (this package keeps zero dependencies). It feeds SDK `query()` through
a process-shaped bridge, so ClaudeCodeSession's classification, admission and
ownership evidence apply unchanged; the CLI argv is mapped to SDK options
(`sdkOptionsFromArgv`), with unmapped flags in `extraArgs`. It adds per-call
approvals (`canUseTool`). The SDK Query API exposes no `get_usage`, so limit
polling is refused on this transport (limits still stream). `kill()` calls
`Query.close()`, and the session reports exit only when the SDK stream ends.

## Primed decision sessions

One live, warm session per middleware role. The key is Foundry's auxiliary
session identity (`${threadId}:aux:${role}`), optionally extended with a phase
tag when one role runs under several instructions.

- **Prime** once: role instructions (developer/system role) plus the stable
  context (layer content, user role, as data). That primed state is the cached prefix.
- **Per cycle**: branch from the primed state, run the decision, discard the
  branch. One cycle never sees another's turns.
- **Re-prime** only when the prime hash changes (default: sha256 of
  instructions and context; callers pass layer content hashes), after idle
  eviction, or after process loss. Those are the only cold paths.

| | Codex (`CodexPrimedSessions`) | Claude (`ClaudePrimedSessions`) |
|---|---|---|
| Process | one `codex app-server` per account hosts every key as a thread | one CLI process per conversation |
| Prime | persisted `thread/start` + primer turn | persisted text-only session + primer turn |
| Reset | `thread/fork` (ephemeral) through the primer turn, restating the instructions | `--resume <primed> --fork-session --no-session-persistence` |
| Warm path | fork ≈ 60–90 ms, then the turn | pre-spawned spare fork: no process start |
| Cleanup | fork unsubscribed; primed thread deleted on eviction/close; orphans in the private cwd swept at start | forks write no history; the primed transcript is deleted on eviction/close, and leftovers for the private cwd are swept on first use |
| Text-only | features, plugins, MCP (node_repl), notify, tool instructions disabled at launch; read-only sandbox; approvals never | `--safe-mode --tools "" --strict-mcp-config …` |
| Violations | non-text item, MCP startup or server request → interrupt, recycle process | tool activity → decision fails |

Why fork and not rollback: codex-cli 0.155.1 refuses rollback on both thread
kinds (above), and ephemeral threads cannot be forked ("no rollout found"), so
the primed thread is persisted and each cycle forks it. A fork that does not
restate `baseInstructions`/`developerInstructions` runs on Codex's default
prompt (10.8k instead of 6.6k input tokens) and misses the cache.

A violation or an unacknowledged interrupt recycles the Codex process: every
decision in flight on it fails at once (`transport`), and the next decision on
each key re-primes on a fresh process.

Decisions are serialized per key and bounded across keys (`maxConcurrent`).
`onAdmission` runs before the native write; `DecisionError` states whether
anything was dispatched and whether the turn is settled (terminal observed or
process exit observed). Blocked limits refuse before dispatch; there is no
fallback and no retry.

### Live measurements (2026-09-24, this machine)

`bun scripts/measure-primed.ts --runs 5 --model gpt-6-luna --effort low --claude haiku`,
a 150-rule domain context and a one-line question per decision:

| Path | Warm latency (median, range) | Input tokens | Cached |
|---|---|---|---|
| `codex exec --ephemeral` per decision (Foundry today, without its per-call `codex login status`) | 3.9 s (3.6–8.0 s) | 11,299 | 5,888–11,008 |
| Codex primed (fork per cycle) | 2.45 s (2.4–4.0 s) | 7,416 | 1,792–6,912 |
| Claude primed, haiku (spare fork per cycle) | 1.95 s (1.8–2.4 s) | 7,110 | 7,100 |

Cold primes: Codex 2.8–12.8 s, Claude 4.6–6.7 s (one extra model turn).
Codex turn time is dominated by the model (≈2.3–2.6 s at `low`); the branch
itself costs 55–90 ms. Codex prefix-cache hits vary between runs (the provider
keys its cache per conversation); Claude reads the whole primed prefix every time.

## Pools, routing, limits, continuity

`SubscriptionPool` treats each login as an **instance** of a transport:
`{ id, transport, profileDirectory (CODEX_HOME / CLAUDE_CONFIG_DIR), continuationKey,
organizationIds, models, concurrencyLimit }`.

- **Routing** (`rankCandidates`, ported from Foundry's draft account-routing policy
  a60c664): deterministic, from observed limits, active leases and local health.
  Strategies: `quartile-balanced` (default), `owner-first`, `pinned`. Unknown,
  stale, future or reset-crossing observations exclude an instance; every
  exclusion carries a reason (`PoolExhaustedError.excluded`). The draft's
  repository entry point `rankSubscriptionAccounts` and `repositoryIdentity` are
  kept intact with its tests.
- **Limits**: `open()` refreshes instances whose limits are missing, older than
  the observation age, past a window reset, or blocked past their cooldown, with
  `probeCodexLimits` / `probeClaudeLimits` (no model turn). A poll that fails or
  returns nothing is not repeated for `probeCooldownMs`. Sessions opened by the pool
  feed their `rate_limit` events back. A window without a reported reset time counts
  as current.
- **Leases** end when the session ends, is killed (even before start) or fails to
  start; a session whose lease ended cannot restart outside the pool. The profile
  variable is always pinned, so caller env cannot move a leased session to another login.
- **Health**: `reportFailure` cools an instance down (doubling, max 10 min); a
  completed turn clears it.
- **Continuity** (`continueOn`): a thread moves to another instance only when both
  transports resume natively, the instances share a continuation key and the old
  session has no native work of unknown outcome. The default key is the native
  history home (`codex:home:<dir>`, `claude:home:<dir>`), so two logins share
  continuity only where the caller arranged shared history. Refusals are explicit
  (`ContinuityError.reason`). Moving between providers is not continuity.
- **Attribution**: pool events (`allocated`, `released`, `limits`, `failure`,
  `exhausted`, `handoff`, `handoff-refused`) name instances and leases, never credentials.

## Migration notes for Foundry

- Decisions: replace per-decision `codex exec` with one `CodexPrimedSessions`
  per decision profile. Key by auxiliary session id + a hash of the role
  instructions (advice and guard share an aux id with different prompts). Prime
  with the role instructions and the stable layer content; send only the
  per-cycle input. Keep the scheduler's priority and fairness; its concurrency is
  now turns on one warm process, not processes.
- Account routing: use `SubscriptionPool` / `rankCandidates` rather than landing
  the draft `routing/subscription-routing.ts` in Foundry.
- Existing `ClaudeCodeSession`/`CodexSession` behavior is unchanged unless the new
  options are used; `interrupt()` still only releases the local waiter.
