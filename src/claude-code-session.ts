import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  claudeRateLimitSnapshot,
  claudeUsageSnapshot,
  type LimitSnapshot,
  mergeLimits,
} from './limits';
import { retainEvidence } from './retained-evidence';
import { mcpToolParts, ToolGates } from './tool-gate';
import { TRANSPORTS } from './transport';
import { TurnState } from './turn-state';

// ---------------------------------------------------------------------------
// ClaudeCodeSession — long-lived Claude Code process with full event capture
// ---------------------------------------------------------------------------
//
// Implements HarnessSession by spawning a persistent `claude` CLI process
// with --input-format stream-json --output-format stream-json.
//
// Architecture:
//   start()  → spawns one process, starts background stdout read loop
//   send()   → writes JSON to stdin, returns promise resolved on "result" event
//   fork()   → creates new session with --resume <id> --fork-session
//   kill()   → closes stdin, kills process
//
// Lifecycle:
//   const session = new ClaudeCodeSession({ baseContext, cwd });
//   await session.start();                         // one startup
//   const r1 = await session.send("Fix the bug");  // instant, no CLI restart
//   const r2 = await session.send("Now add tests"); // reuses same process
//   session.kill();
//
// Performance:
//   CLI startup cost is paid ONCE. Each send() is just a JSON line on stdin.
//   Base context (project identity, conventions, repo map) is injected at
//   startup via --append-system-prompt. Per-message delta is minimal.
//
// Fork:
//   const forked = session.fork({ cwd: otherWorktree });
//   await forked.start();   // new process with --resume <id> --fork-session
//   await forked.send("Continue from here");
//
// --resume is used ONLY for fork and crash recovery, not as the normal
// transport. Normal messages go through stdin.
// ---------------------------------------------------------------------------

import { parseClaudeUsage } from './claude-usage';
import type {
  BeforeSendHook,
  HarnessSession,
  NativeInterruptOutcome,
  PushOutcome,
  SessionArtifact,
  SessionAttempt,
  SessionEvent,
  SessionEventHandler,
  SessionIdentity,
  SessionImage,
  SessionResult,
  SessionSendOptions,
  SessionTokens,
  SubagentLifecycle,
  TaskLifecycle,
  ToolDecision,
  ToolGate,
  ToolRequest,
} from './harness-session';
import {
  NativeBindingMissingError,
  NativeModelMissingError,
  SessionDetached,
  SessionReturned,
  sendableImages,
} from './harness-session';

// Re-export types so existing import paths keep working
export type {
  SessionArtifact,
  SessionEvent,
  SessionEventKind,
  SessionResult,
} from './harness-session';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface ClaudeCodeSessionConfig {
  /** Path to claude CLI binary. Defaults to "claude". */
  bin?: string;
  /** Model. Defaults to "sonnet". */
  model?: string;
  /**
   * Reasoning-effort level (`--effort`). One of low|medium|high|xhigh|max.
   * Omitted → the CLI's default effort. Recorded per run for comparability.
   */
  effort?: string;
  /** Working directory for the session. */
  cwd?: string;
  /** Max agentic turns per message. Defaults to 25. */
  maxTurns?: number | null;
  /** Permission mode. Defaults to "bypassPermissions". */
  permissionMode?: string;
  /** Default per-send timeout in ms. Defaults to 600000 (10 min). */
  timeout?: number;
  /**
   * Base context to pre-load at session startup.
   *
   * Injected via --append-system-prompt-file on process spawn (a private 0600 file, removed when the
   * process ends), so a base past Linux's 128 KiB per-argument limit still starts. Persists for the
   * entire session lifetime. Include all stable context here (system,
   * conventions, memory, architecture) so per-message delta is minimal.
   */
  baseContext?: string;
  /**
   * Native Claude Code session ID (the UUID under ~/.claude/projects/).
   * When set, the process is spawned with `--resume <id>` — used for fork
   * and crash recovery. Also set by a SessionAdapter when resuming a
   * Foundry thread that was previously mapped to this external ID.
   */
  externalSessionId?: string;
  /**
   * Environment merged over process.env (e.g. CLAUDE_CONFIG_DIR for a profile).
   * ANTHROPIC_API_KEY and ANTHROPIC_AUTH_TOKEN are always removed: this
   * transport runs on the CLI's subscription login.
   */
  env?: Record<string, string | undefined>;
  /**
   * Launch without callable tools, MCP servers, slash commands or user
   * settings (`--safe-mode --tools "" --strict-mcp-config …`). For decisions.
   */
  textOnly?: boolean;
  /** False adds `--no-session-persistence` (nothing written to history; cannot be resumed). Default true. */
  persistSession?: boolean;
  /**
   * Launch for per-call tool decisions: `--permission-prompt-tool stdio` plus a PreToolUse
   * callback registered over the control protocol at start(). Gates added with
   * onToolRequest() decide (a `permission` ask with no gate is denied). A callback or ask that
   * cannot be read as a tool request is denied (fail closed). A turn timeout leaves a pending
   * ask open; interruptNative() withdraws it. Not with textOnly.
   */
  toolGate?: boolean;
  /**
   * Override for the process spawner. Defaults to Bun.spawn. Tests inject a
   * fake subprocess that emulates the claude CLI's stream-json protocol.
   */
  spawn?: (
    cmd: string[],
    opts: {
      cwd: string;
      env: Record<string, string | undefined>;
    },
  ) => PipedSubprocess;
}

// ---------------------------------------------------------------------------
// Extension: work a host runs inside this session's own process (ClaudeInSessionDecisions)
// ---------------------------------------------------------------------------

/** A custom agent definition (`--agents`), as Claude Code reads it. */
export interface ClaudeAgentDefinition {
  readonly description: string;
  readonly prompt: string;
  readonly tools: readonly string[];
  readonly model?: string;
  readonly effort?: string;
  readonly permissionMode?: string;
  readonly omitClaudeMd?: boolean;
  readonly background?: boolean;
}

/** What the session offers an extension once its process is up. */
export interface ClaudeSessionHost {
  /** A control request to the CLI (e.g. `stop_task`). */
  control(request: Record<string, unknown>, timeoutMs: number): Promise<Record<string, unknown>>;
  /** Answer an MCP message the extension was handed. */
  mcpReply(requestId: string, message: unknown): void;
  /**
   * A turn of the extension's own, never a caller's: queued like any send, and nothing of it is
   * attributed to a caller's admission. No deadline: its native outcome must settle.
   */
  sendInternal(message: string): Promise<SessionResult>;
  alive(): boolean;
}

/**
 * Work that runs inside this session's process (agents, an SDK MCP server, a PreToolUse claim on
 * its own tool calls), never through vendor hook files. Attached before `start()`.
 */
export interface ClaudeSessionExtension {
  /** Agent definitions added to the launch. */
  readonly agents: Readonly<Record<string, ClaudeAgentDefinition>>;
  /** SDK MCP servers it answers (declared in `initialize`). */
  readonly mcpServers: readonly string[];
  /** Environment its agents need on the launch (merged over the session's own). */
  readonly env?: Readonly<Record<string, string>>;
  /** The process runs (before `initialize`): it may answer MCP messages from now on. */
  attach(host: ClaudeSessionHost): void;
  /** `initialize` was answered: it may write turns and control requests. */
  started(): void;
  /** An MCP message for one of its servers; answered through `host.mcpReply`. */
  mcp(server: string, requestId: string, message: Record<string, unknown>): void;
  /**
   * A PreToolUse callback: the hook output when the call is its own (its agents' calls, a spawn of
   * one of its agent types), else undefined and the tool gate decides.
   */
  preToolUse(input: Record<string, unknown>): Record<string, unknown> | undefined;
  /** A permission ask (`can_use_tool`): its answer when the asking agent is its own, else undefined. */
  permission(request: Record<string, unknown>): Record<string, unknown> | undefined;
  /** A native frame: true when it is its own (never emitted, never part of an admission). */
  frame(raw: Record<string, unknown>): boolean;
  /** The process ended or was killed. */
  detach(reason: string): void;
}

// ---------------------------------------------------------------------------
// Internal turn queue entry
// ---------------------------------------------------------------------------

/** An inbound control request awaiting its gate decision, with the frame that asked. */
interface InboundGate {
  readonly controller: AbortController;
  readonly raw: Record<string, unknown>;
  /** The response decided while detaching, written only if the detach rolls back. */
  decided?: Record<string, unknown>;
}

interface QueuedTurn {
  onAdmission?: SessionSendOptions['onAdmission'];
  evidence: TurnState;
  message: string;
  images: readonly SessionImage[];
  timeout: number;
  /** Epoch ms the turn times out at, once its timer is armed; a resumed turn keeps it. */
  timeoutAt?: number;
  resolve: (result: SessionResult) => void;
  reject: (error: Error) => void;
  /**
   * Messages push() wrote into this turn, by uuid, with their `command_lifecycle` state. One not yet
   * `started` when a result arrives is answered after it, in a follow-on result of the same turn.
   */
  steers?: Map<string, SteerState>;
  /** The turn reached a result while a steer was still waiting: it settles on the next result. */
  held?: { nativeOutcome: 'completed'; tokens?: SessionTokens };
  /** The CLI's text when it answered this turn with `model_not_found`: the model is not served. */
  modelMissing?: string;
  /**
   * The uuid this turn's own message is written with, and its `command_lifecycle` state. The CLI
   * runs turns of its own (a background task's notification wakes it); one that runs while this
   * message is still queued answers with its own result, which is not this turn's.
   */
  prompt?: { uuid: string; state: SteerState };
}

/** `written` until the CLI's `command_lifecycle` names it; `unconfirmed` after push() gave up waiting. */
export type SteerState =
  | 'written'
  | 'queued'
  | 'started'
  | 'completed'
  | 'cancelled'
  | 'unconfirmed';
const STEER_ACK_MS = 10_000;

const TOKEN_KEYS = [
  'input',
  'output',
  'cacheRead',
  'cacheWrite',
  'cacheWrite5m',
  'cacheWrite1h',
  'thinking',
] as const;
/** One turn's usage over several results (a steer answered after a result). Provider usage is the last result's. */
const addTokens = (
  a: SessionTokens | undefined,
  b: SessionTokens | undefined,
): SessionTokens | undefined => {
  if (!a || !b) return b ?? a;
  const sum: SessionTokens = { ...b };
  for (const key of TOKEN_KEYS)
    if (a[key] !== undefined || b[key] !== undefined) sum[key] = (a[key] ?? 0) + (b[key] ?? 0);
  return sum;
};

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

/**
 * Concrete types for Bun.spawn with all pipes — also the shape tests mock. The optional members are
 * a keeper-held process's (`spawnThroughKeeper`, `attachKeeper`): one that can outlive this daemon.
 */
export interface PipedSubprocess {
  stdin: {
    write(data: string): void;
    flush(): void;
    end(): void;
    /** Resolves once every write so far reached the CLI's pipe. */
    drained?(): Promise<void>;
  };
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  exited: Promise<number>;
  readonly pid?: number | undefined;
  /** Settles the spawn; a rejection is a failed start. */
  readonly ready?: Promise<void>;
  /** True once detach began: the streams end without the CLI having exited. */
  readonly detached?: boolean;
  /** Leave the CLI running with no daemon attached; returns the last frame handed out. */
  detach?(options: { readonly orphanDeadlineMs: number }): Promise<{ readonly offset: number }>;
  /** Forward frames numbered above `after`, then live (a reattached process starts held). */
  release?(after: number): void;
  /** Settles once the frames spooled while detached are handed out. */
  replayed?(): Promise<void>;
  kill(): void;
}

/** Version of `ClaudeSessionSnapshot`; a shape change bumps it and `fromSnapshot` refuses others. */
export const CLAUDE_SESSION_SNAPSHOT_VERSION = 1;

/**
 * What a later process needs to carry on a session `detach()` left running under its keeper: the
 * CLI keeps working, and `ClaudeCodeSession.fromSnapshot` rebuilds the session's own state around
 * it. Plain JSON. See docs/session-snapshot.md.
 */
export interface ClaudeSessionSnapshot {
  readonly snapshotVersion: typeof CLAUDE_SESSION_SNAPSHOT_VERSION;
  readonly externalSessionId?: string;
  readonly hookCallbackId: string;
  readonly cliPid?: number;
  /** The last keeper frame this session processed; the next one starts after it. */
  readonly offset: number;
  readonly promptUuids: readonly string[];
  readonly promptLifecycleSeen: boolean;
  readonly steerUuids: readonly string[];
  readonly seenTerminals: readonly string[];
  readonly seenBoundaries: readonly string[];
  /** The `task_started` frames of tasks still running, replayed so a new owner learns them. */
  readonly liveTasks: readonly Record<string, unknown>[];
  /** Control requests (approvals) asked and not answered, raised again on resume. */
  readonly pendingControl: readonly Record<string, unknown>[];
  readonly inflight?: {
    readonly admissionId: string;
    readonly identity: SessionIdentity;
    readonly content: string;
    readonly tokens?: SessionTokens;
    readonly timeout: number;
    /** Epoch ms the turn times out at; the resumed session keeps what was left. */
    readonly timeoutAt?: number;
    readonly prompt?: { readonly uuid: string; readonly state: SteerState };
    readonly steers: readonly (readonly [string, SteerState])[];
    readonly held?: { readonly nativeOutcome: 'completed'; readonly tokens?: SessionTokens };
    readonly modelMissing?: string;
  };
  readonly wake: { readonly id: string; readonly nativeSessionId?: string } | null;
  readonly wakeCause?: string;
  readonly turns: number;
  readonly totalTokens: SessionTokens;
  readonly baseContextDir?: string;
}

// ---------------------------------------------------------------------------
// Public tool-result content contract (stream-json `user` tool_result blocks).
//
// A string content is the public output verbatim. An array keeps the text
// blocks (joined with one newline, as before) and, separately, the exact
// `tool_name` strings of `tool_reference` blocks (Anthropic tool search returns
// discovered tools as references, not text). Every other block, and any
// malformed text/reference block, is omitted explicitly: `toolOutputOmitted` is
// set and `toolOutputOmittedTypes` lists known public type labels or
// "unsupported". Nothing else from a block is copied, so private or unexpected
// fields never enter the public event. Reference-only output is NOT a success
// claim; the consuming guard judges ownership and ordering.
// ---------------------------------------------------------------------------
const KNOWN_NON_TEXT_RESULT_TYPES = new Set([
  'image',
  'audio',
  'document',
  'resource',
  'resource_link',
]);

function publicToolResultContent(
  content: unknown,
): Pick<
  SessionEvent,
  'toolOutput' | 'toolReferences' | 'toolOutputOmitted' | 'toolOutputOmittedTypes'
> {
  if (typeof content === 'string') return { toolOutput: content };
  if (content === undefined || content === null) return {};
  const omittedTypes: string[] = [];
  const omit = (type: unknown) => {
    const label =
      typeof type === 'string' && KNOWN_NON_TEXT_RESULT_TYPES.has(type) ? type : 'unsupported';
    if (!omittedTypes.includes(label)) omittedTypes.push(label);
  };
  if (!Array.isArray(content)) {
    omit(undefined);
    return { toolOutputOmitted: true, toolOutputOmittedTypes: Object.freeze(omittedTypes) };
  }
  const texts: string[] = [],
    references: string[] = [];
  for (const block of content) {
    const b =
      block !== null && typeof block === 'object' && !Array.isArray(block)
        ? (block as Record<string, unknown>)
        : undefined;
    if (b?.type === 'text' && typeof b.text === 'string') texts.push(b.text);
    else if (
      b?.type === 'tool_reference' &&
      typeof b.tool_name === 'string' &&
      b.tool_name.length > 0
    )
      references.push(b.tool_name);
    else omit(b?.type);
  }
  return {
    toolOutput: texts.join('\n'),
    ...(references.length ? { toolReferences: Object.freeze([...references]) } : {}),
    ...(omittedTypes.length
      ? { toolOutputOmitted: true, toolOutputOmittedTypes: Object.freeze(omittedTypes) }
      : {}),
  };
}

/** Claude CLI flags for a tool-free session (the same launch Foundry uses for text-only auxiliaries). */
export const CLAUDE_TEXT_ONLY_ARGS: readonly string[] = [
  '--safe-mode',
  '--tools',
  '',
  '--strict-mcp-config',
  '--mcp-config',
  '{"mcpServers":{}}',
  '--disable-slash-commands',
  '--no-chrome',
];

/** A Claude `result` frame's native outcome, by Foundry's provider precedence. */
function claudeResultOutcome(raw: Record<string, unknown>) {
  const subtype = typeof raw.subtype === 'string' ? raw.subtype : undefined;
  const reason = typeof raw.terminal_reason === 'string' ? raw.terminal_reason : undefined;
  const status =
    typeof raw.api_error_status === 'number' && Number.isFinite(raw.api_error_status)
      ? raw.api_error_status
      : undefined;
  // An optimistic subtype cannot erase an explicit native error; local transport/RPC errors do not enter here.
  const failed =
    raw.is_error === true ||
    subtype?.startsWith('error_') ||
    (status !== undefined && status >= 400) ||
    reason === 'api_error';
  const outcome: 'failed' | 'completed' | 'unknown' = failed
    ? 'failed'
    : subtype === 'success'
      ? 'completed'
      : 'unknown';
  return { outcome, subtype, reason, status };
}

export class ClaudeCodeSession implements HarnessSession {
  get transport() {
    return TRANSPORTS['claude-cli'];
  }
  // -- Config --
  private _bin: string;
  private _model: string;
  private _effort?: string;
  private _cwd: string;
  readonly admissionProtocol = 'prewrite-v1' as const;
  readonly turnBudgetProtocol = 'optional-max-turns-v1' as const;
  inspectAttempt(admissionId: string) {
    return this._attempts.find((attempt) => attempt.admissionId === admissionId)?.snapshot();
  }
  private _maxTurns: number | null;
  private _permissionMode: string;
  private _defaultTimeout: number;
  private _baseContext?: string;
  /** The private directory holding the base context file while a process runs. */
  private _baseContextDir?: string;
  private _forking = false;
  private _awaitingForkIdentity = false;
  private _spawn?: ClaudeCodeSessionConfig['spawn'];
  private _env?: ClaudeCodeSessionConfig['env'];
  private _textOnly: boolean;
  private _persistSession: boolean;
  private _toolGate: boolean;
  private _gates = new ToolGates();
  private _extension?: ClaudeSessionExtension;
  /** The private directory holding the extension's agent definitions while a process runs. */
  private _agentsDir?: string;
  /** Inbound control requests awaiting a gate decision, by request id, with the frame that asked. */
  private _inbound = new Map<string, InboundGate>();
  /** push() calls waiting for the CLI to name their message, by uuid. */
  private _steerAcks = new Map<
    string,
    { resolve(state: SteerState): void; reject(error: Error): void }
  >();
  /** `task_started` frames of tasks not yet ended, by task id: a snapshot carries them. */
  private _liveTaskStarts = new Map<string, Record<string, unknown>>();
  /** detach() has begun: nothing new is written, and gate answers wait for the next owner. */
  private _detaching = false;
  /** Rebuilt by fromSnapshot: waiting on resume(), and a callback it cannot place is denied. */
  private _fromSnapshot?: {
    offset: number;
    liveTasks: readonly Record<string, unknown>[];
    pendingControl: readonly Record<string, unknown>[];
  };
  private _adoptedTurn?: Promise<SessionResult>;
  /** Set for good by fromSnapshot: a hook callback or approval nobody here can place is denied. */
  private _resumedFromSnapshot = false;
  /** Steers written and not yet ended natively: a late `completed` after their turn settled is theirs. */
  private _steerUuids = new Set<string>();
  /** Uuids of turn messages the CLI has not reported completed or cancelled. */
  private _promptUuids = new Set<string>();
  /** The CLI has named a turn message by its uuid, so an unnamed one is not started yet. */
  private _promptLifecycleSeen = false;
  /** Mutable only so fromSnapshot can keep the id the running CLI was registered with. */
  private _hookCallbackId = `agent-session-pre-tool-${Bun.randomUUIDv7()}`;
  private _limits?: LimitSnapshot;
  private _controlSeq = 0;
  private _control = new Map<
    string,
    { resolve(response: Record<string, unknown>): void; reject(error: Error): void }
  >();

  // -- Process --
  // Bun.spawn's return type is a union; we always use stdin:"pipe"/stdout:"pipe"/stderr:"pipe"
  // so we know the concrete types at runtime.
  private _proc: PipedSubprocess | null = null;
  private _stderr = '';
  /** The stderr reader of the running process; awaited (capped) before stderr is interpreted. */
  private _stderrDone: Promise<void> = Promise.resolve();
  /** The stdout reader of the running process; detach() waits for it to process every line. */
  private _stdoutDone: Promise<void> = Promise.resolve();

  // -- Session state --
  /**
   * The Claude Code runtime's native session ID. Set from config (for fork /
   * crash recovery) or learned from the stream's system_init event. When
   * set, _buildSpawnArgs() includes --resume <id>, so subsequent start()
   * calls resume rather than create a new native session.
   */
  private _externalSessionId?: string;
  private _alive = false;
  private _endEmitted = false;
  private _eventLog: SessionEvent[] = [];
  private _handlers: SessionEventHandler[] = [];
  private _observerFailures = { synchronous: 0, asynchronous: 0 };
  private _beforeSendHooks: BeforeSendHook[] = [];
  private _turns = 0;
  private _totalTokens: SessionTokens = { input: 0, output: 0 };
  private _startedAt: number;
  /**
   * Native uuids of explicit compaction boundaries already emitted. Claude emits a
   * `system/init` per admission on one binding, so a repeated init is configuration
   * evidence, never proof of compaction or restart. Only the explicit
   * `system/compact_boundary` envelope is a compaction, and a repeat is a duplicate
   * only when it carries the same native uuid; text-equal boundaries without one
   * are distinct compactions.
   */
  private _seenBoundaries = new Set<string>();
  /** Task ids whose task_started was a subagent (local_agent); later task frames carry no type. */
  private _agentTasks = new Set<string>();
  /** Task ids whose task_started was another task type (a background shell, a monitor): id → type. */
  private _otherTasks = new Map<string, string>();
  /** A turn the CLI started itself (a background task's notification wake), open until its result. */
  private _wake: { id: string; nativeSessionId?: string } | null = null;
  /** What last ended in the background, the likely cause of the next wake. */
  private _wakeCause: string | undefined;

  // -- Turn queue --
  private _queue: QueuedTurn[] = [];
  private _attempts: TurnState[] = [];
  private _seenTerminals = new Set<string>();
  private _inflight: QueuedTurn | null = null;
  private _turnTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(config?: ClaudeCodeSessionConfig) {
    const bin = config?.bin ?? 'claude';
    if (!/^[a-zA-Z0-9_./\\-]+$/.test(bin)) {
      throw new Error(`Invalid claude CLI binary path: "${bin}"`);
    }
    this._bin = bin;
    this._model = config?.model ?? 'sonnet';
    this._effort = config?.effort;
    this._cwd = config?.cwd ?? process.cwd();
    // Undefined retains standalone legacy behavior; null explicitly omits the CLI cap.
    if (
      config?.maxTurns !== undefined &&
      config.maxTurns !== null &&
      (!Number.isSafeInteger(config.maxTurns) || config.maxTurns < 1)
    ) {
      throw new Error('maxTurns must be a positive safe integer or null (unbounded)');
    }
    this._maxTurns = config?.maxTurns === undefined ? 25 : config.maxTurns;
    this._permissionMode = config?.permissionMode ?? 'bypassPermissions';
    this._defaultTimeout = config?.timeout ?? 600_000;
    this._baseContext = config?.baseContext;
    this._externalSessionId = config?.externalSessionId;
    this._spawn = config?.spawn;
    this._env = config?.env;
    this._textOnly = config?.textOnly ?? false;
    this._persistSession = config?.persistSession ?? true;
    this._toolGate = config?.toolGate ?? false;
    if (this._toolGate && this._textOnly)
      throw new Error('toolGate requires a session with tools; textOnly sessions have none');
    this._startedAt = Date.now();
  }

  /** Latest account limits observed on this session (stream or poll). */
  get limits(): LimitSnapshot | undefined {
    return this._limits;
  }

  // ---------------------------------------------------------------------------
  // Accessors
  // ---------------------------------------------------------------------------

  get accounting() {
    return 'observed-only' as const;
  }
  get attempts() {
    return this._attempts.map((a) => a.snapshot());
  }
  get diagnostics() {
    return Object.freeze({ observerFailures: Object.freeze({ ...this._observerFailures }) });
  }

  get alive(): boolean {
    return this._alive;
  }
  get externalSessionId(): string | undefined {
    return this._externalSessionId;
  }
  get events(): readonly SessionEvent[] {
    return Object.freeze([...this._eventLog]);
  }
  get turns(): number {
    return this._turns;
  }
  get totalTokens(): Readonly<SessionTokens> {
    return { ...this._totalTokens };
  }

  // ---------------------------------------------------------------------------
  // Event subscription
  // ---------------------------------------------------------------------------

  onEvent(handler: SessionEventHandler): () => void {
    this._handlers.push(handler);
    return () => {
      const idx = this._handlers.indexOf(handler);
      if (idx !== -1) this._handlers.splice(idx, 1);
    };
  }

  /** Register a tool gate. A fork gets a snapshot of the gates registered at fork() time. */
  onToolRequest(gate: ToolGate): () => void {
    if (!this._toolGate) throw new Error('Tool gates need a session launched with toolGate: true');
    return this._gates.add(gate);
  }

  /**
   * Run an extension inside this session's process (ClaudeInSessionDecisions). Before `start()`
   * only, once, and never on a text-only session (it needs tools and an MCP server).
   */
  extend(extension: ClaudeSessionExtension): void {
    if (this._proc) throw new Error('Extensions attach before start()');
    if (this._extension) throw new Error('Session already has an extension');
    if (this._textOnly) throw new Error('A text-only session cannot host an extension');
    this._extension = extension;
  }

  onBeforeSend(hook: BeforeSendHook): () => void {
    this._beforeSendHooks.push(hook);
    return () => {
      const idx = this._beforeSendHooks.indexOf(hook);
      if (idx !== -1) this._beforeSendHooks.splice(idx, 1);
    };
  }

  /**
   * Mid-turn steer: a stream-json user message with `priority: "next"` and its own `uuid`, written
   * while the owned turn runs. The CLI answers `command_lifecycle` queued → started → completed for
   * that uuid. It takes the message in at the turn's next model request (after a tool result), or,
   * when the turn's reply was already final, runs it right after that result as a follow-on result:
   * either way it is this turn's, and send() settles on the last result (validated against claude
   * 2.1.316, fixtures/s0/claude-steer-*.jsonl).
   */
  async push(payload: { kind: string; text: string }): Promise<PushOutcome> {
    const ignored = (reason: string): PushOutcome => {
      this._emitPushIgnored(payload.kind, reason);
      return { outcome: 'ignored', reason };
    };
    const turn = this._inflight;
    const a = turn?.evidence;
    if (this._detaching) throw new SessionReturned();
    if (!turn || !a || a.dispatch !== 'attempted' || a.nativeOutcome !== 'unknown')
      return ignored('no owned in-flight turn');
    if (!this._proc || !this._alive) return ignored('session not running');
    const uuid = Bun.randomUUIDv7();
    turn.steers ??= new Map();
    const steers = turn.steers;
    steers.set(uuid, 'written');
    this._steerUuids.add(uuid);
    const acknowledged = new Promise<SteerState>((resolve, reject) =>
      this._steerAcks.set(uuid, { resolve, reject }),
    );
    try {
      this._proc.stdin.write(
        `${JSON.stringify({
          type: 'user',
          message: { role: 'user', content: [{ type: 'text', text: payload.text }] },
          uuid,
          parent_tool_use_id: null,
          priority: 'next',
        })}\n`,
      );
      this._proc.stdin.flush();
    } catch (error) {
      steers.delete(uuid);
      this._steerUuids.delete(uuid);
      this._steerAcks.delete(uuid);
      return ignored(`write failed: ${(error as Error).message.slice(0, 200)}`);
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const state = await Promise.race([
      acknowledged,
      new Promise<'unconfirmed'>((resolve) => {
        timer = setTimeout(() => resolve('unconfirmed'), STEER_ACK_MS);
      }),
    ]).finally(() => clearTimeout(timer));
    this._steerAcks.delete(uuid);
    const identity = { ...a.identity, admissionId: a.admissionId };
    if (state === 'cancelled')
      return ignored('the runtime cancelled it before the turn took it in');
    if (state === 'unconfirmed') {
      // Never named by the CLI: it no longer holds the turn open.
      if (steers.get(uuid) === 'written') steers.set(uuid, 'unconfirmed');
      this._releaseHeld(turn);
      this._emit({
        ...identity,
        kind: 'native_status',
        timestamp: Date.now(),
        raw: { type: 'push-unknown', kind: payload.kind },
      });
      return { outcome: 'unknown' };
    }
    this._emit({
      ...identity,
      kind: 'native_status',
      timestamp: Date.now(),
      raw: { type: 'push-steered', kind: payload.kind, uuid },
    });
    return { outcome: 'steered' };
  }

  protected _emitPushIgnored(kind: string, reason: string): void {
    this._emit({
      kind: 'error',
      timestamp: Date.now(),
      text: `push_ignored: kind=${kind} — ${reason}`,
      raw: { kind },
    });
  }

  /** `turn`'s own message is queued behind a turn of the CLI's own, or not yet named by a CLI that names them. */
  private _promptWaiting(turn: QueuedTurn): boolean {
    const state = turn.prompt?.state;
    return state === 'queued' || (state === 'written' && this._promptLifecycleSeen);
  }

  /** A steer of `turn` the CLI has not started yet (or not named yet). */
  private _steerWaiting(turn: QueuedTurn): boolean {
    for (const state of turn.steers?.values() ?? [])
      if (state === 'written' || state === 'queued') return true;
    return false;
  }

  /**
   * A held turn settles with the result it already had once no steer can still produce a result:
   * none waiting, and none started (a started steer of a held turn is its follow-on run).
   */
  private _releaseHeld(turn: QueuedTurn): void {
    if (!turn.held || this._inflight !== turn || this._steerWaiting(turn)) return;
    for (const state of turn.steers?.values() ?? []) if (state === 'started') return;
    const a = turn.evidence;
    a.tokens = turn.held.tokens;
    a.nativeOutcome = turn.held.nativeOutcome;
    turn.held = undefined;
    this._resolveTurn();
  }

  /** Withdraw `turn`'s steers the CLI has not started, so none outlives it as an unowned turn. */
  private async _withdrawSteers(turn: QueuedTurn, timeoutMs: number): Promise<void> {
    const waiting = [...(turn.steers ?? [])].filter(
      ([, state]) => state === 'queued' || state === 'written',
    );
    await Promise.all(
      waiting.map(([uuid]) =>
        this._controlRequest(
          { subtype: 'cancel_async_message', message_uuid: uuid },
          timeoutMs,
        ).then(
          (response) => {
            if ((response.response as { cancelled?: unknown } | undefined)?.cancelled === true)
              turn.steers?.set(uuid, 'cancelled');
          },
          () => {},
        ),
      ),
    );
  }

  // ---------------------------------------------------------------------------
  // start() — spawn the persistent process
  // ---------------------------------------------------------------------------

  async start(): Promise<void> {
    if (this._attempts.some((a) => a.dispatch === 'attempted' && a.nativeOutcome === 'unknown'))
      throw new Error('Native outcome unresolved; automatic resume is blocked');
    if (this._proc) throw new Error('Session already started');

    const args = this._buildSpawnArgs();

    // Strip API key env vars — CLI uses subscription auth
    const env: Record<string, string | undefined> = {
      ...process.env,
      ...this._env,
      ...this._extension?.env,
      DISABLE_AUTOUPDATER: '1',
    };
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_AUTH_TOKEN;
    for (const key of Object.keys(env)) if (env[key] === undefined) delete env[key];

    try {
      if (this._spawn) {
        this._proc = this._spawn([this._bin, ...args], { cwd: this._cwd, env });
      } else {
        this._proc = Bun.spawn([this._bin, ...args], {
          cwd: this._cwd,
          stdin: 'pipe',
          stdout: 'pipe',
          stderr: 'pipe',
          env,
        }) as unknown as PipedSubprocess;
      }
      // A keeper-held process starts asynchronously: its failure is this start's.
      await this._proc.ready;
    } catch (error) {
      this._proc = null;
      this._removeBaseContext();
      this._removeAgents();
      throw error;
    }

    this._alive = true;
    this._endEmitted = false;
    this._emit({ kind: 'session_start', timestamp: Date.now() });

    // Background readers — run for session lifetime (don't await)
    const proc = this._proc;
    this._stdoutDone = this._readStdout(proc);
    this._stderrDone = this._readStderr(proc);
    this._watchExit(proc);

    // The PreToolUse callback is registered before any turn is written, so it covers the first call.
    // An extension's agents run their own tools: it claims them through the same callback.
    const extension = this._extension;
    // The extension can answer from the moment the process runs: the CLI connects its SDK MCP
    // server while `initialize` is still in flight, and an unanswered connect costs a 30 s retry.
    if (extension)
      extension.attach({
        control: (request, timeoutMs) => this._controlRequest(request, timeoutMs),
        mcpReply: (requestId, message) => {
          if (this._proc === proc && this._alive)
            this._writeControlResponse(proc, requestId, { mcp_response: message });
        },
        sendInternal: (message) => this.send(message, { timeout: 0 }),
        alive: () => this._proc === proc && this._alive,
      });
    if (this._toolGate || extension) {
      try {
        await this._controlRequest(
          {
            subtype: 'initialize',
            hooks: { PreToolUse: [{ matcher: '.*', hookCallbackIds: [this._hookCallbackId] }] },
            ...(extension
              ? {
                  sdkMcpServers: [...extension.mcpServers],
                  // The user's Stop aborts the turn only; background agents (the extension's) survive.
                  perTaskStopAffordance: true,
                }
              : {}),
          },
          30_000,
        );
      } catch (error) {
        this.kill();
        const missing = this._missingBinding((error as Error).message);
        if (missing) throw missing;
        throw new Error(
          `${this._toolGate ? 'Tool gate' : 'Extension'} registration failed: ${(error as Error).message}`,
        );
      }
    }
    if (extension && this._proc === proc && this._alive) {
      try {
        extension.started();
      } catch {
        /* an extension's failure never touches the session */
      }
    }
  }

  /**
   * The CLI refused to resume because the transcript is gone (Claude Code's cleanup of
   * `~/.claude/projects`, or a deleted file): it says so and exits before reading a turn.
   */
  private _missingBinding(detail: string): NativeBindingMissingError | undefined {
    const binding = this._externalSessionId;
    if (!binding) return undefined;
    const marker = `No conversation found with session ID: ${binding}`;
    return this._stderr.includes(marker) || detail.includes(marker)
      ? new NativeBindingMissingError('claude-code', binding, marker, this._cwd)
      : undefined;
  }

  /**
   * After the process ended: was the binding missing? stderr is read first (capped), since the
   * marker is there. A turn written to a CLI that never loaded the conversation (no `system/init`,
   * no terminal) could not run: it settles as a no-send rather than uncertain native work.
   */
  private async _settleMissing(detail: string): Promise<NativeBindingMissingError | undefined> {
    await Promise.race([this._stderrDone, Bun.sleep(250)]);
    const missing = this._missingBinding(detail);
    const a = this._inflight?.evidence;
    if (
      missing &&
      a &&
      a.nativeOutcome === 'unknown' &&
      !a.events.some((event) => {
        const raw = event.raw as { type?: unknown; subtype?: unknown } | undefined;
        return raw?.type === 'system' && raw.subtype === 'init';
      })
    )
      a.dispatch = 'not-dispatched';
    return missing;
  }

  /**
   * Clean up when the process exits. The process read its base context file at startup; it goes
   * when the process does. A detached process never exits here: its next owner watches it.
   */
  private _watchExit(proc: PipedSubprocess): void {
    const stdoutDone = this._stdoutDone;
    const baseDir = this._baseContextDir;
    const agentsDir = this._agentsDir;
    proc.exited.then(async (code) => {
      if (proc.detached) return;
      this._removeBaseContext(baseDir);
      this._removeAgents(agentsDir);
      if (this._proc !== proc) return;
      this._detachExtension('process exited');
      if (!this._alive) return;
      this._alive = false;
      await stdoutDone; // Drain buffered terminal evidence before interpreting process exit.
      const errMsg = this._stderr.trim()
        ? `Process exited (code ${code}): ${this._stderr.trim().slice(0, 500)}`
        : `Process exited with code ${code}`;
      this._rejectInflight((await this._settleMissing(errMsg)) ?? new Error(errMsg));
      this._rejectQueue(new Error('Session ended'));
      this._rejectControl(new Error('Session ended'));
      this._emit({ kind: 'session_end', timestamp: Date.now(), transportOutcome: 'failed' });
    });
  }

  private _detachExtension(reason: string): void {
    try {
      this._extension?.detach(reason);
    } catch {
      /* an extension's failure never touches the session */
    }
  }

  private _rejectControl(error: Error): void {
    for (const pending of this._control.values()) pending.reject(error);
    this._control.clear();
    // Decisions still pending have nowhere to go: withdraw them.
    for (const inbound of this._inbound.values()) inbound.controller.abort();
    this._inbound.clear();
  }

  // ---------------------------------------------------------------------------
  // send() — write message to stdin, resolve on result event
  // ---------------------------------------------------------------------------

  async send(message: string, opts?: SessionSendOptions): Promise<SessionResult> {
    if (this._detaching) throw new SessionReturned();
    if (this._fromSnapshot) throw new Error('Session rebuilt from a snapshot; call resume() first');
    // Auto-restart after interrupt / process death (crash recovery via --resume).
    // _externalSessionId persists across process lifetimes, so start() will
    // include --resume <id> in spawn args.
    if (
      this._attempts.some(
        (a) =>
          a.dispatch === 'attempted' &&
          a.nativeOutcome === 'unknown' &&
          (!this._alive || a.localOutcome !== 'pending'),
      )
    ) {
      const blocked = new TurnState();
      this._attempts.push(blocked);
      throw blocked.fail(new Error('Native outcome unresolved; send not dispatched'), 'blocked');
    }
    if (!this._proc && this._externalSessionId) {
      await this.start();
    }

    if (!this._proc) throw new Error('Session not started — call start() first');
    if (!this._alive) throw new Error('Session ended');

    const timeout = opts?.timeout ?? this._defaultTimeout;
    const images = sendableImages(this.transport, opts?.images);

    // Compose pre-send hooks in registration order. Each sees the previous
    // hook's output. Errors in a hook reject the send() — callers should
    // unregister problematic hooks or catch.
    let transformed = message;
    for (const hook of this._beforeSendHooks) {
      transformed = await hook(transformed);
    }

    return new Promise<SessionResult>((resolve, reject) => {
      const evidence = new TurnState();
      this._attempts.push(evidence);
      const turn: QueuedTurn = {
        evidence,
        message: transformed,
        images,
        timeout,
        resolve,
        reject,
        onAdmission: opts?.onAdmission,
      };
      if (!this._alive || (this._inflight && this._inflight.evidence.localOutcome !== 'pending')) {
        reject(
          evidence.fail(
            new Error('Previous native work unresolved; send not dispatched'),
            'blocked',
          ),
        );
        return;
      }

      if (!this._inflight) {
        this._dispatchTurn(turn);
      } else {
        this._queue.push(turn);
      }
    });
  }

  // ---------------------------------------------------------------------------
  // fork() — branch from current conversation state (and a snapshot of the tool gates)
  // ---------------------------------------------------------------------------

  fork(opts?: {
    cwd?: string;
    baseContext?: string;
    persistSession?: boolean;
    spawn?: ClaudeCodeSessionConfig['spawn'];
  }): ClaudeCodeSession {
    if (this._inflight) throw new Error('Cannot fork while native ownership is unresolved');
    if (!this._externalSessionId) {
      throw new Error('Cannot fork — no external session ID yet (send at least one message first)');
    }

    const forked = this._construct({
      bin: this._bin,
      model: this._model,
      effort: this._effort,
      cwd: opts?.cwd ?? this._cwd,
      maxTurns: this._maxTurns,
      permissionMode: this._permissionMode,
      timeout: this._defaultTimeout,
      baseContext: opts?.baseContext ?? this._baseContext,
      externalSessionId: this._externalSessionId,
      spawn: opts?.spawn ?? this._spawn,
      env: this._env,
      textOnly: this._textOnly,
      persistSession: opts?.persistSession ?? this._persistSession,
      toolGate: this._toolGate,
    });
    for (const gate of this._gates.list()) forked._gates.add(gate);
    forked._forking = true;
    return forked;
  }

  /** Construct a sibling session (fork). Subclasses keep their own transport. */
  protected _construct(config: ClaudeCodeSessionConfig): ClaudeCodeSession {
    return new ClaudeCodeSession(config);
  }

  // ---------------------------------------------------------------------------
  // interrupt() — reject the local waiter; native cancellation is unacknowledged
  // ---------------------------------------------------------------------------

  interrupt(): void {
    if (!this._inflight) return;

    this._rejectInflight(
      new Error('Local waiter interrupted; native cancellation unacknowledged'),
      'interrupt-request',
    );

    // Native ownership is retained. Waiting sends are rejected without dispatch.
  }

  /**
   * Native interrupt through the CLI control protocol. Resolves "acknowledged"
   * once the CLI confirms and the turn's own terminal arrives (the send()
   * settles through that terminal, normally as a failed/interrupted outcome).
   */
  async interruptNative(opts?: { timeoutMs?: number }): Promise<NativeInterruptOutcome> {
    const turn = this._inflight;
    const deadline = Date.now() + (opts?.timeoutMs ?? 5_000);
    // A turn the CLI started itself, with no message of ours in flight: the stop is for it.
    const wake = this._wake;
    if (!turn && wake) {
      try {
        await this._controlRequest({ subtype: 'interrupt' }, Math.max(1, deadline - Date.now()));
      } catch {
        return 'unacknowledged';
      }
      while (this._wake === wake && this._alive && Date.now() < deadline) await Bun.sleep(10);
      return this._wake === wake || !this._alive ? 'unacknowledged' : 'acknowledged';
    }
    if (turn?.evidence.dispatch !== 'attempted' || turn.evidence.nativeOutcome !== 'unknown')
      return 'no-turn';
    // A stop is for the whole turn: a steer still waiting dies with it, never runs after it.
    await this._withdrawSteers(turn, Math.max(1, Math.min(2_000, deadline - Date.now())));
    this._releaseHeld(turn);
    if (turn.evidence.nativeOutcome !== 'unknown') return 'acknowledged';
    try {
      await this._controlRequest({ subtype: 'interrupt' }, Math.max(1, deadline - Date.now()));
    } catch {
      return 'unacknowledged';
    }
    while (turn.evidence.nativeOutcome === 'unknown' && this._alive && Date.now() < deadline)
      await Bun.sleep(10);
    return turn.evidence.nativeOutcome === 'unknown' ? 'unacknowledged' : 'acknowledged';
  }

  /** Stop a background task via the CLI control protocol (`stop_task`); its end comes as lifecycle. */
  async stopTask(taskId: string, opts?: { timeoutMs?: number }): Promise<void> {
    await this._controlRequest({ subtype: 'stop_task', task_id: taskId }, opts?.timeoutMs ?? 5_000);
  }

  /** Account limits via the CLI control protocol (`get_usage`); no model turn. Requires a started session. */
  async readLimits(opts?: { timeoutMs?: number }): Promise<LimitSnapshot | undefined> {
    const response = await this._controlRequest(
      { subtype: 'get_usage' },
      opts?.timeoutMs ?? 10_000,
    );
    const snapshot = claudeUsageSnapshot(response.response);
    if (snapshot) this._observeLimits(snapshot);
    return snapshot;
  }

  private _controlRequest(
    request: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<Record<string, unknown>> {
    if (!this._proc || !this._alive) return Promise.reject(new Error('Session not running'));
    const requestId = `agent-session-${++this._controlSeq}-${Bun.randomUUIDv7()}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._control.delete(requestId);
        reject(new Error(`Control request ${String(request.subtype)} timed out`));
      }, timeoutMs);
      this._control.set(requestId, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      try {
        this._proc!.stdin.write(
          `${JSON.stringify({ type: 'control_request', request_id: requestId, request })}\n`,
        );
        this._proc!.stdin.flush();
      } catch (error) {
        this._control.delete(requestId);
        clearTimeout(timer);
        reject(error as Error);
      }
    });
  }

  private _observeLimits(snapshot: LimitSnapshot): void {
    this._limits = mergeLimits(this._limits, snapshot);
    this._emit({
      kind: 'rate_limit',
      timestamp: Date.now(),
      correlation: 'unknown',
      unattributedReason: 'account-status',
      limits: this._limits,
    });
  }

  // ---------------------------------------------------------------------------
  // kill() — terminate the session
  // ---------------------------------------------------------------------------

  kill(): void {
    if (!this._proc) return;
    this._alive = false;

    if (this._turnTimer) {
      clearTimeout(this._turnTimer);
      this._turnTimer = null;
    }

    this._rejectInflight(new Error('Session killed; native outcome may remain unknown'), 'killed');
    this._rejectQueue(new Error('Session killed'));
    this._rejectControl(new Error('Session killed'));

    try {
      this._proc.stdin.end();
    } catch {
      /* already closed */
    }
    try {
      this._proc.kill();
    } catch {
      /* already dead */
    }
    this._proc = null;
    this._removeBaseContext();
    this._removeAgents();
    this._detachExtension('killed');

    this._emit({ kind: 'session_end', timestamp: Date.now() });
  }

  // ---------------------------------------------------------------------------
  // detach() / fromSnapshot() / resume() — hand a running CLI to a later process
  // ---------------------------------------------------------------------------

  /**
   * Leave the CLI running under its keeper and return what a later process needs to carry on
   * (`fromSnapshot`, then `resume`). Nothing new is written from the moment it starts: queued sends
   * and later sends or steers reject with `SessionReturned` (never written, the caller sends them
   * again); a turn in flight and steers already written reject with `SessionDetached` (the CLI
   * keeps running them and the rebuilt session settles them). Approvals still being decided are
   * withdrawn here and asked again after resume. Emits no `session_end`: the session goes on.
   *
   * Throws, leaving the session running, when it cannot hand over: no keeper-held process, an
   * extension (its in-process MCP servers cannot outlive this process), or stdin that would not
   * drain within `drainMs`. The caller then takes its pause path.
   */
  async detach(options: {
    readonly orphanDeadlineMs: number;
    readonly drainMs?: number;
  }): Promise<ClaudeSessionSnapshot> {
    const proc = this._proc;
    if (!proc || !this._alive) throw new Error('Session not running; nothing to detach');
    if (!proc.detach || !proc.stdin.drained)
      throw new Error('Session process is not keeper-held; it cannot outlive this process');
    if (this._extension)
      throw new Error('Session has an extension; its MCP servers cannot outlive this process');
    if (this._detaching) throw new Error('Session already detaching');
    this._detaching = true;

    const returned = new SessionReturned();
    this._rejectQueue(returned);
    const drainMs = options.drainMs ?? 5_000;
    let drainTimer: ReturnType<typeof setTimeout> | undefined;
    const drained = await Promise.race([
      proc.stdin.drained().then(() => true),
      new Promise<false>((resolve) => {
        drainTimer = setTimeout(() => resolve(false), drainMs);
      }),
    ]).finally(() => clearTimeout(drainTimer));
    if (!drained) {
      this._rollBackDetach(proc);
      throw new Error(`Session stdin did not drain within ${drainMs} ms; not detached`);
    }

    let offset: number;
    try {
      ({ offset } = await proc.detach({ orphanDeadlineMs: options.orphanDeadlineMs }));
    } catch (error) {
      this._rollBackDetach(proc);
      throw error;
    }
    // Every line handed out is processed before the state is read.
    await this._stdoutDone;

    const detached = new SessionDetached();
    for (const ack of this._steerAcks.values()) ack.reject(detached);
    this._steerAcks.clear();
    const pendingControl: Record<string, unknown>[] = [];
    for (const { controller, raw } of this._inbound.values()) {
      controller.abort();
      pendingControl.push(raw);
    }
    this._inbound.clear();
    for (const pending of this._control.values()) pending.reject(detached);
    this._control.clear();
    if (this._turnTimer) {
      clearTimeout(this._turnTimer);
      this._turnTimer = null;
    }

    // The base context directory is named for this process; the kept CLI still reads it.
    if (this._baseContextDir && proc.pid)
      writeFileSync(join(this._baseContextDir, OWNER_FILE), String(proc.pid), { mode: 0o600 });

    const turn = this._inflight;
    const snapshot: ClaudeSessionSnapshot = {
      snapshotVersion: CLAUDE_SESSION_SNAPSHOT_VERSION,
      externalSessionId: this._externalSessionId,
      hookCallbackId: this._hookCallbackId,
      cliPid: proc.pid,
      offset,
      promptUuids: [...this._promptUuids],
      promptLifecycleSeen: this._promptLifecycleSeen,
      steerUuids: [...this._steerUuids],
      seenTerminals: [...this._seenTerminals],
      seenBoundaries: [...this._seenBoundaries],
      liveTasks: [...this._liveTaskStarts.values()],
      pendingControl,
      inflight: turn
        ? {
            admissionId: turn.evidence.admissionId,
            identity: { ...turn.evidence.identity },
            content: turn.evidence.content,
            tokens: turn.evidence.tokens,
            timeout: turn.timeout,
            timeoutAt: turn.timeoutAt,
            prompt: turn.prompt && { ...turn.prompt },
            steers: [...(turn.steers ?? [])],
            held: turn.held && { ...turn.held },
            modelMissing: turn.modelMissing,
          }
        : undefined,
      wake: this._wake && { ...this._wake },
      wakeCause: this._wakeCause,
      turns: this._turns,
      totalTokens: { ...this._totalTokens },
      baseContextDir: this._baseContextDir,
    };

    this._inflight = null;
    if (turn && turn.evidence.localOutcome === 'pending')
      turn.reject(turn.evidence.fail(detached, 'detached'));
    this._proc = null;
    this._alive = false;
    // The directory now belongs to the kept CLI; this session no longer removes it.
    this._baseContextDir = undefined;
    this._detaching = false;
    return JSON.parse(JSON.stringify(snapshot)) as ClaudeSessionSnapshot;
  }

  /**
   * Rebuild a session `detach()` handed over, around the same native session. `config` is the
   * session's own (the snapshot holds state, never configuration). Register tool gates, then call
   * `resume(proc)` with the reattached keeper process. A turn that was in flight is adopted under
   * its admission id; `adoptedTurn` settles with it.
   */
  static fromSnapshot(
    snapshot: ClaudeSessionSnapshot,
    config: ClaudeCodeSessionConfig,
  ): ClaudeCodeSession {
    if (snapshot.snapshotVersion !== CLAUDE_SESSION_SNAPSHOT_VERSION)
      throw new Error(
        `Session snapshot version ${String(snapshot.snapshotVersion)} unknown (this build reads ${CLAUDE_SESSION_SNAPSHOT_VERSION})`,
      );
    const session = new ClaudeCodeSession({
      ...config,
      externalSessionId: snapshot.externalSessionId,
    });
    session._restore(snapshot);
    return session;
  }

  private _restore(snapshot: ClaudeSessionSnapshot): void {
    this._resumedFromSnapshot = true;
    this._fromSnapshot = {
      offset: snapshot.offset,
      liveTasks: snapshot.liveTasks,
      pendingControl: snapshot.pendingControl,
    };
    this._hookCallbackId = snapshot.hookCallbackId;
    this._promptUuids = new Set(snapshot.promptUuids);
    this._promptLifecycleSeen = snapshot.promptLifecycleSeen;
    this._steerUuids = new Set(snapshot.steerUuids);
    this._seenTerminals = new Set(snapshot.seenTerminals);
    this._seenBoundaries = new Set(snapshot.seenBoundaries);
    this._wake = snapshot.wake && { ...snapshot.wake };
    this._wakeCause = snapshot.wakeCause;
    this._turns = snapshot.turns;
    this._totalTokens = { ...snapshot.totalTokens };
    this._baseContextDir = snapshot.baseContextDir;
    const inflight = snapshot.inflight;
    if (!inflight) return;
    const evidence = new TurnState(inflight.admissionId);
    evidence.identity = { ...inflight.identity };
    evidence.content = inflight.content;
    evidence.tokens = inflight.tokens;
    evidence.dispatch = 'attempted';
    this._attempts.push(evidence);
    this._adoptedTurn = new Promise<SessionResult>((resolve, reject) => {
      this._inflight = {
        evidence,
        message: '',
        images: [],
        timeout: inflight.timeout,
        timeoutAt: inflight.timeoutAt,
        resolve,
        reject,
        prompt: inflight.prompt && { ...inflight.prompt },
        steers: new Map(inflight.steers),
        held: inflight.held && { ...inflight.held },
        modelMissing: inflight.modelMissing,
      };
    });
    // A caller that never awaits it must not see an unhandled rejection.
    this._adoptedTurn.catch(() => {});
  }

  /** The turn that was in flight at detach, adopted by this rebuilt session; settles as send() does. */
  get adoptedTurn(): Promise<SessionResult> | undefined {
    return this._adoptedTurn;
  }

  /**
   * Take over the reattached keeper process (`attachKeeper`, still held) of a session rebuilt by
   * `fromSnapshot`: tasks still running and approvals still asked are raised again, then the
   * keeper is released past the snapshot's offset and the session runs as if it had started it.
   */
  resume(proc: PipedSubprocess): void {
    const pending = this._fromSnapshot;
    if (!pending) throw new Error('Session was not rebuilt from a snapshot');
    if (this._proc) throw new Error('Session already running');
    if (!proc.release) throw new Error('resume() takes a keeper-held process');
    this._fromSnapshot = undefined;
    this._proc = proc;
    this._alive = true;
    this._endEmitted = false;
    this._emit({ kind: 'session_start', timestamp: Date.now(), raw: { resumed: true } });
    for (const raw of pending.liveTasks) this._processLine(JSON.stringify(raw));
    for (const raw of pending.pendingControl) this._processLine(JSON.stringify(raw));
    proc.release(pending.offset);
    this._stdoutDone = this._readStdout(proc);
    this._stderrDone = this._readStderr(proc);
    this._watchExit(proc);
    const turn = this._inflight;
    if (turn && turn.timeout > 0) {
      turn.timeoutAt ??= Date.now() + turn.timeout;
      const timeoutAt = turn.timeoutAt;
      // A result the CLI wrote while detached is read before the remaining time is counted.
      const arm = () => {
        if (this._inflight !== turn || this._proc !== proc) return;
        this._turnTimer = setTimeout(
          () => {
            this._turnTimer = null;
            this._rejectInflight(new Error(`Turn timed out after ${turn.timeout}ms`), 'timeout');
          },
          Math.max(0, timeoutAt - Date.now()),
        );
      };
      if (proc.replayed) void proc.replayed().then(arm, arm);
      else arm();
    }
  }

  /**
   * Undo a detach that could not hand over: the session keeps running, and an approval decided
   * meanwhile is written now. Waiting sends were already returned (`SessionReturned`).
   */
  private _rollBackDetach(proc: PipedSubprocess): void {
    this._detaching = false;
    for (const [requestId, inbound] of this._inbound) {
      if (!inbound.decided || inbound.controller.signal.aborted) continue;
      this._inbound.delete(requestId);
      if (this._proc === proc && this._alive)
        this._writeControlResponse(proc, requestId, inbound.decided);
    }
  }

  /** The deny a rebuilt session gives a gated request it cannot place (fail closed). */
  private _deniedAfterResume(
    request: Record<string, unknown> | undefined,
  ): Record<string, unknown> | undefined {
    if (request?.subtype === 'hook_callback')
      return this._toolResponse(
        { stage: 'pre-use', toolName: '', toolInput: {} },
        { behavior: 'deny', message: 'Tool gate: callback from before the restart has no gate' },
      );
    if (request?.subtype === 'can_use_tool')
      return {
        behavior: 'deny',
        message: 'Tool gate: approval from before the restart has no gate',
      };
    return undefined;
  }

  // ---------------------------------------------------------------------------
  // artifact() — full session record for Oracle
  // ---------------------------------------------------------------------------

  artifact(): SessionArtifact {
    return {
      externalSessionId: this._externalSessionId,
      attempts: this.attempts,
      accounting: 'observed-only',
      diagnostics: this.diagnostics,
      events: [...this._eventLog],
      startedAt: this._startedAt,
      endedAt: this._alive ? undefined : Date.now(),
      turns: this._turns,
      totalTokens: { ...this._totalTokens },
      toolCalls: this._eventLog.filter((e) => e.kind === 'tool_use').length,
      toolResults: this._eventLog.filter((e) => e.kind === 'tool_result').length,
      errors: this._eventLog.filter((e) => e.kind === 'error').length,
    };
  }

  // ---------------------------------------------------------------------------
  // Private — turn dispatch + queue
  // ---------------------------------------------------------------------------

  private _dispatchTurn(turn: QueuedTurn): void {
    this._inflight = turn;
    if (turn.onAdmission) {
      Promise.resolve()
        .then(() => turn.onAdmission!(turn.evidence.snapshot()))
        .then(() => {
          if (this._inflight === turn && this._alive && turn.evidence.localOutcome === 'pending')
            this._writeTurn(turn);
          else if (this._inflight === turn && turn.evidence.dispatch === 'not-dispatched') {
            this._inflight = null;
            this._processNextTurn();
          }
        })
        .catch((error) => {
          turn.reject(
            turn.evidence.fail(
              error instanceof Error ? error : new Error(String(error)),
              'registration',
            ),
          );
          if (this._inflight === turn) {
            this._inflight = null;
            this._processNextTurn();
          }
        });
      return;
    }
    this._writeTurn(turn);
  }

  private _writeTurn(turn: QueuedTurn): void {
    turn.evidence.dispatch = 'attempted';
    const uuid = Bun.randomUUIDv7();
    turn.prompt = { uuid, state: 'written' };
    this._promptUuids.add(uuid);

    // Wire format validated empirically against claude 2.1.114:
    // {type:"user", message:{role,content:[{type:"text",text}]}}
    // Alternative shapes ({type:"user_message"}, {role,content}) are silently dropped.
    // Images are Messages API base64 image blocks, ahead of the text they accompany.
    // The uuid makes the CLI report the message's command_lifecycle (validated against 2.1.326).
    const payload = `${JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: [
          ...turn.images.map((image) => ({
            type: 'image',
            source: { type: 'base64', media_type: image.mediaType, data: image.data },
          })),
          { type: 'text', text: turn.message },
        ],
      },
      uuid,
      parent_tool_use_id: null,
    })}\n`;
    try {
      this._proc!.stdin.write(payload);
      this._proc!.stdin.flush();
    } catch (err) {
      this._rejectInflight(err as Error);
      return;
    }

    // Timeout guard
    if (turn.timeout > 0) {
      turn.timeoutAt = Date.now() + turn.timeout;
      this._turnTimer = setTimeout(() => {
        this._turnTimer = null;
        this._rejectInflight(new Error(`Turn timed out after ${turn.timeout}ms`), 'timeout');
        // Don't dispatch next — process may still be working on this turn.
        // A late terminal updates this admission; waiting sends are not replayed.
      }, turn.timeout);
    }
  }

  private _resolveTurn(): void {
    if (!this._inflight) return;

    if (this._turnTimer) {
      clearTimeout(this._turnTimer);
      this._turnTimer = null;
    }

    const a = this._inflight.evidence;
    if (a.nativeOutcome === 'unknown') return;
    this._turns++;
    const missing = a.nativeOutcome === 'failed' ? this._inflight.modelMissing : undefined;
    if (a.localOutcome === 'pending' && missing)
      this._inflight.reject(
        a.fail(new NativeModelMissingError('claude-code', this._model, missing), undefined),
      );
    else if (a.localOutcome === 'pending') {
      a.localOutcome = 'resolved';
      this._inflight.resolve(a.result(this._externalSessionId));
    }
    this._inflight = null;

    this._processNextTurn();
  }

  private _processNextTurn(): void {
    if (!this._inflight && this._queue.length > 0 && this._alive && !this._detaching) {
      const next = this._queue.shift()!;
      this._dispatchTurn(next);
    }
  }

  private _rejectInflight(err: Error, reason: SessionAttempt['localFailure'] = 'transport'): void {
    if (!this._inflight) return;
    if (this._turnTimer) {
      clearTimeout(this._turnTimer);
      this._turnTimer = null;
    }
    const a = this._inflight.evidence;
    if ((reason === 'transport' || reason === 'killed') && a.transportOutcome === 'open')
      a.transportOutcome = reason === 'killed' ? 'closed' : 'failed';
    if (a.localOutcome === 'pending') this._inflight.reject(a.fail(err, reason));
    this._rejectQueue(
      reason === 'killed'
        ? err
        : new Error('Previous native work unresolved; queued send not dispatched'),
    );
  }

  private _transportFailure(err: Error): void {
    this._alive = false;
    this._rejectInflight(err);
    this._rejectQueue(err);
    this._rejectControl(err);
    this._emit({ kind: 'session_end', timestamp: Date.now(), transportOutcome: 'failed' });
  }

  private _rejectQueue(
    err: Error,
    reason: SessionAttempt['localFailure'] = err instanceof SessionReturned
      ? 'returned'
      : 'blocked',
  ): void {
    for (const turn of this._queue) {
      turn.reject(turn.evidence.fail(err, reason));
    }
    this._queue = [];
  }

  // ---------------------------------------------------------------------------
  // Private — stdout reader (background, runs for session lifetime)
  // ---------------------------------------------------------------------------

  private async _readStdout(proc: PipedSubprocess): Promise<void> {
    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop()!; // Keep incomplete line in buffer

        for (const line of lines) {
          if (!line.trim()) continue;
          if (this._proc === proc || !this._proc) this._processLine(line);
        }
      }

      // Flush remaining buffer
      if (buffer.trim() && (this._proc === proc || !this._proc)) {
        this._processLine(buffer);
      }
      if (this._proc === proc && this._alive && !proc.detached) {
        const detail = this._stderr.trim()
          ? `Native stdout closed: ${this._stderr.trim().slice(0, 500)}`
          : 'Native stdout closed';
        this._transportFailure((await this._settleMissing(detail)) ?? new Error(detail));
      }
    } catch (err) {
      if (this._proc === proc && !proc.detached) this._transportFailure(err as Error);
    }
  }

  // ---------------------------------------------------------------------------
  // Private — stderr reader (accumulates for error context)
  // ---------------------------------------------------------------------------

  private async _readStderr(proc: PipedSubprocess): Promise<void> {
    const reader = proc.stderr.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        this._stderr += decoder.decode(value, { stream: true });
      }
    } catch {
      /* ignore */
    }
  }

  // ---------------------------------------------------------------------------
  // Private — JSON line processor
  // ---------------------------------------------------------------------------

  private _processLine(line: string): void {
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }

    const raw = msg as Record<string, unknown>;

    // Control-protocol traffic belongs to the local client, never to an admission.
    if (raw.type === 'control_response') {
      const response = raw.response as Record<string, unknown> | undefined;
      const id = typeof response?.request_id === 'string' ? response.request_id : undefined;
      const pending = id ? this._control.get(id) : undefined;
      if (pending && id) {
        this._control.delete(id);
        if (response?.subtype === 'success') pending.resolve(response);
        else
          pending.reject(
            new Error(
              typeof response?.error === 'string' ? response.error : 'Control request failed',
            ),
          );
      }
      return;
    }
    if (raw.type === 'control_cancel_request') {
      const id = typeof raw.request_id === 'string' ? raw.request_id : undefined;
      const inbound = id ? this._inbound.get(id) : undefined;
      if (inbound && id) {
        this._inbound.delete(id);
        inbound.controller.abort();
      }
      return;
    }
    if (raw.type === 'control_request') {
      const id = typeof raw.request_id === 'string' ? raw.request_id : undefined;
      const request = raw.request as Record<string, unknown> | undefined;
      if (id && this._proc && this._extension && this._extensionRequest(this._proc, id, request))
        return;
      const toolRequest =
        id && this._toolGate && this._proc ? this._toolRequestFrom(request) : undefined;
      if (id && toolRequest) {
        this._answerToolRequest(this._proc!, id, toolRequest, raw);
        return;
      }
      // A gated ask or our own callback that cannot be read is denied: an error reply allows.
      const unreadable = id && this._toolGate && this._proc ? this._unreadable(request) : undefined;
      if (id && unreadable) {
        this._writeControlResponse(this._proc!, id, unreadable);
        this._unattributed(raw, 'unrecognized-event');
        return;
      }
      // A rebuilt session may hear a callback registered by a gate it no longer has: never allow it.
      const denied =
        id && this._proc && this._resumedFromSnapshot
          ? this._deniedAfterResume(request)
          : undefined;
      if (id && denied) {
        this._writeControlResponse(this._proc!, id, denied);
        this._unattributed(raw, 'unrecognized-event');
        return;
      }
      // No other client-side handlers are registered on this transport.
      if (id && this._proc) {
        try {
          this._proc.stdin.write(
            `${JSON.stringify({
              type: 'control_response',
              response: { subtype: 'error', request_id: id, error: 'Unsupported by this client' },
            })}\n`,
          );
          this._proc.stdin.flush();
        } catch {
          /* transport failure surfaces on the stream */
        }
      }
      this._unattributed(raw, 'unrecognized-event');
      return;
    }

    if (
      this._awaitingForkIdentity &&
      raw.type === 'system' &&
      raw.subtype === 'init' &&
      typeof raw.session_id === 'string'
    ) {
      this._externalSessionId = raw.session_id;
      this._awaitingForkIdentity = false;
    }
    // A foreign session or repeated result UUID cannot own the current admission.
    if (
      typeof raw.session_id === 'string' &&
      this._externalSessionId &&
      raw.session_id !== this._externalSessionId
    ) {
      this._unattributed(raw, 'foreign-session');
      return;
    }
    const terminalKey =
      raw.type === 'result' && typeof raw.uuid === 'string' ? raw.uuid : undefined;
    if (terminalKey && this._seenTerminals.has(terminalKey)) {
      this._unattributed(raw, 'duplicate-terminal');
      return;
    }
    // Capture the runtime's native session ID the first time we see it.
    // Subsequent messages echo the same ID; we keep our initial capture
    // (for resumed sessions, the config-supplied ID should match).
    if (typeof raw.session_id === 'string' && !this._externalSessionId) {
      this._externalSessionId = raw.session_id;
    }

    // Lifecycle/configuration envelopes belong to the session, not to whichever
    // admission is in flight. Every init is preserved once with its binding; it is
    // never attributed to a turn and never compared against an earlier init to infer
    // compaction or restart. Only an explicit compact_boundary is a compaction, and
    // it is emitted exactly once per native uuid with this session's provenance.
    // Foreign bindings were already refused above and cannot invalidate this owner.
    if (raw.type === 'system' && raw.subtype === 'init') {
      this._unattributed(raw, 'session-configuration');
      return;
    }
    if (raw.type === 'system' && raw.subtype === 'compact_boundary') {
      const boundaryKey = typeof raw.uuid === 'string' ? raw.uuid : undefined;
      if (boundaryKey && this._seenBoundaries.has(boundaryKey)) {
        this._unattributed(raw, 'duplicate-boundary');
        return;
      }
      if (boundaryKey) this._seenBoundaries.add(boundaryKey);
      this._emit({
        kind: 'session_compact',
        timestamp: Date.now(),
        correlation: 'unknown',
        nativeSessionId:
          typeof raw.session_id === 'string' ? raw.session_id : this._externalSessionId,
        externalSessionId: this._externalSessionId,
        compactionSource: 'claude-code',
        raw,
      });
      return;
    }

    // A steer's lifecycle: the CLI naming a message push() wrote into the owned turn.
    if (raw.type === 'command_lifecycle' && typeof raw.command_uuid === 'string') {
      const turn = this._inflight;
      const state = raw.state;
      // The turn's own message: the CLI starts it once any turn of its own has ended.
      if (this._promptUuids.has(raw.command_uuid)) {
        this._promptLifecycleSeen = true;
        if (state === 'completed' || state === 'cancelled')
          this._promptUuids.delete(raw.command_uuid);
        if (
          turn?.prompt?.uuid === raw.command_uuid &&
          (state === 'queued' ||
            state === 'started' ||
            state === 'completed' ||
            state === 'cancelled')
        )
          turn.prompt.state = state;
        // The CLI took our message in before its own turn's result: what follows is ours.
        if (state === 'started') this._endWake({ status: 'unknown', reason: 'message started' });
        return;
      }
      const ours = this._steerUuids.has(raw.command_uuid);
      if (ours && (state === 'completed' || state === 'cancelled'))
        this._steerUuids.delete(raw.command_uuid);
      if (
        turn?.steers?.has(raw.command_uuid) &&
        (state === 'queued' ||
          state === 'started' ||
          state === 'completed' ||
          state === 'cancelled')
      ) {
        turn.steers.set(raw.command_uuid, state);
        this._steerAcks.get(raw.command_uuid)?.resolve(state);
        if (state === 'cancelled') this._releaseHeld(turn);
        return;
      }
      // A steer's own end after its turn settled (its follow-on result settled the turn first).
      if (!ours) this._unattributed(raw, 'no-admission');
      return;
    }

    // Account limits are account-level evidence, never part of an admission's output.
    if (raw.type === 'rate_limit_event') {
      const snapshot = claudeRateLimitSnapshot(raw.rate_limit_info);
      if (snapshot) this._observeLimits(snapshot);
      else this._unattributed(raw, 'account-status');
      return;
    }

    if (raw.type === 'system' && typeof raw.task_id === 'string' && raw.task_id) {
      if (raw.subtype === 'task_started') this._liveTaskStarts.set(raw.task_id, raw);
      else if (raw.subtype === 'task_notification') this._liveTaskStarts.delete(raw.task_id);
    }

    // An extension's own agents (their frames and task lifecycle) are its alone.
    if (this._extension) {
      let own = false;
      try {
        own = this._extension.frame(raw);
      } catch {
        /* an extension's failure never touches the session */
      }
      if (own) return;
    }

    // A subagent's frames and lifecycle are never part of an admission, whichever turn is in flight
    // (a background subagent outlives the turn that started it): they reach handlers tagged
    // `subagent`, with the spawning call in `parentToolUseId`.
    const parentToolUseId =
      typeof raw.parent_tool_use_id === 'string' && raw.parent_tool_use_id
        ? raw.parent_tool_use_id
        : undefined;
    const lifecycle = this._subagentLifecycle(raw);
    // A background task (a shell, a monitor) outlives its turn like a subagent: never an admission's.
    const task = lifecycle || parentToolUseId ? undefined : this._taskLifecycle(raw);
    if (task) {
      if (task.phase === 'ended') this._wakeCause = task.summary ?? task.description;
      this._emit({
        kind: 'task',
        timestamp: Date.now(),
        task,
        raw,
        correlation: 'unknown',
        unattributedReason: 'task',
        nativeSessionId: typeof raw.session_id === 'string' ? raw.session_id : undefined,
      });
      return;
    }
    if (lifecycle?.phase === 'ended' && lifecycle.backgrounded)
      this._wakeCause = lifecycle.description;
    if (parentToolUseId || lifecycle) {
      const message = raw.message as Record<string, unknown> | undefined;
      const events: SessionEvent[] = lifecycle
        ? [{ kind: 'subagent', timestamp: Date.now(), subagent: lifecycle, raw }]
        : this._classify(raw, parentToolUseId);
      if (!events.length) {
        this._unattributed(raw, 'subagent');
        return;
      }
      for (const event of events)
        this._emit({
          ...event,
          correlation: 'unknown',
          unattributedReason: 'subagent',
          nativeSessionId: typeof raw.session_id === 'string' ? raw.session_id : undefined,
          messageId: typeof message?.id === 'string' ? message.id : undefined,
        });
      return;
    }

    const turn = this._inflight;
    if (!turn) {
      if (terminalKey) this._seenTerminals.add(terminalKey);
      if (this._wakeOpens(turn, raw)) this._wakeFrame(raw);
      else this._unattributed(raw, 'no-admission');
      return;
    }
    // A turn the CLI ran for itself (a task notification) while this turn's message waited: its
    // frames and its result are not this turn's, which starts when the CLI starts the message.
    if (this._promptWaiting(turn) || (this._wake && turn.prompt?.state !== 'started')) {
      if (terminalKey) this._seenTerminals.add(terminalKey);
      if (this._wakeOpens(turn, raw)) this._wakeFrame(raw);
      else this._unattributed(raw, 'foreign-turn');
      return;
    }
    const a = turn.evidence;
    a.identity = {
      ...a.identity,
      nativeSessionId:
        typeof raw.session_id === 'string' ? raw.session_id : a.identity.nativeSessionId,
      correlation: 'ordered-stream',
    };
    if (raw.type === 'assistant' && raw.error === 'model_not_found') {
      const content = (raw.message as { content?: unknown } | undefined)?.content;
      const block = Array.isArray(content) ? (content[0] as { text?: unknown }) : undefined;
      turn.modelMissing =
        typeof block?.text === 'string' && block.text
          ? block.text
          : `Model ${this._model} not found`;
    }
    const terminal = raw.type === 'result';
    let holding = false;
    if (terminal) {
      if (terminalKey) this._seenTerminals.add(terminalKey);
      const { outcome, subtype, reason, status } = claudeResultOutcome(raw);
      a.nativeOutcome = outcome;
      // A steer the CLI has not started yet runs after this result, still in this turn: the turn
      // stays open (and this result reads as an intermediate one) until the steer's own result.
      if (a.nativeOutcome === 'completed' && this._steerWaiting(turn)) {
        holding = true;
        a.nativeOutcome = 'unknown';
      }
      a.terminal = {
        type: 'result',
        eventId: terminalKey,
        subtype,
        reason,
        apiErrorStatus: status,
      };
    }
    const message = raw.message as Record<string, unknown> | undefined;
    const classified = this._classify(raw);
    if (!classified.length) this._unattributed(raw, 'unrecognized-event');
    for (const event of classified) {
      const e = a.record({
        ...event,
        messageId: typeof message?.id === 'string' ? message.id : undefined,
        ...(terminal ? { nativeOutcome: a.nativeOutcome, terminal: a.terminal } : {}),
      });
      // Native result usage is authoritative for the whole turn. Request
      // snapshots can repeat across content blocks and must not be added again.
      if (e.kind === 'result' && e.tokens) {
        for (const key of [
          'input',
          'output',
          'cacheRead',
          'cacheWrite',
          'cacheWrite5m',
          'cacheWrite1h',
          'thinking',
        ] as const) {
          const value = e.tokens[key];
          if (value !== undefined) this._totalTokens[key] = (this._totalTokens[key] ?? 0) + value;
        }
      }
      this._emit(e);
    }
    if (terminal) {
      // Each result reports its own run's usage: the turn's is their sum.
      const tokens = addTokens(turn.held?.tokens, a.tokens);
      if (holding) {
        turn.held = { nativeOutcome: 'completed', ...(tokens ? { tokens } : {}) };
        a.tokens = tokens;
        return;
      }
      turn.held = undefined;
      a.tokens = tokens;
      if (a.nativeOutcome === 'failed') void this._withdrawSteers(turn, 2_000);
      if (a.nativeOutcome !== 'unknown') this._resolveTurn();
      else
        this._rejectInflight(
          new Error('Native result has no recognized terminal status'),
          'unrecognized-terminal',
        );
    }
  }

  // ---------------------------------------------------------------------------
  // Private — tool gate (control protocol: hook_callback, can_use_tool)
  // ---------------------------------------------------------------------------

  private _toolRequestFrom(
    request: Record<string, unknown> | undefined,
  ): Omit<ToolRequest, 'signal'> | undefined {
    const record = (value: unknown) =>
      value && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined;
    const text = (value: unknown) => (typeof value === 'string' && value ? value : undefined);
    let stage: ToolRequest['stage'];
    let source: Record<string, unknown> | undefined;
    let toolName: string | undefined;
    let toolInput: Record<string, unknown> | undefined;
    if (request && this._ownHookCallback(request)) {
      source = record(request.input);
      if (source?.hook_event_name !== 'PreToolUse') return undefined;
      stage = 'pre-use';
      toolName = text(source.tool_name);
      toolInput = record(source.tool_input);
    } else if (request?.subtype === 'can_use_tool') {
      source = request;
      stage = 'permission';
      toolName = text(request.tool_name);
      toolInput = record(request.input);
    } else return undefined;
    if (!toolName) return undefined;
    const callId = text(source?.tool_use_id) ?? text(request.tool_use_id);
    const agentId = text(source?.agent_id) ?? text(request.agent_id);
    const turn = this._inflight;
    return {
      stage,
      toolName,
      ...mcpToolParts(toolName),
      toolInput: Object.freeze(structuredClone(toolInput ?? {})),
      ...(callId ? { callId } : {}),
      ...(turn?.evidence.dispatch === 'attempted' && turn.evidence.nativeOutcome === 'unknown'
        ? { admissionId: turn.evidence.admissionId }
        : {}),
      ...(text(request.description) ? { description: text(request.description) } : {}),
      ...(text(request.decision_reason) ? { decisionReason: text(request.decision_reason) } : {}),
      ...(text(request.blocked_path) ? { blockedPath: text(request.blocked_path) } : {}),
      ...(agentId ? { agentId } : {}),
    };
  }

  /**
   * A control request the extension answers: an MCP message for its servers, or a PreToolUse
   * callback / permission ask that belongs to its agents or spawns one of its agent types. With no
   * tool gate, our callback's other calls get no opinion (the session's permission mode decides).
   */
  private _extensionRequest(
    proc: PipedSubprocess,
    id: string,
    request: Record<string, unknown> | undefined,
  ): boolean {
    const extension = this._extension!;
    try {
      if (
        request?.subtype === 'mcp_message' &&
        typeof request.server_name === 'string' &&
        extension.mcpServers.includes(request.server_name)
      ) {
        extension.mcp(request.server_name, id, (request.message ?? {}) as Record<string, unknown>);
        return true;
      }
      if (this._ownHookCallback(request)) {
        const input = request!.input as Record<string, unknown> | undefined;
        const output = input ? extension.preToolUse(input) : undefined;
        if (output) {
          this._writeControlResponse(proc, id, { hookSpecificOutput: output });
          return true;
        }
        if (!this._toolGate) {
          this._writeControlResponse(proc, id, {});
          return true;
        }
        return false;
      }
      if (request?.subtype === 'can_use_tool') {
        const answer = extension.permission(request);
        if (answer) {
          this._writeControlResponse(proc, id, answer);
          return true;
        }
      }
    } catch {
      /* an extension's failure falls through to the session's own handling */
    }
    return false;
  }

  private _ownHookCallback(request: Record<string, unknown> | undefined): boolean {
    return request?.subtype === 'hook_callback' && request.callback_id === this._hookCallbackId;
  }

  /** The deny for a gated request _toolRequestFrom could not read; undefined when not ours. */
  private _unreadable(
    request: Record<string, unknown> | undefined,
  ): Record<string, unknown> | undefined {
    if (this._ownHookCallback(request))
      return this._toolResponse(
        { stage: 'pre-use', toolName: '', toolInput: {} },
        { behavior: 'deny', message: 'Tool gate: unreadable PreToolUse callback' },
      );
    if (request?.subtype === 'can_use_tool')
      return { behavior: 'deny', message: 'Tool gate: unreadable permission request' };
    return undefined;
  }

  private _answerToolRequest(
    proc: PipedSubprocess,
    requestId: string,
    request: Omit<ToolRequest, 'signal'>,
    raw: Record<string, unknown>,
  ): void {
    const controller = new AbortController();
    const inbound: InboundGate = { controller, raw };
    this._inbound.set(requestId, inbound);
    void this._gates
      .decide({ ...request, signal: controller.signal })
      .then((decision) => {
        // Withdrawn by the runtime, or the process is gone: nothing may be written for it.
        if (controller.signal.aborted || this._proc !== proc || !this._alive) return;
        // While detaching it stays pending, so the next owner asks it again; a detach that rolls
        // back writes it then.
        if (this._detaching) {
          inbound.decided = this._toolResponse(request, decision);
          return;
        }
        this._inbound.delete(requestId);
        this._writeControlResponse(proc, requestId, this._toolResponse(request, decision));
      })
      .finally(() => {
        if (!this._detaching && this._inbound.get(requestId)?.controller === controller)
          this._inbound.delete(requestId);
      });
  }

  private _toolResponse(
    request: Omit<ToolRequest, 'signal'>,
    decision: ToolDecision | undefined,
  ): Record<string, unknown> {
    if (request.stage === 'pre-use')
      return decision?.behavior === 'deny'
        ? {
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              permissionDecision: 'deny',
              permissionDecisionReason: decision.message,
            },
          }
        : decision?.updatedInput || decision?.context
          ? // No permission decision: the call runs (with any new input) under the session's own mode.
            {
              hookSpecificOutput: {
                hookEventName: 'PreToolUse',
                ...(decision.updatedInput
                  ? { updatedInput: structuredClone(decision.updatedInput) }
                  : {}),
                ...(decision.context ? { additionalContext: decision.context } : {}),
              },
            }
          : {};
    return decision?.behavior === 'allow'
      ? { behavior: 'allow', updatedInput: structuredClone(request.toolInput) }
      : { behavior: 'deny', message: decision?.message ?? 'Denied' };
  }

  private _writeControlResponse(
    proc: PipedSubprocess,
    requestId: string,
    response: Record<string, unknown>,
  ): void {
    try {
      proc.stdin.write(
        `${JSON.stringify({
          type: 'control_response',
          response: { subtype: 'success', request_id: requestId, response },
        })}\n`,
      );
      proc.stdin.flush();
    } catch {
      /* transport failure surfaces on the stream */
    }
  }

  // ---------------------------------------------------------------------------
  // Private — spawn args (called once at start())
  // ---------------------------------------------------------------------------

  private _buildSpawnArgs(): string[] {
    // --print + --input-format stream-json = multi-turn stream over stdin
    // --output-format stream-json requires --verbose
    const args: string[] = [
      '--print',
      '--verbose',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--model',
      this._model,
      ...(this._effort ? ['--effort', this._effort] : []),
      ...(this._maxTurns === null ? [] : ['--max-turns', String(this._maxTurns)]),
      '--permission-mode',
      this._permissionMode,
      '--include-hook-events',
      ...(this._toolGate ? ['--permission-prompt-tool', 'stdio'] : []),
    ];

    // Resume for fork or crash recovery. _externalSessionId is set from
    // config (crash recovery / fork) or from the stream. Either way, if
    // it's present at spawn time, we --resume.
    if (this._textOnly) args.push(...CLAUDE_TEXT_ONLY_ARGS);
    if (!this._persistSession) args.push('--no-session-persistence');

    if (this._externalSessionId) {
      args.push('--resume', this._externalSessionId);
      if (this._forking) {
        args.push('--fork-session');
        this._awaitingForkIdentity = true;
        this._forking = false;
      }
    }

    // Stable base context injected once at process startup
    if (this._baseContext) {
      args.push('--append-system-prompt-file', this._writeBaseContext(this._baseContext));
    }
    // An extension's agents, from a private file; its MCP servers are declared in `initialize`.
    if (this._extension) args.push('--agents', this._writeAgents(this._extension.agents));

    return args;
  }

  private _writeAgents(agents: ClaudeSessionExtension['agents']): string {
    this._removeAgents();
    this._agentsDir = mkdtempSync(join(tmpdir(), `${BASE_CONTEXT_PREFIX}${process.pid}-agents-`));
    const file = join(this._agentsDir, 'agents.json');
    writeFileSync(file, JSON.stringify(agents), { mode: 0o600 });
    return file;
  }

  private _removeAgents(dir = this._agentsDir): void {
    if (!dir) return;
    rmSync(dir, { recursive: true, force: true });
    if (dir === this._agentsDir) this._agentsDir = undefined;
  }

  /** The base context as a private file: argv carries its path, never its text. */
  private _writeBaseContext(text: string): string {
    this._removeBaseContext();
    if (!swept) {
      swept = true;
      sweepOrphanedBaseContexts();
    }
    this._baseContextDir = mkdtempSync(join(tmpdir(), `${BASE_CONTEXT_PREFIX}${process.pid}-`));
    const file = join(this._baseContextDir, 'append-system-prompt.md');
    writeFileSync(file, text, { mode: 0o600 });
    return file;
  }

  /** Remove a spawn's base context directory: the current one by default. */
  private _removeBaseContext(dir = this._baseContextDir): void {
    if (!dir) return;
    rmSync(dir, { recursive: true, force: true });
    if (dir === this._baseContextDir) this._baseContextDir = undefined;
  }

  // ---------------------------------------------------------------------------
  // Private — event classification
  // ---------------------------------------------------------------------------

  /**
   * A Claude Code `system` task frame for a subagent (`task_type: local_agent`), as lifecycle. Other
   * task types (a background shell, a monitor, a workflow) are not subagents and return nothing.
   * Later phases carry no task type, so the session remembers which task ids are subagents.
   */
  private _subagentLifecycle(msg: Record<string, unknown>): SubagentLifecycle | undefined {
    if (msg.type !== 'system' || typeof msg.subtype !== 'string') return undefined;
    const phase = CLAUDE_TASK_PHASES[msg.subtype];
    const taskId = typeof msg.task_id === 'string' && msg.task_id ? msg.task_id : undefined;
    if (!phase || !taskId) return undefined;
    if (phase === 'started') {
      const agent =
        msg.task_type === 'local_agent' ||
        (msg.task_type === undefined && typeof msg.subagent_type === 'string');
      if (!agent) return undefined;
      this._agentTasks.add(taskId);
    } else if (!this._agentTasks.has(taskId)) return undefined;
    if (phase === 'ended') this._agentTasks.delete(taskId);
    return claudeSubagentLifecycle(msg, phase, taskId);
  }

  /**
   * Whether a frame no admission owns is (or opens) a turn the CLI started itself: none of this
   * session's messages is running (`turn`'s own may wait), and only the model speaking opens one
   * (a lone result or a session's status frame opens nothing).
   */
  private _wakeOpens(turn: QueuedTurn | null, raw: Record<string, unknown>): boolean {
    if (this._wake) return true;
    if (!this._promptLifecycleSeen || this._steerUuids.size || raw.type !== 'assistant')
      return false;
    for (const uuid of this._promptUuids) if (uuid !== turn?.prompt?.uuid) return false;
    return true;
  }

  /**
   * A frame of a turn the CLI started itself. Its events fold as an admission's would, but belong
   * to none (`unattributedReason: 'task'`); the turn is a `task` lifecycle (`claude-wake`) keyed by
   * a minted id, described by what last ended in the background, and ended by its result.
   */
  private _wakeFrame(raw: Record<string, unknown>): void {
    if (!this._wake) {
      this._wake = {
        id: Bun.randomUUIDv7(),
        nativeSessionId:
          typeof raw.session_id === 'string' ? raw.session_id : this._externalSessionId,
      };
      const description = this._wakeCause;
      this._wakeCause = undefined;
      this._emit(this._wakeLifecycle('started', description ? { description } : {}));
    }
    const base = this._wakeBase();
    const message = raw.message as Record<string, unknown> | undefined;
    const messageId = typeof message?.id === 'string' ? message.id : undefined;
    if (raw.type !== 'result') {
      const events = this._classify(raw);
      if (!events.length)
        this._emit({ ...base, kind: 'native_status', timestamp: Date.now(), messageId, raw });
      for (const event of events) this._emit({ ...event, ...base, messageId });
      return;
    }
    const { outcome, subtype, reason, status } = claudeResultOutcome(raw);
    const terminal = {
      type: 'result',
      eventId: typeof raw.uuid === 'string' ? raw.uuid : undefined,
      subtype,
      reason,
      apiErrorStatus: status,
    };
    for (const event of this._classify(raw))
      this._emit({ ...event, ...base, messageId, nativeOutcome: outcome, terminal });
    const text = typeof raw.result === 'string' && raw.result ? raw.result : undefined;
    this._endWake({
      status: outcome,
      ...(reason ? { reason } : {}),
      ...(text ? { summary: text } : {}),
    });
  }

  private _wakeBase() {
    return {
      nativeSessionId: this._wake?.nativeSessionId,
      turnId: this._wake?.id,
      correlation: 'native-turn' as const,
      unattributedReason: 'task' as const,
    };
  }

  private _wakeLifecycle(
    phase: 'started' | 'ended',
    extra: Partial<TaskLifecycle> = {},
  ): SessionEvent {
    return {
      ...this._wakeBase(),
      kind: 'task',
      timestamp: Date.now(),
      task: { phase, taskId: this._wake!.id, taskType: 'claude-wake', ...extra },
    };
  }

  private _endWake(extra: Partial<TaskLifecycle>): void {
    if (!this._wake) return;
    const ended = this._wakeLifecycle('ended', extra);
    this._wake = null;
    this._emit(ended);
  }

  /**
   * A Claude Code `system` task frame for a task that is not a subagent (`task_type` other than
   * `local_agent`), as lifecycle. Later phases carry no task type: the session remembers it.
   */
  private _taskLifecycle(msg: Record<string, unknown>): TaskLifecycle | undefined {
    if (msg.type !== 'system' || typeof msg.subtype !== 'string') return undefined;
    const phase = CLAUDE_TASK_PHASES[msg.subtype];
    const taskId = typeof msg.task_id === 'string' && msg.task_id ? msg.task_id : undefined;
    if (!phase || !taskId) return undefined;
    if (phase === 'started') {
      if (typeof msg.task_type !== 'string' || msg.task_type === 'local_agent') return undefined;
      this._otherTasks.set(taskId, msg.task_type);
    }
    const taskType = this._otherTasks.get(taskId);
    if (!taskType) return undefined;
    if (phase === 'ended') this._otherTasks.delete(taskId);
    const text = (value: unknown) => (typeof value === 'string' && value ? value : undefined);
    const patch =
      msg.patch && typeof msg.patch === 'object' && !Array.isArray(msg.patch)
        ? (msg.patch as Record<string, unknown>)
        : undefined;
    const status = text(msg.status) ?? text(patch?.status);
    return {
      phase,
      taskId,
      taskType,
      ...(text(msg.tool_use_id) ? { toolUseId: text(msg.tool_use_id) } : {}),
      ...(text(msg.description) ? { description: text(msg.description) } : {}),
      ...(status ? { status } : {}),
      ...(text(msg.reason) ? { reason: text(msg.reason) } : {}),
      ...(text(msg.summary) ? { summary: text(msg.summary) } : {}),
    };
  }

  private _classify(msg: Record<string, unknown>, parentToolUseId?: string): SessionEvent[] {
    return this._classifyFrame(msg).map((event) =>
      parentToolUseId ? { ...event, parentToolUseId } : event,
    );
  }

  private _classifyFrame(msg: Record<string, unknown>): SessionEvent[] {
    const events: SessionEvent[] = [];
    const ts = Date.now();

    const type = msg.type as string | undefined;

    if (type === 'assistant') {
      const message = msg.message as Record<string, unknown> | undefined;
      const tokens = parseClaudeUsage(message?.usage);
      if (tokens) {
        // Preserve the envelope (message/request IDs, model and usage tags),
        // including when a process dies before the terminal result arrives.
        events.push({ kind: 'usage', timestamp: ts, tokens, raw: msg });
      }
      const content = message?.content;
      if (!Array.isArray(content)) return events;

      for (const block of content) {
        const blockType = (block as Record<string, unknown>).type as string;

        if (blockType === 'text') {
          const text = (block as Record<string, unknown>).text as string | undefined;
          if (text) {
            events.push({ kind: 'text', timestamp: ts, text, raw: block });
          }
        } else if (blockType === 'tool_use') {
          events.push({
            kind: 'tool_use',
            timestamp: ts,
            callId: typeof block.id === 'string' ? block.id : undefined,
            itemId: typeof block.id === 'string' ? block.id : undefined,
            toolName: (block as Record<string, unknown>).name as string,
            toolInput: (block as Record<string, unknown>).input as Record<string, unknown>,
            raw: block,
          });
        } else if (blockType === 'thinking') {
          const b = block as Record<string, unknown>;
          events.push({
            kind: 'thinking',
            timestamp: ts,
            text: (b.thinking ?? b.text ?? b.content) as string | undefined,
            raw: block,
          });
        }
      }
    } else if (type === 'user') {
      const message = msg.message as Record<string, unknown> | undefined;
      if (Array.isArray(message?.content))
        for (const block of message.content) {
          if (block?.type !== 'tool_result') continue;
          events.push({
            kind: 'tool_result',
            timestamp: ts,
            callId: typeof block.tool_use_id === 'string' ? block.tool_use_id : undefined,
            ...publicToolResultContent(block.content),
            toolError: block.is_error === true,
            raw: block,
          });
        }
    } else if (type === 'tool') {
      // Tool result — what the tool returned
      const content = msg.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          const b = block as Record<string, unknown>;
          events.push({
            kind: 'tool_result',
            timestamp: ts,
            toolOutput:
              typeof b.text === 'string'
                ? b.text
                : typeof b.content === 'string'
                  ? b.content
                  : JSON.stringify(block),
            toolError: b.is_error === true,
            raw: block,
          });
        }
      } else if (content != null) {
        events.push({
          kind: 'tool_result',
          timestamp: ts,
          toolOutput: typeof content === 'string' ? content : JSON.stringify(content),
          raw: content,
        });
      }
    } else if (type === 'result') {
      events.push({
        kind: 'result',
        timestamp: ts,
        text: (msg.result as string) ?? '',
        externalSessionId: msg.session_id as string | undefined,
        tokens: parseClaudeUsage(msg.usage),
        raw: msg,
      });
    } else if (type === 'error') {
      const error = msg.error as Record<string, unknown> | undefined;
      events.push({
        kind: 'error',
        timestamp: ts,
        text: (error?.message as string) ?? (msg.message as string) ?? JSON.stringify(msg),
        raw: msg,
      });
    }
    // Hook events, system events, etc. are captured via the `raw` field
    // on classified events. Unclassified event types are preserved in
    // the raw stream for Oracle introspection.

    return events;
  }

  // ---------------------------------------------------------------------------
  // Private — emit
  // ---------------------------------------------------------------------------

  private _unattributed(
    raw: Record<string, unknown>,
    reason: NonNullable<SessionEvent['unattributedReason']>,
  ): void {
    const message = raw.message as Record<string, unknown> | undefined;
    // Preserve the original envelope once, without synthesizing admission/native ownership.
    this._emit({
      kind: 'native_status',
      timestamp: Date.now(),
      correlation: 'unknown',
      unattributedReason: reason,
      nativeSessionId: typeof raw.session_id === 'string' ? raw.session_id : undefined,
      messageId: typeof message?.id === 'string' ? message.id : undefined,
      raw,
    });
  }

  private _emit(event: SessionEvent): void {
    event = retainEvidence(event);
    if (event.kind === 'session_end') {
      if (this._endEmitted) return;
      this._endWake({ status: 'killed', reason: 'session ended' });
      this._wakeCause = undefined;
      this._endEmitted = true;
    }
    this._eventLog.push(event);
    for (const handler of this._handlers) {
      try {
        const observation: unknown = handler(event);
        if (observation && typeof (observation as PromiseLike<unknown>).then === 'function') {
          void Promise.resolve(observation).catch(() => {
            this._observerFailures.asynchronous++;
          });
        }
      } catch {
        this._observerFailures.synchronous++;
      }
    }
  }
}

const BASE_CONTEXT_PREFIX = 'agent-session-base-';
/** Written by detach(): the kept CLI's pid, which owns the directory from then on. */
const OWNER_FILE = 'owner';
let swept = false;

/**
 * Remove base context files a crashed or killed process left behind (each holds a whole composed
 * context). Runs once per process; a directory belongs to the pid in its name and goes only when
 * that process is gone.
 */
export function sweepOrphanedBaseContexts(dir = tmpdir()): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const pid = Number(new RegExp(`^${BASE_CONTEXT_PREFIX}(\\d+)-`).exec(entry)?.[1]);
    if (!pid || pid === process.pid || processAlive(pid)) continue;
    const ownerPid = directoryOwner(join(dir, entry));
    if (ownerPid && processAlive(ownerPid)) continue;
    rmSync(join(dir, entry), { recursive: true, force: true });
  }
}

/** The pid a detached session's kept CLI wrote into its directory; undefined when none. */
function directoryOwner(path: string): number | undefined {
  const file = join(path, OWNER_FILE);
  if (!existsSync(file)) return undefined;
  try {
    const pid = Number(readFileSync(file, 'utf8').trim());
    return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: it exists under another user.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

const CLAUDE_TASK_PHASES: Readonly<Record<string, SubagentLifecycle['phase']>> = {
  task_started: 'started',
  task_progress: 'progress',
  task_updated: 'updated',
  task_notification: 'ended',
};

function claudeSubagentLifecycle(
  msg: Record<string, unknown>,
  phase: SubagentLifecycle['phase'],
  taskId: string,
): SubagentLifecycle {
  const text = (value: unknown) => (typeof value === 'string' && value ? value : undefined);
  const record = (value: unknown) =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  const patch = record(msg.patch);
  const usage = record(msg.usage);
  const status = text(msg.status) ?? text(patch?.status);
  const count = (value: unknown) =>
    typeof value === 'number' && Number.isFinite(value) ? value : undefined;
  return {
    phase,
    taskId,
    ...(text(msg.tool_use_id) ? { toolUseId: text(msg.tool_use_id) } : {}),
    ...(text(msg.parent_task_id) ? { parentTaskId: text(msg.parent_task_id) } : {}),
    ...(text(msg.subagent_type) ? { agentType: text(msg.subagent_type) } : {}),
    ...(text(msg.description) ? { description: text(msg.description) } : {}),
    ...(typeof msg.spawn_depth === 'number' ? { depth: msg.spawn_depth } : {}),
    ...(typeof msg.is_backgrounded === 'boolean' ? { backgrounded: msg.is_backgrounded } : {}),
    ...(status ? { status } : {}),
    ...(text(msg.summary) ? { summary: text(msg.summary) } : {}),
    ...(text(msg.prompt) ? { prompt: text(msg.prompt) } : {}),
    ...(usage && count(usage.total_tokens) !== undefined
      ? {
          usage: {
            totalTokens: count(usage.total_tokens)!,
            ...(count(usage.tool_uses) !== undefined ? { toolUses: count(usage.tool_uses) } : {}),
            ...(count(usage.duration_ms) !== undefined
              ? { durationMs: count(usage.duration_ms) }
              : {}),
          },
        }
      : {}),
  };
}
