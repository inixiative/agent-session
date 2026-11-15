# agent-session glossary

**Every term agent-session's region Wardens use, alphabetical, each with the region that holds it.**

<!-- Generated with the region Warden docs by the region pipeline's assemble.py. A term defined by two regions appears once per region. -->

---

## A

**account-limits**  
Class: LimitSnapshot, the per-runtime snapshot parsers, mergeLimits/limitUtilization and the no-turn limit probes. *Region:* [Pools, routing and account limits](pools-routing-limits/knowledge.md)

**admission-evidence**  
Class tag: per-turn admission evidence and typed turn failures. *Region:* [HarnessSession contract and events](session-contract/knowledge.md)

**allowApiBilling**  
Explicit opt-in the api transport requires; the transport is still not built. *Region:* [Transports and runtime sessions](transports/knowledge.md)

**allowedBilling**  
Billing modes that may serve; default ['subscription'], anything else excluded as billing. *Region:* [Pools, routing and account limits](pools-routing-limits/knowledge.md)

**approvalsReviewer**  
Pinned to 'user' on gated Codex threads; a config routing elsewhere is refused. *Region:* [Transports and runtime sessions](transports/knowledge.md)

## B

**BeforeSendHook**  
Pre-send hook that rewrites the outgoing message, e.g. to add per-turn context. *Region:* [HarnessSession contract and events](session-contract/knowledge.md)

## C

**call.signal**  
Aborts when the runtime withdraws the request or the session ends. *Region:* [Tool gates and secret scratch pad](tool-gates-and-secrets/knowledge.md)

**capabilities**  
What this package's implementation of a kind supports: resume, fork, rollback, interrupt, push, approvals, usage, limits, images, text-only, primed reset, billing. *Region:* [Transports and runtime sessions](transports/knowledge.md)

**CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS**  
Claude Code's concurrent subagent cap, raised by ClaudeInSessionDecisions to the user's cap (20 when unset) plus maxSubagents (76). *Region:* [Primed decision sessions](primed-decisions/knowledge.md)

**CLAUDE_TEXT_ONLY_ARGS**  
Read-only list of the flags textOnly: true adds for a tool-free Claude session. *Region:* [Transports and runtime sessions](transports/knowledge.md)

**ClaudeAgentSdkSession**  
Claude through a caller-supplied Agent SDK query via a process-shaped bridge. *Region:* [Transports and runtime sessions](transports/knowledge.md)

**ClaudeCodeSession**  
Drives the claude CLI over stdin/stdout stream-json with the control protocol. *Region:* [Transports and runtime sessions](transports/knowledge.md)

**CodexAppServerSession**  
Codex over codex app-server --listen stdio://; runs with the profile's tools. *Region:* [Transports and runtime sessions](transports/knowledge.md)

**codexPermissions**  
Maps a host permission mode to Codex approvalPolicy and sandbox. *Region:* [Transports and runtime sessions](transports/knowledge.md)

**codexTokens**  
Converts Codex tokenUsage.last into SessionTokens, excluding cached input. *Region:* [HarnessSession contract and events](session-contract/knowledge.md)

**cold miss**  
Codex: a key with no primed thread runs the decision inline on a fresh thread and primes in the background. *Region:* [Primed decision sessions](primed-decisions/knowledge.md)

**consume / list / scrub / clear**  
Remove a block, summarise what is pending per thread (never values), swap values back to references, delete a pad. *Region:* [Tool gates and secret scratch pad](tool-gates-and-secrets/knowledge.md)

**continuationKey**  
Instances sharing it share native history; default codex:home:<dir> or claude:home:<dir>. *Region:* [Pools, routing and account limits](pools-routing-limits/knowledge.md)

**continueOn**  
Moves a thread to another instance only when continuity holds; a refusal is a ContinuityError with a reason. *Region:* [Pools, routing and account limits](pools-routing-limits/knowledge.md)

**createSession**  
Builds a HarnessSession for a kind from that kind's config. *Region:* [Transports and runtime sessions](transports/knowledge.md)

**cycle**  
One decision on a branch of the primed state, discarded afterwards; no cycle sees another's turns. *Region:* [Primed decision sessions](primed-decisions/knowledge.md)

## D

**DecisionError**  
A failed decision: reason, dispatch ('not-dispatched' or 'attempted') and whether the turn is settled. *Region:* [Primed decision sessions](primed-decisions/knowledge.md)

**DecisionRequest**  
Per-decision input: input, timeoutMs, signal, onAdmission, outputSchema (Codex), group (ClaudeSubagentSessions) and standby (both Claude subagent implementations). *Region:* [Primed decision sessions](primed-decisions/knowledge.md)

**dispatcher generation**  
ClaudeInSessionDecisions: a foundry-dispatch agent that starts members, replaced once its context passes recycleTokens. *Region:* [Primed decision sessions](primed-decisions/knowledge.md)

## E

**env / write / pipe**  
Use a held value in an env file, a file, or a command's stdin; pipe returns only the exit code. *Region:* [Tool gates and secret scratch pad](tool-gates-and-secrets/knowledge.md)

**exclusion reason**  
Why a candidate is ineligible (billing, not-pinned, stale-observation, exhausted, blocked, invalid, occupied, …), on PoolExhaustedError.excluded. *Region:* [Pools, routing and account limits](pools-routing-limits/knowledge.md)

**externalSessionId**  
Session config field used to resume a native conversation by id in a new process. *Region:* [HarnessSession contract and events](session-contract/knowledge.md)

## F

**fan-out**  
ClaudeSubagentSessions: one dispatcher turn calling Agent once per batched member, each prompt replaced by a PreToolUse hook. *Region:* [Primed decision sessions](primed-decisions/knowledge.md)

**first deny wins**  
Gates run in registration order; any deny or throw denies the call. *Region:* [Tool gates and secret scratch pad](tool-gates-and-secrets/knowledge.md)

## H

**HarnessSession**  
The provider-agnostic session interface every transport implements: start, send, kill, fork, interrupt, push, onEvent, onBeforeSend, artifact() and the alive / externalSessionId / events / turns / totalTokens fields; transport, interruptNative, readLimits, stopTask, inspectAttempt and onToolRequest are optional. *Region:* [HarnessSession contract and events](session-contract/knowledge.md)

**headroom**  
concurrencyLimit minus active runs. *Region:* [Pools, routing and account limits](pools-routing-limits/knowledge.md)

**health cooldown**  
Set by reportFailure(instanceId, kind), kind 'rate-limited' | 'auth' | 'transport' | 'probe': 60 s doubling to at most 10 min; cleared by reportSuccess, which a completed turn calls. *Region:* [Pools, routing and account limits](pools-routing-limits/knowledge.md)

**hedgeAfterMs**  
Codex only: after this delay the same input starts on a second branch; the first to finish wins. *Region:* [Primed decision sessions](primed-decisions/knowledge.md)

**heldFiles()**  
Files env and write touched, re-read on each call; a privatePathGate keeps the list it was built with. *Region:* [Tool gates and secret scratch pad](tool-gates-and-secrets/knowledge.md)

## I

**instance**  
One login of a transport in a pool: id, transport, profileDirectory, continuationKey, organizationIds, models, concurrencyLimit, priority. *Region:* [Pools, routing and account limits](pools-routing-limits/knowledge.md)

**interrupt()**  
Releases the local waiter only; does not settle native ownership. *Region:* [HarnessSession contract and events](session-contract/knowledge.md)

**interruptNative()**  
Asks the runtime to stop and waits for its own terminal; a confirmed stop settles native ownership. *Region:* [HarnessSession contract and events](session-contract/knowledge.md)

**isOwnTool**  
Option exempting the scratch tool's own calls from the private-path gate. *Region:* [Tool gates and secret scratch pad](tool-gates-and-secrets/knowledge.md)

**isPrivatePath**  
Bare test whether a path is .private or matches the given globs. *Region:* [Tool gates and secret scratch pad](tool-gates-and-secrets/knowledge.md)

## J

**JsonRpcConnection**  
Low-level JSON-RPC over a child process, used by CodexPrimedSessions and probeCodexLimits; CodexAppServerSession does not use it. *Region:* [Transports and runtime sessions](transports/knowledge.md)

## L

**lease**  
The pool's hold on an instance for one session; ends when the session ends, is killed or fails to start. *Region:* [Pools, routing and account limits](pools-routing-limits/knowledge.md)

**least-used**  
Strategy: utilization only. *Region:* [Pools, routing and account limits](pools-routing-limits/knowledge.md)

**lift**  
Moves marked secrets and caller-pattern matches out of a message, counting pattern hits as recognised. *Region:* [Tool gates and secret scratch pad](tool-gates-and-secrets/knowledge.md)

**limit window**  
One rolling or weekly bucket in a snapshot; one without a reported reset counts as current. *Region:* [Pools, routing and account limits](pools-routing-limits/knowledge.md)

**LimitSnapshot**  
An account's normalised rate-limit windows, each with used percent and reset time. *Region:* [Pools, routing and account limits](pools-routing-limits/knowledge.md)

## M

**†<message>.<n>**  
Scratch reference in-thread; †<thread>/<message>.<n> from elsewhere. *Region:* [Tool gates and secret scratch pad](tool-gates-and-secrets/knowledge.md)

**MUSE_SDK_VERSION**  
The pinned Muse SDK/CLI version (1.4.20); another host version is refused at start. *Region:* [Transports and runtime sessions](transports/knowledge.md)

**musePermissions**  
Maps a host mode to an explicit Muse permission profile; MuseSession applies it to its permissionMode config (default 'default', gated). *Region:* [Transports and runtime sessions](transports/knowledge.md)

**MuseSession**  
Muse Code over muse serve through the pinned @muse-code/sdk. *Region:* [Transports and runtime sessions](transports/knowledge.md)

## N

**nativeBindingMissing**  
Finds a NativeBindingMissingError on an error or up to four causes deep, including as a turn error's cause. *Region:* [HarnessSession contract and events](session-contract/knowledge.md)

**NativeBindingMissingError**  
Raised when a resume finds no native transcript, rollout or Muse session; no turn ran. *Region:* [HarnessSession contract and events](session-contract/knowledge.md)

## O

**observation age**  
How old limits may be before open() refreshes them; 15 min by default. *Region:* [Pools, routing and account limits](pools-routing-limits/knowledge.md)

**onAdmission**  
Callback run before the native write, so the caller can register the admission. *Region:* [Primed decision sessions](primed-decisions/knowledge.md)

**onToolRequest**  
Optional session member registering a gate for each tool call; throws unless the session was launched for callbacks (Claude toolGate: true, Codex approvalPolicy on-request or untrusted, Muse any permissionMode but bypassPermissions). Returns an unregister function. *Region:* [Tool gates and secret scratch pad](tool-gates-and-secrets/knowledge.md)

**onUserInput**  
MuseSession handler for questions Muse raises; unanswered ones are cancelled with a reason. *Region:* [Transports and runtime sessions](transports/knowledge.md)

**OrderBy terms**  
json-rules { field, dir }[] ordering, the same type Kingdom stores on a capacity pool, evaluated by orderRecords. *Region:* [Pools, routing and account limits](pools-routing-limits/knowledge.md)

**ordering fields**  
priority, utilization, quartile, headroom and preferred, each with a natural direction; rankCandidates appends id as the final term. *Region:* [Pools, routing and account limits](pools-routing-limits/knowledge.md)

**orphan**  
An in-session member whose dispatcher ended unasked; never retired, its answer call held for the session's life, capped by maxOrphans. *Region:* [Primed decision sessions](primed-decisions/knowledge.md)

**owner-first**  
Strategy: preferred, utilization; a preferred instance with an unknown reading is tried first. *Region:* [Pools, routing and account limits](pools-routing-limits/knowledge.md)

## P

**parentToolUseId**  
The parent tool call that spawned a subagent (Claude parent_tool_use_id, Codex spawnAgent). *Region:* [HarnessSession contract and events](session-contract/knowledge.md)

**parseClaudeUsage**  
Turns a Claude usage payload into SessionTokens. *Region:* [HarnessSession contract and events](session-contract/knowledge.md)

**parseScratchRef / formatScratchRef**  
Read and write scratch references. *Region:* [Tool gates and secret scratch pad](tool-gates-and-secrets/knowledge.md)

**permission**  
Stage for an ask the runtime's mode raised; the answer is final, no gate means denied. *Region:* [Tool gates and secret scratch pad](tool-gates-and-secrets/knowledge.md)

**perTaskStopAffordance**  
Declared by ClaudeCodeSession when an extension is attached, so the user's Stop spares background agents. *Region:* [Primed decision sessions](primed-decisions/knowledge.md)

**pinned**  
Eligibility filter with preferredInstanceId (preferredId in routing): every other instance is excluded as not-pinned. *Region:* [Pools, routing and account limits](pools-routing-limits/knowledge.md)

**pool events**  
allocated, released, limits, failure, exhausted, handoff, handoff-refused; they name instances and leases, never credentials. *Region:* [Pools, routing and account limits](pools-routing-limits/knowledge.md)

**pre-use**  
Claude-only stage before every call in every mode; only a deny counts. *Region:* [Tool gates and secret scratch pad](tool-gates-and-secrets/knowledge.md)

**prime**  
The one cold step: role instructions plus stable context and a primer turn, which becomes the cached prefix. *Region:* [Primed decision sessions](primed-decisions/knowledge.md)

**primed key**  
Foundry's auxiliary session identity ${threadId}:aux:${role}, optionally with a phase tag. *Region:* [Primed decision sessions](primed-decisions/knowledge.md)

**primed-claude**  
Class: ClaudePrimedSessions, a persisted primed Claude session resumed with --fork-session per cycle from a pre-spawned spare. *Region:* [Primed decision sessions](primed-decisions/knowledge.md)

**primed-claude-in-session**  
Class: ClaudeInSessionDecisions, roles as subagents inside the main ClaudeCodeSession: dispatchers, recycle, orphans, subagent cap. *Region:* [Primed decision sessions](primed-decisions/knowledge.md)

**primed-claude-subagents**  
Class: ClaudeSubagentSessions, roles as subagents of a dedicated CLI process per group, fan-out batching, side sessions, standby spares. *Region:* [Primed decision sessions](primed-decisions/knowledge.md)

**primed-codex**  
Class: CodexPrimedSessions, one app-server per account, thread/fork per cycle, private CODEX_HOME, hedging and service tier. *Region:* [Primed decision sessions](primed-decisions/knowledge.md)

**primed-contract**  
Class: the PrimedSessions contract every implementation shares: decide, evict, limits, snapshot, close, branch per cycle, re-prime by primeHash, DecisionRequest and DecisionError. *Region:* [Primed decision sessions](primed-decisions/knowledge.md)

**PrimedSessions**  
The contract in src/primed.ts: decide(spec, request), evict(key), limits(), snapshot(), close(), optional prestart/releaseGroup; prime(spec) is CodexPrimedSessions only, and maxConcurrent / maxBackgroundPrimes are implementation config. *Region:* [Primed decision sessions](primed-decisions/knowledge.md)

**primeHash**  
A spec's identity: its explicit hash, else sha256 of instructions and context; a change re-primes. *Region:* [Primed decision sessions](primed-decisions/knowledge.md)

**PrimeSpec**  
What a key is primed with: key, instructions, context and an optional hash. *Region:* [Primed decision sessions](primed-decisions/knowledge.md)

**priority-balanced**  
Strategy: quartile, priority, preferred, utilization; load decides between tiers a quartile apart. *Region:* [Pools, routing and account limits](pools-routing-limits/knowledge.md)

**priority-strict**  
Strategy: priority, utilization; the top tier serves until it is excluded. *Region:* [Pools, routing and account limits](pools-routing-limits/knowledge.md)

**private CODEX_HOME**  
A Codex home the caller passes through env, holding only the login (auth.json linked, not copied), so the user's AGENTS.md, memories and MCP servers never reach a decision. *Region:* [Primed decision sessions](primed-decisions/knowledge.md)

**privatePathDenial**  
The same check as a reason string or undefined, for use inside your own gate. *Region:* [Tool gates and secret scratch pad](tool-gates-and-secrets/knowledge.md)

**privatePathGate**  
Ready-made gate denying calls that name .private paths, privatePaths globs, the pad (absolute paths), or the heldFiles list it was built with (a snapshot). *Region:* [Tool gates and secret scratch pad](tool-gates-and-secrets/knowledge.md)

**probe**  
Reading account limits with no model turn: probeCodexLimits, probeClaudeLimits, or a caller's options.probe. *Region:* [Pools, routing and account limits](pools-routing-limits/knowledge.md)

**probeCooldownMs**  
Wait before repeating a poll that failed or returned nothing; 60 s by default. *Region:* [Pools, routing and account limits](pools-routing-limits/knowledge.md)

**profileDirectory**  
The login's home (CODEX_HOME or CLAUDE_CONFIG_DIR), always pinned on a leased session. *Region:* [Pools, routing and account limits](pools-routing-limits/knowledge.md)

**providerUsage**  
The entire original provider usage object, including service tier, kept on SessionTokens. *Region:* [HarnessSession contract and events](session-contract/knowledge.md)

**PushOutcome**  
What push() reports: steered, unknown, or ignored with a reason. *Region:* [HarnessSession contract and events](session-contract/knowledge.md)

## Q

**quartile**  
utilization floored into 25-point buckets. *Region:* [Pools, routing and account limits](pools-routing-limits/knowledge.md)

**quartile-balanced**  
Default strategy: quartile, preferred, utilization. *Region:* [Pools, routing and account limits](pools-routing-limits/knowledge.md)

## R

**rate_limit event**  
Account-level limits streamed on onEvent, unattributedReason 'account-status'. *Region:* [Transports and runtime sessions](transports/knowledge.md)

**readLimits()**  
Account limits from an open session without a model turn; refused on claude-agent-sdk. *Region:* [Transports and runtime sessions](transports/knowledge.md)

**routing**  
Class: deterministic candidate ranking: strategies, ordering terms, pinned eligibility, allowedBilling, unknownUtilization, exclusion reasons. *Region:* [Pools, routing and account limits](pools-routing-limits/knowledge.md)

## S

**sdkOptionsFromArgv**  
Maps Claude CLI argv to SDK options; unmapped flags land in extraArgs. *Region:* [Transports and runtime sessions](transports/knowledge.md)

**secret-scratch-pad**  
Class tag: keeping secrets from the agent while letting it use them. *Region:* [Tool gates and secret scratch pad](tool-gates-and-secrets/knowledge.md)

**SECRET_SCRATCH_GUIDANCE**  
Instruction text telling the agent to use secrets by reference and never read them. *Region:* [Tool gates and secret scratch pad](tool-gates-and-secrets/knowledge.md)

**SecretScratchError**  
Error the scratch pad throws on a bad reference or use. *Region:* [Tool gates and secret scratch pad](tool-gates-and-secrets/knowledge.md)

**SecretScratchPad**  
Per-thread private pad holding lifted secrets in 0600 files under a 0700 directory. *Region:* [Tool gates and secret scratch pad](tool-gates-and-secrets/knowledge.md)

**serviceTier**  
Codex only, opt-in fast tier: lower latency, may consume usage faster. *Region:* [Primed decision sessions](primed-decisions/knowledge.md)

**session-contract**  
Class tag: the HarnessSession contract, its events, results, images and pre-send hooks. *Region:* [HarnessSession contract and events](session-contract/knowledge.md)

**SESSION_IMAGE_MEDIA_TYPES**  
The accepted image media types: png, jpeg, gif, webp. *Region:* [HarnessSession contract and events](session-contract/knowledge.md)

**SessionAttempt**  
Admission evidence for one turn: whether and how the runtime took it and how it ended natively. *Region:* [HarnessSession contract and events](session-contract/knowledge.md)

**SessionEvent / SessionEventKind**  
Normalized event: text, text_delta, thinking, tool_use, tool_result, usage, rate_limit, result, error, native_status, session_start, session_end, session_compact, subagent, task. *Region:* [HarnessSession contract and events](session-contract/knowledge.md)

**SessionImage / sendableImages**  
Base64 png/jpeg/gif/webp image for a turn; sendableImages validates against capabilities.images. *Region:* [HarnessSession contract and events](session-contract/knowledge.md)

**SessionResult**  
What send() resolves with: content, tokens and the turn's events. *Region:* [HarnessSession contract and events](session-contract/knowledge.md)

**SessionTokens**  
Counters input, output, cacheRead, cacheWrite, cacheWrite5m, cacheWrite1h, thinking, plus providerUsage. *Region:* [HarnessSession contract and events](session-contract/knowledge.md)

**SessionTurnError**  
Typed failed turn exposing its SessionAttempt evidence. *Region:* [HarnessSession contract and events](session-contract/knowledge.md)

**side session**  
An extra CLI process of a ClaudeSubagentSessions group: a fan-out one (at most maxSessionsPerGroup, 6) or a standby one. *Region:* [Primed decision sessions](primed-decisions/knowledge.md)

**spare**  
A pre-started fork or subagent waiting for exactly one decision. *Region:* [Primed decision sessions](primed-decisions/knowledge.md)

**standby**  
Context a spare is pre-started with; a decision whose standby equals it takes the spare with no dispatch. *Region:* [Primed decision sessions](primed-decisions/knowledge.md)

**steer / push()**  
Mid-turn message into the owned turn; claude-cli, codex-app-server and muse-serve, not claude-agent-sdk. *Region:* [Transports and runtime sessions](transports/knowledge.md)

**subagent-task-events**  
Class tag: subagent and runtime-task activity delivered on onEvent outside any turn. *Region:* [HarnessSession contract and events](session-contract/knowledge.md)

**SubagentLifecycle**  
Payload of kind 'subagent': phase, taskId, toolUseId, parentTaskId, agentType, depth, status, summary, usage. *Region:* [HarnessSession contract and events](session-contract/knowledge.md)

**subscription-pool**  
Class: SubscriptionPool login instances, leases, health cooldowns, limit refresh, continuity, pool events. *Region:* [Pools, routing and account limits](pools-routing-limits/knowledge.md)

## T

**TaskLifecycle**  
Payload of kind 'task' for background work that is not a subagent: Claude local_bash, monitor and workflow tasks, and Muse work such as muse-cron or muse-monitor. *Region:* [HarnessSession contract and events](session-contract/knowledge.md)

**text-only**  
Codex and ClaudePrimedSessions decisions run with tools, plugins and project instructions disabled; subagent members may call only their own decision tools. Other tool activity fails the decision or recycles the process. *Region:* [Primed decision sessions](primed-decisions/knowledge.md)

**tool-gate**  
Class tag: deciding whether an agent tool call may run. *Region:* [Tool gates and secret scratch pad](tool-gates-and-secrets/knowledge.md)

**ToolDecision**  
A gate's answer: { behavior: 'allow', updatedInput? } or { behavior: 'deny', message } (message required). *Region:* [Tool gates and secret scratch pad](tool-gates-and-secrets/knowledge.md)

**ToolGate**  
A function from ToolRequest to ToolDecision. *Region:* [Tool gates and secret scratch pad](tool-gates-and-secrets/knowledge.md)

**toolGate: true**  
Claude session config launching for gates: --permission-prompt-tool stdio (permission stage) plus the PreToolUse callback (pre-use stage); without it onToolRequest throws. Refused with textOnly, and on ClaudeAgentSdkSession together with canUseTool. *Region:* [Tool gates and secret scratch pad](tool-gates-and-secrets/knowledge.md)

**ToolGates**  
Internal gate composer in src/tool-gate.ts; not importable. *Region:* [Tool gates and secret scratch pad](tool-gates-and-secrets/knowledge.md)

**ToolRequest**  
The call a gate sees: stage, toolName, toolInput, toolServer, toolMethod, callId, admissionId, description, decisionReason, blockedPath, agentId, and an optional signal. *Region:* [Tool gates and secret scratch pad](tool-gates-and-secrets/knowledge.md)

**transport kind**  
One of claude-cli, claude-agent-sdk, codex-app-server, muse-serve, acp, api. *Region:* [Transports and runtime sessions](transports/knowledge.md)

**transport-claude-agent-sdk**  
Class tag: ClaudeAgentSdkSession over a caller-supplied Agent SDK query. *Region:* [Transports and runtime sessions](transports/knowledge.md)

**transport-claude-cli**  
Class tag: ClaudeCodeSession over the claude CLI in stream-json. *Region:* [Transports and runtime sessions](transports/knowledge.md)

**transport-codex**  
Class tag: CodexAppServerSession over codex app-server stdio. *Region:* [Transports and runtime sessions](transports/knowledge.md)

**transport-muse**  
Class tag: MuseSession over muse serve via @muse-code/sdk. *Region:* [Transports and runtime sessions](transports/knowledge.md)

**transport-registry**  
Class tag: choosing and creating a transport, its descriptor, capabilities and stubs. *Region:* [Transports and runtime sessions](transports/knowledge.md)

**TransportDescriptor**  
One kind's descriptor, returned by describeTransport(kind). *Region:* [Transports and runtime sessions](transports/knowledge.md)

**TRANSPORTS**  
Descriptor for every kind: runtime, declared capabilities and verification notes. *Region:* [Transports and runtime sessions](transports/knowledge.md)

**TransportUnavailableError**  
Thrown by the AcpSession and ApiSession stubs; nothing falls back. *Region:* [Transports and runtime sessions](transports/knowledge.md)

**TurnState / retainEvidence**  
Internal per-admission state and frozen native envelopes; not importable. *Region:* [HarnessSession contract and events](session-contract/knowledge.md)

## U

**unattributedReason**  
Why an event belongs to no admission: 'subagent', 'account-status' (rate_limit), 'task' (background tasks), or bookkeeping reasons such as 'no-admission', 'foreign-session', 'duplicate-terminal' and 'session-configuration'. *Region:* [HarnessSession contract and events](session-contract/knowledge.md)

**unknownUtilization**  
'exclude' (default) or 'rank-last' for instances with unknown or stale limits. *Region:* [Pools, routing and account limits](pools-routing-limits/knowledge.md)

**updatedInput**  
On a pre-use allow, the call runs with this input and the next gate sees it as toolInput. *Region:* [Tool gates and secret scratch pad](tool-gates-and-secrets/knowledge.md)

**usage event**  
A request snapshot that may repeat across content blocks; never summed with result totals. *Region:* [HarnessSession contract and events](session-contract/knowledge.md)

**usage-telemetry**  
Class tag: token accounting on results and usage events. *Region:* [HarnessSession contract and events](session-contract/knowledge.md)

## V

**volatile key**  
A key whose primed context was replaced before it ever served; it primes again only once its context repeats. *Region:* [Primed decision sessions](primed-decisions/knowledge.md)

## W

**$$word**  
How a person marks a secret in a message (SECRET_MARKER is '$$'). *Region:* [Tool gates and secret scratch pad](tool-gates-and-secrets/knowledge.md)

## X

**XDG_CONFIG_HOME / XDG_DATA_HOME**  
Per-login isolation for Muse: login and sessions live under two homes. *Region:* [Transports and runtime sessions](transports/knowledge.md)
