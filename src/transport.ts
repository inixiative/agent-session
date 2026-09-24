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
  | "claude-cli"
  | "codex-mcp"
  | "codex-app-server"
  | "claude-agent-sdk"
  | "acp"
  | "api";

export type TransportRuntime = "claude" | "codex" | "external";

export interface TransportCapabilities {
  /** Continue a thread by native ID in a new process (`loaded-only`: only while the original process holds it). */
  readonly resume: "native" | "loaded-only" | "none";
  /** `native`: a new branch with its own ID; `same-thread`: continues the parent thread (not a real fork). */
  readonly fork: "native" | "same-thread" | "none";
  /** Drop the last N turns of native history. */
  readonly rollback: "native" | "none";
  /** `acknowledged`: interruptNative() confirms the stop through the turn's terminal; `local-only`: interrupt() releases the local waiter only. */
  readonly interrupt: "acknowledged" | "local-only";
  /** `steer`: push() adds input to the in-flight turn; `none`: push() records push_ignored. */
  readonly push: "steer" | "none";
  /** `callback`: per-call decision hook; `mode`: a fixed launch policy (bypass); `refuse`: runtime requests are refused. */
  readonly approvals: "callback" | "mode" | "refuse";
  /** Token usage reported per turn. */
  readonly usage: boolean;
  /** Account limits: `stream` as rate_limit events during turns, `poll` via readLimits() without a model turn. */
  readonly limits: { readonly stream: boolean; readonly poll: boolean };
  /** A tool-free, text-only session can be enforced (decisions). */
  readonly textOnly: boolean;
  /** Primed decision host on this transport and how it returns to its primed state each cycle (see primed.ts). */
  readonly primed: "fork" | "none";
  readonly billing: "subscription" | "api";
}

export interface TransportDescriptor {
  readonly kind: TransportKind;
  readonly runtime: TransportRuntime;
  /** `stub`: the session constructor throws TransportUnavailableError. */
  readonly status: "implemented" | "stub";
  /** Strongest evidence behind the capabilities: `live` runs against the real CLI, `controlled` uses fake processes only. */
  readonly verified: "live" | "controlled" | "none";
  readonly capabilities: TransportCapabilities;
  readonly notes: readonly string[];
}

const none = { stream: false, poll: false } as const;

export const TRANSPORTS: Readonly<Record<TransportKind, TransportDescriptor>> = Object.freeze({
  "claude-cli": {
    kind: "claude-cli", runtime: "claude", status: "implemented", verified: "live",
    capabilities: { resume: "native", fork: "native", rollback: "none", interrupt: "acknowledged", push: "none",
      approvals: "mode", usage: true, limits: { stream: true, poll: true }, textOnly: true, primed: "fork", billing: "subscription" },
    notes: [
      "Persistent `claude --print --input-format stream-json` process.",
      "textOnly launches with no tools, MCP servers, slash commands or user settings.",
      "Primed decisions (ClaudePrimedSessions) fork a persisted primed session per cycle with a pre-spawned spare.",
      "interruptNative() and readLimits() use the CLI's stdio control protocol (`interrupt`, `get_usage`).",
      "Rollback (`--resume-session-at`) and per-call approvals (`--permission-prompt-tool stdio`) exist natively but are not wired here.",
    ],
  },
  "codex-mcp": {
    kind: "codex-mcp", runtime: "codex", status: "implemented", verified: "live",
    capabilities: { resume: "loaded-only", fork: "same-thread", rollback: "none", interrupt: "local-only", push: "none",
      approvals: "mode", usage: true, limits: none, textOnly: false, primed: "none", billing: "subscription" },
    notes: [
      "`codex mcp-server`; `codex-reply` continues only threads loaded in the same process.",
      "fork() continues the parent thread; it is not a native fork.",
    ],
  },
  "codex-app-server": {
    kind: "codex-app-server", runtime: "codex", status: "implemented", verified: "live",
    capabilities: { resume: "native", fork: "none", rollback: "none", interrupt: "acknowledged", push: "steer",
      approvals: "refuse", usage: true, limits: { stream: true, poll: true }, textOnly: false, primed: "fork", billing: "subscription" },
    notes: [
      "`codex app-server --listen stdio://` with thread/start, thread/resume, turn/start.",
      "CodexAppServerSession runs with the profile's tools; tool-free text sessions are CodexPrimedSessions (primed: fork).",
      "interruptNative() sends turn/interrupt; push() sends turn/steer against the owned turn.",
      "Primed decisions (CodexPrimedSessions) host every key as a thread of one process per account and fork the primed thread per cycle.",
      "thread/rollback is refused by codex-cli 0.155 for both ephemeral and paginated threads; session fork() is not wired.",
    ],
  },
  "claude-agent-sdk": {
    kind: "claude-agent-sdk", runtime: "claude", status: "implemented", verified: "live",
    capabilities: { resume: "native", fork: "native", rollback: "none", interrupt: "acknowledged", push: "none",
      approvals: "callback", usage: true, limits: { stream: true, poll: false }, textOnly: true, primed: "none", billing: "subscription" },
    notes: [
      "Drives `@anthropic-ai/claude-agent-sdk` query() supplied by the caller; this package keeps zero dependencies.",
      "Reuses ClaudeCodeSession's event classification and admission evidence over the SDK message stream.",
    ],
  },
  "acp": {
    kind: "acp", runtime: "external", status: "stub", verified: "none",
    capabilities: { resume: "none", fork: "none", rollback: "none", interrupt: "local-only", push: "none",
      approvals: "refuse", usage: false, limits: none, textOnly: false, primed: "none", billing: "subscription" },
    notes: ["Agent Client Protocol (JSON-RPC over stdio). Not implemented: no ACP agent is available to verify against."],
  },
  "api": {
    kind: "api", runtime: "external", status: "stub", verified: "none",
    capabilities: { resume: "none", fork: "none", rollback: "none", interrupt: "local-only", push: "none",
      approvals: "refuse", usage: false, limits: none, textOnly: false, primed: "none", billing: "api" },
    notes: ["Direct metered API. Explicit opt-in only; not implemented."],
  },
} satisfies Record<TransportKind, TransportDescriptor>);

/** Thrown by stub transports. Never falls back to another transport. */
export class TransportUnavailableError extends Error {
  constructor(readonly kind: TransportKind, detail: string) {
    super(`Transport "${kind}" is not available: ${detail}`);
    this.name = "TransportUnavailableError";
  }
}
