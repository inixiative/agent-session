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
// Implementations: ClaudeCodeSession (now), CodexSession / CursorSession (future)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Event taxonomy — classified events from the agent stream
// ---------------------------------------------------------------------------

export type SessionEventKind =
  | "session_start"
  | "session_end"
  | "session_compact"
  | "text"
  | "tool_use"
  | "tool_result"
  | "thinking"
  | "result"
  | "error";

export interface SessionEvent {
  readonly kind: SessionEventKind;
  readonly timestamp: number;
  /** Text content (for text, thinking, result, error). */
  readonly text?: string;
  /** Tool name (for tool_use). */
  readonly toolName?: string;
  /** Tool input arguments (for tool_use). */
  readonly toolInput?: Record<string, unknown>;
  /** Tool output (for tool_result). */
  readonly toolOutput?: string;
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
  /** Token usage (for result). */
  readonly tokens?: { input: number; output: number };
  /** Raw message from the stream (for Oracle introspection). */
  readonly raw?: unknown;
}

/** Result of a single send() — the turn's content plus all classified events. */
export interface SessionResult {
  readonly content: string;
  readonly events: readonly SessionEvent[];
  readonly tokens?: { input: number; output: number };
  /** The runtime's native session ID. See SessionEvent.externalSessionId. */
  readonly externalSessionId?: string;
}

/** Full session record for Oracle evaluation. */
export interface SessionArtifact {
  /** The runtime's native session ID. See SessionEvent.externalSessionId. */
  readonly externalSessionId?: string;
  readonly events: readonly SessionEvent[];
  readonly startedAt: number;
  readonly endedAt?: number;
  readonly turns: number;
  readonly totalTokens: { input: number; output: number };
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
export type BeforeSendHook = (
  message: string,
) => string | Promise<string>;

// ---------------------------------------------------------------------------
// HarnessSession interface
// ---------------------------------------------------------------------------

export interface HarnessSession {
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
  readonly totalTokens: Readonly<{ input: number; output: number }>;

  /** Spawn the underlying process. Must be called before send(). */
  start(): Promise<void>;

  /** Send a message. Queued if another turn is in-flight. */
  send(message: string, opts?: { timeout?: number }): Promise<SessionResult>;

  /**
   * Fork: create a new (unstarted) session branching from current state.
   * Caller must call start() on the forked session.
   */
  fork(opts?: { cwd?: string; baseContext?: string }): HarnessSession;

  /** Interrupt the current in-flight turn (best-effort). */
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
