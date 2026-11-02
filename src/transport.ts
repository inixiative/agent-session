// ---------------------------------------------------------------------------
// Transports — how a session reaches its model
// ---------------------------------------------------------------------------
//
// Every transport implements the same HarnessSession contract. Switching how a
// model is reached (native CLI on a subscription, a warm app-server, the Agent
// SDK, ACP, a metered API) is a routing change, not a rewrite. Each transport
// declares what it can actually do; callers branch on capabilities, never on
// the transport kind.
//
// Capabilities describe this package's implementation, not what the runtime
// could do in principle. A native feature that exists but is not wired up here
// is declared absent, with a note.
// ---------------------------------------------------------------------------

export type TransportKind =
  | 'claude-cli'
  | 'codex-app-server'
  | 'muse-serve'
  | 'claude-agent-sdk'
  | 'acp'
  | 'api';

export type TransportRuntime = 'claude' | 'codex' | 'muse' | 'external';

export interface TransportCapabilities {
  /** Continue a thread by native ID in a new process. */
  readonly resume: 'native' | 'none';
  /** `native`: a new branch with its own ID. */
  readonly fork: 'native' | 'none';
  /** Drop the last N turns of native history. */
  readonly rollback: 'native' | 'none';
  /** `acknowledged`: interruptNative() confirms the stop through the turn's terminal; `local-only`: interrupt() releases the local waiter only. */
  readonly interrupt: 'acknowledged' | 'local-only';
  /** `steer`: push() adds input to the in-flight turn; `none`: push() records push_ignored. */
  readonly push: 'steer' | 'none';
  /** `callback`: per-call decisions through onToolRequest(); `mode`: a fixed launch policy (bypass); `refuse`: runtime requests are refused. */
  readonly approvals: 'callback' | 'mode' | 'refuse';
  /** Token usage reported per turn. */
  readonly usage: boolean;
  /** Account limits: `stream` as rate_limit events during turns, `poll` via readLimits() without a model turn. */
  readonly limits: { readonly stream: boolean; readonly poll: boolean };
  /** A tool-free, text-only session can be enforced (decisions). */
  readonly textOnly: boolean;
  /** send() takes images beside the text (`SessionSendOptions.images`): png, jpeg, gif, webp. */
  readonly images: boolean;
  /** Primed decision host on this transport and how it returns to its primed state each cycle (see primed.ts). */
  readonly primed: 'fork' | 'none';
  readonly billing: 'subscription' | 'api';
}

export interface TransportDescriptor {
  readonly kind: TransportKind;
  readonly runtime: TransportRuntime;
  /** `stub`: the session constructor throws TransportUnavailableError. */
  readonly status: 'implemented' | 'stub';
  /** Strongest evidence behind the capabilities: `live` runs against the real CLI, `controlled` uses fake processes only. */
  readonly verified: 'live' | 'controlled' | 'none';
  readonly capabilities: TransportCapabilities;
  readonly notes: readonly string[];
}

const none = { stream: false, poll: false } as const;

export const TRANSPORTS: Readonly<Record<TransportKind, TransportDescriptor>> = Object.freeze({
  'claude-cli': {
    kind: 'claude-cli',
    runtime: 'claude',
    status: 'implemented',
    verified: 'live',
    capabilities: {
      resume: 'native',
      fork: 'native',
      rollback: 'none',
      interrupt: 'acknowledged',
      push: 'steer',
      approvals: 'callback',
      usage: true,
      limits: { stream: true, poll: true },
      textOnly: true,
      images: true,
      primed: 'fork',
      billing: 'subscription',
    },
    notes: [
      'Persistent `claude --print --input-format stream-json` process.',
      'textOnly launches with no tools, MCP servers, slash commands or user settings.',
      'Primed decisions (ClaudePrimedSessions) fork a persisted primed session per cycle with a pre-spawned spare.',
      "interruptNative() and readLimits() use the CLI's stdio control protocol (`interrupt`, `get_usage`).",
      'push() steers: a stream-json user message with `priority: "next"` and a `uuid`, tracked by its `command_lifecycle` frames; one the turn had not taken in when its result came runs as a follow-on result of the same turn, and a stop withdraws it (`cancel_async_message`). Live-verified on claude 2.1.316.',
      'toolGate: true launches with `--permission-prompt-tool stdio` and registers a PreToolUse callback over the control protocol: onToolRequest() gates see every call (`pre-use`, any mode, bypass included; only a deny counts) and the asks the permission mode raises (`permission`, final).',
      'Rollback (`--resume-session-at`) exists natively but is not wired here.',
      'Images ride in the same stream-json user message as base64 `image` content blocks, before the text.',
    ],
  },
  'codex-app-server': {
    kind: 'codex-app-server',
    runtime: 'codex',
    status: 'implemented',
    verified: 'live',
    capabilities: {
      resume: 'native',
      fork: 'none',
      rollback: 'none',
      interrupt: 'acknowledged',
      push: 'steer',
      approvals: 'callback',
      usage: true,
      limits: { stream: true, poll: true },
      textOnly: false,
      images: true,
      primed: 'fork',
      billing: 'subscription',
    },
    notes: [
      '`codex app-server --listen stdio://` with thread/start, thread/resume, turn/start.',
      "CodexAppServerSession runs with the profile's tools; tool-free text sessions are CodexPrimedSessions (primed: fork).",
      'interruptNative() sends turn/interrupt; push() sends turn/steer against the owned turn.',
      'appServer.approvalPolicy/sandbox (default never / danger-full-access; `codexPermissions(mode)`) set the thread policy; command and file-change approvals for the owned turn go to onToolRequest() gates (`permission`) and are answered accept/decline. Other server requests are refused (-32601).',
      'Primed decisions (CodexPrimedSessions) host every key as a thread of one process per account and fork the primed thread per cycle.',
      'thread/rollback is refused by codex-cli 0.155 for both ephemeral and paginated threads; session fork() is not wired.',
      'Images go to turn/start as `image` inputs with a `data:` URL, after the text.',
    ],
  },
  'muse-serve': {
    kind: 'muse-serve',
    runtime: 'muse',
    status: 'implemented',
    verified: 'live',
    capabilities: {
      resume: 'native',
      fork: 'native',
      rollback: 'none',
      interrupt: 'acknowledged',
      push: 'steer',
      approvals: 'callback',
      usage: true,
      limits: { stream: true, poll: true },
      textOnly: false,
      images: true,
      primed: 'none',
      billing: 'subscription',
    },
    notes: [
      "`muse serve --trust-workspace` (plus `--disable-sandbox` under bypassPermissions) driven through Meta's `@muse-code/sdk` MuseClient, pinned to the installed CLI's version.",
      'Billing is the saved Muse Code login: metered keys and endpoints (META_, LLM_, MODEL_, LLAMA_, OPENROUTER_, ANTHROPIC_, OPENAI_), Meta auth endpoints (TBH_) and the MUSE_ model, experiment, contributor, approval-judge and fail-open switches are removed from the child environment; a resumed or forked session must report provider `meta`.',
      'Approvals use an explicit permission profile (`:ask-me` supervised, `:read-only` plan, `:unrestricted` bypass), never the host default `:auto-review`, whose AI reviewer would decide instead of the gates; the committed profile, approval mode and (gated) a human reviewer are read back before any turn.',
      "Work Muse starts itself (cron firings, monitor and background-terminal wakes, goals, reminder agents, workflows, another client's messages) is folded like a turn's and emitted with `unattributedReason: 'task'`, plus a `task` lifecycle typed `muse-cron`, `muse-monitor`, `muse-goal`, `muse-reminder`, `muse-workflow` or `muse-turn`; it is seen only while this host has the session loaded.",
      "interruptNative() sends turn/interrupt; push() sends turn/steer; fork() runs session/fork on the new session's own host; readLimits() sends usage/read.",
      'userInput/request questions go to onUserInput(); without an answer they are cancelled with a reason, so a turn never waits on them.',
      'Live-verified (muse 1.4.14): start, profile read-back, multi-stage shell and network approvals, text and tool events, token usage, usage/changed and usage/read (recorded in fixtures/muse); fork, resume with setApprovalMode and sessionNotFound were checked live without a model turn (not recorded). A steer (`turn/steer` into a running shell turn, answered in that turn) was checked live 2026-11-02 (not recorded). Images, interrupt, questions and Muse-initiated turns follow the SDK wire types without a live run.',
    ],
  },
  'claude-agent-sdk': {
    kind: 'claude-agent-sdk',
    runtime: 'claude',
    status: 'implemented',
    verified: 'live',
    capabilities: {
      resume: 'native',
      fork: 'native',
      rollback: 'none',
      interrupt: 'acknowledged',
      push: 'none',
      approvals: 'callback',
      usage: true,
      limits: { stream: true, poll: false },
      textOnly: true,
      images: true,
      primed: 'none',
      billing: 'subscription',
    },
    notes: [
      'Drives `@anthropic-ai/claude-agent-sdk` query() supplied by the caller; this package keeps zero dependencies.',
      "Reuses ClaudeCodeSession's event classification and admission evidence over the SDK message stream.",
      'push() is not wired: whether the SDK stream surfaces `command_lifecycle` (which a steer is tracked by) is unverified.',
    ],
  },
  acp: {
    kind: 'acp',
    runtime: 'external',
    status: 'stub',
    verified: 'none',
    capabilities: {
      resume: 'none',
      fork: 'none',
      rollback: 'none',
      interrupt: 'local-only',
      push: 'none',
      approvals: 'refuse',
      usage: false,
      limits: none,
      textOnly: false,
      images: false,
      primed: 'none',
      billing: 'subscription',
    },
    notes: [
      'Agent Client Protocol (JSON-RPC over stdio). Not implemented: no ACP agent is available to verify against.',
    ],
  },
  api: {
    kind: 'api',
    runtime: 'external',
    status: 'stub',
    verified: 'none',
    capabilities: {
      resume: 'none',
      fork: 'none',
      rollback: 'none',
      interrupt: 'local-only',
      push: 'none',
      approvals: 'refuse',
      usage: false,
      limits: none,
      textOnly: false,
      images: false,
      primed: 'none',
      billing: 'api',
    },
    notes: ['Direct metered API. Explicit opt-in only; not implemented.'],
  },
} satisfies Record<TransportKind, TransportDescriptor>);

/** Thrown by stub transports. Never falls back to another transport. */
export class TransportUnavailableError extends Error {
  constructor(
    readonly kind: TransportKind,
    detail: string,
  ) {
    super(`Transport "${kind}" is not available: ${detail}`);
    this.name = 'TransportUnavailableError';
  }
}
