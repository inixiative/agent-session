// ---------------------------------------------------------------------------
// HarnessSession — provider-agnostic interface for long-lived agent sessions
// ---------------------------------------------------------------------------
//
// A HarnessSession wraps a live agent subprocess (Claude Code, Codex, Cursor)
// with bidirectional JSON streaming. One process startup per session, then
// messages flow as JSON lines over stdin/stdout.
//
// This is NOT an LLMProvider. LLMProvider is stateless (complete → result).
// HarnessSession is stateful: it owns a running process, tracks turns,
// captures every event for Oracle, and supports fork/interrupt.
//
// Implementations: ClaudeCodeSession, CodexAppServerSession,
// ClaudeAgentSdkSession. How a model is reached is the session's transport
// (see transport.ts); every transport implements this one contract.
// ---------------------------------------------------------------------------

import type { LimitSnapshot } from './limits';
import type { TransportDescriptor } from './transport';

// ---------------------------------------------------------------------------
// Event taxonomy — classified events from the agent stream
// ---------------------------------------------------------------------------

/** IDs are native only when observed. admissionId is generated locally, never a native turn ID. */
export interface SessionIdentity {
  readonly admissionId?: string;
  readonly nativeSessionId?: string;
  readonly threadId?: string;
  readonly turnId?: string;
  readonly itemId?: string;
  readonly callId?: string;
  readonly messageId?: string;
  readonly rpcRequestId?: number;
  readonly correlation?: 'native-turn' | 'ordered-stream' | 'unknown';
}
export type NativeOutcome = 'unknown' | 'completed' | 'failed';
export interface NativeTerminal {
  readonly type: string;
  readonly eventId?: string;
  readonly turnId?: string;
  readonly subtype?: string;
  readonly reason?: string;
  readonly apiErrorStatus?: number;
}
export interface SessionAttempt extends SessionIdentity {
  readonly nativeOutcome: NativeOutcome;
  readonly localOutcome: 'pending' | 'resolved' | 'rejected';
  readonly dispatch: 'not-dispatched' | 'attempted';
  readonly transportOutcome: 'open' | 'failed' | 'closed';
  readonly terminal?: NativeTerminal;
  readonly rpcOutcome?: 'pending' | 'resolved' | 'failed' | 'unknown';
  readonly localFailure?:
    | 'timeout'
    | 'interrupt-request'
    | 'transport'
    | 'rpc'
    | 'validation'
    | 'blocked'
    | 'killed'
    | 'unrecognized-terminal'
    | 'registration';
  readonly content: string;
  readonly events: readonly SessionEvent[];
  readonly tokens?: SessionTokens;
}
/** A rejected local send can still have a later native terminal; read attempt again to reconcile. */
export class SessionTurnError extends Error {
  constructor(
    message: string,
    private readonly evidence: () => SessionAttempt,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'SessionTurnError';
  }
  get attempt(): SessionAttempt {
    return this.evidence();
  }
}

export type SessionEventKind =
  | 'text_delta'
  | 'native_status'
  | 'session_start'
  | 'session_end'
  | 'session_compact'
  | 'text'
  | 'tool_use'
  | 'tool_result'
  | 'thinking'
  | 'usage'
  | 'rate_limit'
  | 'result'
  | 'error'
  | 'subagent';

/**
 * A subagent's lifecycle as the native runtime reports it (kind `subagent`). Claude Code: its
 * `system` task frames for an Agent/Task call. Codex: a collab `spawnAgent` item and its child thread.
 */
export interface SubagentLifecycle {
  readonly phase: 'started' | 'progress' | 'updated' | 'ended';
  /** The native id of the subagent run (Claude task id, Codex child thread id). */
  readonly taskId: string;
  /** The tool call that spawned it, in its parent's stream. */
  readonly toolUseId?: string;
  /** The task that spawned it, when a subagent spawned it (Claude). */
  readonly parentTaskId?: string;
  readonly agentType?: string;
  readonly description?: string;
  /** 1 for a child of the main thread. */
  readonly depth?: number;
  readonly backgrounded?: boolean;
  /** The native status at the end (completed, stopped, failed, killed). */
  readonly status?: string;
  readonly summary?: string;
  /** The task the subagent was given. */
  readonly prompt?: string;
  /** Its own running totals, when the runtime reports them (Claude progress and end frames). */
  readonly usage?: {
    readonly totalTokens: number;
    readonly toolUses?: number;
    readonly durationMs?: number;
  };
}

/** Input excludes cache reads/writes when those disjoint counters are supplied.
 * Thinking is a subset of output; TTL counters are subsets of cacheWrite.
 * Missing optional counters mean the runtime did not report them.
 */
export interface SessionTokens {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
  cacheWrite5m?: number;
  cacheWrite1h?: number;
  thinking?: number;
  /** Original provider usage, including tags and future fields. Never summed. */
  providerUsage?: Readonly<Record<string, unknown>>;
}

export interface SessionEvent extends SessionIdentity {
  /**
   * Session-history evidence excluded from admission results and state transitions.
   * "session-configuration": a native lifecycle/configuration envelope (Claude system/init)
   * retained with its binding; it belongs to the session, never to an admission, and a
   * repeated one is not evidence of compaction or restart. "duplicate-boundary": an explicit
   * compaction boundary whose native uuid was already recorded.
   */
  readonly unattributedReason?:
    | 'no-admission'
    | 'foreign-session'
    | 'foreign-turn'
    | 'duplicate-terminal'
    | 'after-terminal'
    | 'unrecognized-event'
    | 'session-configuration'
    | 'duplicate-boundary'
    | 'duplicate-tool'
    | 'unmatched-tool'
    | 'malformed-tool'
    | 'account-status'
    | 'subagent';
  /** Local transport observation, not a native terminal acknowledgment. */
  readonly transportOutcome?: SessionAttempt['transportOutcome'];
  readonly nativeOutcome?: NativeOutcome;
  readonly terminal?: NativeTerminal;
  readonly kind: SessionEventKind;
  readonly timestamp: number;
  /** Text content (for text, thinking, result, error). */
  readonly text?: string;
  /** Tool name (for tool_use). */
  readonly toolName?: string;
  /** Native MCP invocation identity, separate from call ID and SDK request IDs.
   * Display name is mcp__<server>__<tool>; use these fields for exact comparisons. */
  readonly toolServer?: string;
  readonly toolMethod?: string;
  /** Tool input arguments (for tool_use). */
  readonly toolInput?: Record<string, unknown>;
  /** Tool output (for tool_result). */
  readonly toolOutput?: string;
  /** Public text content is retained; unsupported/non-text result payload is omitted. */
  readonly toolOutputOmitted?: boolean;
  /** Exact public tool names from `tool_reference` result blocks (tool search), in order,
   * duplicates preserved; a separately owned guard judges ownership. Absent when none. */
  readonly toolReferences?: readonly string[];
  /** Public type labels of omitted non-text result blocks, in first-seen order; unknown or
   * malformed shapes are "unsupported". Present only when toolOutputOmitted is true. */
  readonly toolOutputOmittedTypes?: readonly string[];
  readonly toolInputOmitted?: string;
  /** Whether the tool call failed (for tool_result). */
  readonly toolError?: boolean;
  /** Compaction source runtime (for session_compact): "claude-code" | "codex" | etc. */
  readonly compactionSource?: string;
  /**
   * The agent runtime's native session ID (e.g. the UUID Claude Code uses
   * as the filename in ~/.claude/projects/<id>.jsonl). External to Foundry —
   * this is NOT the Foundry thread ID. A SessionAdapter maps between the two.
   */
  readonly externalSessionId?: string;
  /** Turn totals on result; request snapshots on usage. Do not sum both. */
  readonly tokens?: SessionTokens;
  /** Account-level usage limits (for rate_limit). Never attributed to an admission. */
  readonly limits?: LimitSnapshot;
  /** Owned, deeply frozen native JSON data (for Oracle introspection). */
  readonly raw?: unknown;
  /**
   * The tool call (in its parent's stream) that spawned the subagent this event came from; absent
   * for the main thread's own events. Every subagent event, its lifecycle included, is outside any
   * admission (`unattributedReason: "subagent"`), so it never touches a turn's content or results.
   */
  readonly parentToolUseId?: string;
  /** A subagent's lifecycle (kind `subagent`). */
  readonly subagent?: SubagentLifecycle;
}

/** Result of a single send() — the turn's content plus all classified events. */
export interface SessionResult extends SessionIdentity {
  readonly localOutcome?: SessionAttempt['localOutcome'];
  readonly transportOutcome?: SessionAttempt['transportOutcome'];
  readonly rpcOutcome?: SessionAttempt['rpcOutcome'];
  readonly nativeOutcome?: NativeOutcome;
  readonly terminal?: NativeTerminal;
  readonly content: string;
  readonly events: readonly SessionEvent[];
  readonly tokens?: SessionTokens;
  /** The runtime's native session ID. See SessionEvent.externalSessionId. */
  readonly externalSessionId?: string;
}

/** Full session record for Oracle evaluation. */
export interface SessionDiagnostics {
  /** Counts only: observer exception messages/objects are never retained. */
  readonly observerFailures: { readonly synchronous: number; readonly asynchronous: number };
}
export interface SessionArtifact {
  readonly diagnostics?: SessionDiagnostics;
  readonly attempts?: readonly SessionAttempt[];
  /** Legacy totalTokens contains observed counts only, not proof of complete accounting. */
  readonly accounting?: 'observed-only';
  /** The runtime's native session ID. See SessionEvent.externalSessionId. */
  readonly externalSessionId?: string;
  readonly events: readonly SessionEvent[];
  readonly startedAt: number;
  readonly endedAt?: number;
  readonly turns: number;
  readonly totalTokens: SessionTokens;
  readonly toolCalls: number;
  readonly toolResults: number;
  readonly errors: number;
}

export type SessionEventHandler = (event: SessionEvent) => void;

/**
 * Pre-send hook — wraps or rewrites the outgoing message before it reaches
 * the underlying runtime. Multiple handlers compose in registration order:
 * each sees the previous handler's output. Returns the transformed message
 * (or the same message unchanged).
 *
 * This is how FlowOrchestrator injects delta context per turn: the Librarian
 * computes "what's new since the last injection," formats it as a prefix,
 * and the composed message goes to send().
 */
export type BeforeSendHook = (message: string) => string | Promise<string>;

export const SESSION_IMAGE_MEDIA_TYPES = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
] as const;
export type SessionImageMediaType = (typeof SESSION_IMAGE_MEDIA_TYPES)[number];

/** An image sent with a turn's text, where the transport declares `capabilities.images`. */
export interface SessionImage {
  readonly mediaType: SessionImageMediaType;
  /** The image bytes, base64 (no `data:` prefix). */
  readonly data: string;
}

export interface SessionSendOptions {
  timeout?: number;
  /** Required ownership registration, not an observer. Rejection prevents the native write. */
  onAdmission?: (attempt: SessionAttempt) => void | Promise<void>;
  /**
   * Images sent with the message, in order, as part of the same user turn. Refused (before
   * anything is written) by a transport without `capabilities.images` and for any other media type.
   */
  images?: readonly SessionImage[];
}

/** Images a send may write: a copy of each, or a refusal naming the first one that is not. */
export function sendableImages(
  transport: TransportDescriptor | undefined,
  images: readonly SessionImage[] | undefined,
): SessionImage[] {
  if (!images?.length) return [];
  if (!transport?.capabilities.images)
    throw new Error(`Transport "${transport?.kind ?? 'unknown'}" does not accept image input`);
  return images.map((image, index) => {
    if (!SESSION_IMAGE_MEDIA_TYPES.includes(image?.mediaType))
      throw new Error(`Image ${index + 1}: unsupported media type ${String(image?.mediaType)}`);
    if (typeof image.data !== 'string' || !image.data || /[^A-Za-z0-9+/=]/.test(image.data))
      throw new Error(`Image ${index + 1}: data must be non-empty base64`);
    return { mediaType: image.mediaType, data: image.data };
  });
}

// ---------------------------------------------------------------------------
// Tool gate — per-call decisions from the runtime's native approval channel
// ---------------------------------------------------------------------------

export interface ToolRequest {
  /**
   * `pre-use` (Claude only; Codex has no pre-use stage): before every tool call, in every
   * permission mode (bypass included). Only a deny counts; an allow leaves the runtime's own mode
   * to decide. `permission`: the runtime's own mode would ask the user; the decision is final.
   */
  readonly stage: 'pre-use' | 'permission';
  readonly toolName: string;
  /** `mcp__<server>__<tool>` split, as tool_use events carry it. */
  readonly toolServer?: string;
  readonly toolMethod?: string;
  readonly toolInput: Readonly<Record<string, unknown>>;
  /** Native tool_use id (Claude) or item id (Codex). */
  readonly callId?: string;
  /** The in-flight admission, when one is attributable. */
  readonly admissionId?: string;
  /** The runtime's own description of, or reason for, the call. */
  readonly description?: string;
  /** Claude `can_use_tool` decision_reason: why the runtime's mode escalated to an ask. */
  readonly decisionReason?: string;
  /** Claude `can_use_tool` blocked_path. */
  readonly blockedPath?: string;
  /** Claude subagent id (`agent_id`) when a subagent, not the main thread, makes the call. */
  readonly agentId?: string;
  /**
   * Aborted when the runtime withdraws the request or the session ends; a later decision is
   * discarded. A turn timeout does not withdraw a pending Claude ask; interruptNative() does
   * (the CLI sends control_cancel_request).
   */
  readonly signal?: AbortSignal;
}
export type ToolDecision =
  | { readonly behavior: 'allow' }
  | { readonly behavior: 'deny'; readonly message: string };
/** Gates compose in registration order: the first deny wins; a thrown or rejected gate denies. */
export type ToolGate = (request: ToolRequest) => ToolDecision | Promise<ToolDecision>;

// ---------------------------------------------------------------------------
// HarnessSession interface
// ---------------------------------------------------------------------------

/** `acknowledged`: the runtime confirmed the stop and the turn reached a native terminal. */
export type NativeInterruptOutcome = 'acknowledged' | 'no-turn' | 'unacknowledged';

export interface HarnessSession {
  /** How this session reaches its model, with the capabilities that transport declares. */
  readonly transport?: TransportDescriptor;
  /**
   * Ask the runtime to stop the in-flight turn and wait (bounded) for its
   * acknowledgment. Present only where the transport declares
   * `interrupt: "acknowledged"`. Unlike interrupt(), a confirmed stop settles
   * native ownership through the turn's own terminal.
   */
  interruptNative?(opts?: { timeoutMs?: number }): Promise<NativeInterruptOutcome>;
  /** Poll account usage limits without a model turn. Present where the transport declares `limits.poll`. */
  readLimits?(opts?: { timeoutMs?: number }): Promise<LimitSnapshot | undefined>;
  /** One immutable admission snapshot, without copying unrelated session history. */
  inspectAttempt?(admissionId: string): SessionAttempt | undefined;
  readonly admissionProtocol?: 'prewrite-v1';
  readonly diagnostics?: SessionDiagnostics;
  readonly attempts?: readonly SessionAttempt[];
  readonly accounting?: 'observed-only';
  readonly alive: boolean;
  /**
   * The agent runtime's native session ID — external to Foundry.
   * `undefined` until the runtime emits it (typically on the first turn's
   * system init event). Use a SessionAdapter to map between a Foundry
   * thread ID and this external ID.
   */
  readonly externalSessionId: string | undefined;
  readonly events: readonly SessionEvent[];
  readonly turns: number;
  readonly totalTokens: Readonly<SessionTokens>;

  /** Spawn the underlying process. Must be called before send(). */
  start(): Promise<void>;

  /** Send a message. Queued if another turn is in-flight. */
  send(message: string, opts?: SessionSendOptions): Promise<SessionResult>;

  /**
   * Fork: create a new (unstarted) session branching from current state.
   * Caller must call start() on the forked session. A fork starts with a snapshot of the
   * parent's tool gates; gates registered or unregistered afterwards on either side stay local.
   */
  fork(opts?: { cwd?: string; baseContext?: string }): HarnessSession;

  /** Reject the local waiter. No native cancellation acknowledgment is currently implemented. */
  interrupt(): void;

  /** Kill the session process and reject any pending turns. */
  kill(): void;

  /** Subscribe to live events. Returns unsubscribe function. */
  onEvent(handler: SessionEventHandler): () => void;

  /**
   * Register a pre-send transform. Runs in registration order before the
   * message is written to the runtime. Used for per-turn delta injection.
   * Returns an unregister function.
   */
  onBeforeSend(hook: BeforeSendHook): () => void;

  /**
   * Register a tool gate. Present where the transport declares `approvals: "callback"`; the
   * session must be launched for callbacks (Claude: `toolGate: true`; Codex app-server: an
   * `approvalPolicy` other than `never`), otherwise this throws. Forks copy the gates registered
   * at fork() time. Returns an unregister function.
   */
  onToolRequest?(gate: ToolGate): () => void;

  /**
   * Mid-turn push: out-of-band signal injected into an in-flight turn.
   * Used by guards and Herald to deliver urgent feedback. Best-effort —
   * the underlying runtime may or may not honor the push.
   *
   * Implementations that cannot support mid-turn push should emit a
   * "push_ignored" error event rather than throw, so callers can observe
   * that the push was attempted but not delivered.
   */
  push(payload: { kind: string; text: string }): Promise<void>;

  /** Full session record for Oracle evaluation. */
  artifact(): SessionArtifact;
}
