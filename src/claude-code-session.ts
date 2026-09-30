import { TurnState } from "./turn-state";
import { retainEvidence } from "./retained-evidence";
import { TRANSPORTS } from "./transport";
import { claudeRateLimitSnapshot, claudeUsageSnapshot, mergeLimits, type LimitSnapshot } from "./limits";
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

import type {
  BeforeSendHook,
  HarnessSession,
  NativeInterruptOutcome,
  SessionEvent,
  SessionEventHandler,
  SessionResult,
  SessionArtifact,
  SessionSendOptions,
  SessionTokens,
} from "./harness-session";

import { parseClaudeUsage } from "./claude-usage";

// Re-export types so existing import paths keep working
export type {
  SessionEvent,
  SessionEventKind,
  SessionResult,
  SessionArtifact,
} from "./harness-session";

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
   * Injected via --append-system-prompt on process spawn. Persists for the
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
// Internal turn queue entry
// ---------------------------------------------------------------------------

interface QueuedTurn {
  onAdmission?: SessionSendOptions["onAdmission"];
  evidence: TurnState;
  message: string;
  timeout: number;
  resolve: (result: SessionResult) => void;
  reject: (error: Error) => void;
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

/** Concrete types for Bun.spawn with all pipes — also the shape tests mock. */
export interface PipedSubprocess {
  stdin: { write(data: string): void; flush(): void; end(): void };
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  exited: Promise<number>;
  kill(): void;
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
const KNOWN_NON_TEXT_RESULT_TYPES = new Set(["image", "audio", "document", "resource", "resource_link"]);

function publicToolResultContent(content: unknown): Pick<SessionEvent, "toolOutput" | "toolReferences" | "toolOutputOmitted" | "toolOutputOmittedTypes"> {
  if (typeof content === "string") return { toolOutput: content };
  if (content === undefined || content === null) return {};
  const omittedTypes: string[] = [];
  const omit = (type: unknown) => {
    const label = typeof type === "string" && KNOWN_NON_TEXT_RESULT_TYPES.has(type) ? type : "unsupported";
    if (!omittedTypes.includes(label)) omittedTypes.push(label);
  };
  if (!Array.isArray(content)) { omit(undefined); return { toolOutputOmitted: true, toolOutputOmittedTypes: Object.freeze(omittedTypes) }; }
  const texts: string[] = [], references: string[] = [];
  for (const block of content) {
    const b = block !== null && typeof block === "object" && !Array.isArray(block) ? block as Record<string, unknown> : undefined;
    if (b?.type === "text" && typeof b.text === "string") texts.push(b.text);
    else if (b?.type === "tool_reference" && typeof b.tool_name === "string" && b.tool_name.length > 0) references.push(b.tool_name);
    else omit(b?.type);
  }
  return {
    toolOutput: texts.join("\n"),
    ...(references.length ? { toolReferences: Object.freeze([...references]) } : {}),
    ...(omittedTypes.length ? { toolOutputOmitted: true, toolOutputOmittedTypes: Object.freeze(omittedTypes) } : {}),
  };
}

/** Claude CLI flags for a tool-free session (the same launch Foundry uses for text-only auxiliaries). */
export const CLAUDE_TEXT_ONLY_ARGS: readonly string[] = ["--safe-mode", "--tools", "", "--strict-mcp-config",
  "--mcp-config", '{"mcpServers":{}}', "--disable-slash-commands", "--no-chrome"];

export class ClaudeCodeSession implements HarnessSession {
  get transport() { return TRANSPORTS["claude-cli"]; }
  // -- Config --
  private _bin: string;
  private _model: string;
  private _effort?: string;
  private _cwd: string;
  readonly admissionProtocol = "prewrite-v1" as const;
  readonly turnBudgetProtocol = "optional-max-turns-v1" as const;
  inspectAttempt(admissionId: string) { return this._attempts.find(attempt => attempt.admissionId === admissionId)?.snapshot(); }
  private _maxTurns: number | null;
  private _permissionMode: string;
  private _defaultTimeout: number;
  private _baseContext?: string;
  private _forking = false;
  private _awaitingForkIdentity = false;
  private _spawn?: ClaudeCodeSessionConfig["spawn"];
  private _env?: ClaudeCodeSessionConfig["env"];
  private _textOnly: boolean;
  private _persistSession: boolean;
  private _limits?: LimitSnapshot;
  private _controlSeq = 0;
  private _control = new Map<string, { resolve(response: Record<string, unknown>): void; reject(error: Error): void }>();

  // -- Process --
  // Bun.spawn's return type is a union; we always use stdin:"pipe"/stdout:"pipe"/stderr:"pipe"
  // so we know the concrete types at runtime.
  private _proc: PipedSubprocess | null = null;
  private _stderr = "";

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

  // -- Turn queue --
  private _queue: QueuedTurn[] = [];
  private _attempts: TurnState[] = [];
  private _seenTerminals = new Set<string>();
  private _inflight: QueuedTurn | null = null;
  private _turnEvents: SessionEvent[] = [];
  private _resultText = "";
  private _turnTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(config?: ClaudeCodeSessionConfig) {
    const bin = config?.bin ?? "claude";
    if (!/^[a-zA-Z0-9_.\/\\-]+$/.test(bin)) {
      throw new Error(`Invalid claude CLI binary path: "${bin}"`);
    }
    this._bin = bin;
    this._model = config?.model ?? "sonnet";
    this._effort = config?.effort;
    this._cwd = config?.cwd ?? process.cwd();
    // Undefined retains standalone legacy behavior; null explicitly omits the CLI cap.
    if (config?.maxTurns !== undefined && config.maxTurns !== null && (!Number.isSafeInteger(config.maxTurns) || config.maxTurns < 1)) {
      throw new Error("maxTurns must be a positive safe integer or null (unbounded)");
    }
    this._maxTurns = config?.maxTurns === undefined ? 25 : config.maxTurns;
    this._permissionMode = config?.permissionMode ?? "bypassPermissions";
    this._defaultTimeout = config?.timeout ?? 600_000;
    this._baseContext = config?.baseContext;
    this._externalSessionId = config?.externalSessionId;
    this._spawn = config?.spawn;
    this._env = config?.env;
    this._textOnly = config?.textOnly ?? false;
    this._persistSession = config?.persistSession ?? true;
    this._startedAt = Date.now();
  }

  /** Latest account limits observed on this session (stream or poll). */
  get limits(): LimitSnapshot | undefined { return this._limits; }

  // ---------------------------------------------------------------------------
  // Accessors
  // ---------------------------------------------------------------------------

  get accounting() { return "observed-only" as const; }
  get attempts() { return this._attempts.map(a => a.snapshot()); }
  get diagnostics() { return Object.freeze({ observerFailures: Object.freeze({ ...this._observerFailures }) }); }

  get alive(): boolean { return this._alive; }
  get externalSessionId(): string | undefined { return this._externalSessionId; }
  get events(): readonly SessionEvent[] { return Object.freeze([...this._eventLog]); }
  get turns(): number { return this._turns; }
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

  onBeforeSend(hook: BeforeSendHook): () => void {
    this._beforeSendHooks.push(hook);
    return () => {
      const idx = this._beforeSendHooks.indexOf(hook);
      if (idx !== -1) this._beforeSendHooks.splice(idx, 1);
    };
  }

  /**
   * Mid-turn push. Claude Code's stream-json stdin accepts user messages
   * only; there is no dedicated out-of-band signal channel. So the current
   * behavior is to emit a "push_ignored" error event — callers observe it
   * but the model does not see the payload until the next turn.
   *
   * A future improvement: push via the MCP bridge (FLOW.md Loop 4) so the
   * signal reaches the in-flight turn as a tool result the model must read.
   */
  async push(payload: { kind: string; text: string }): Promise<void> {
    this._emit({
      kind: "error",
      timestamp: Date.now(),
      text: `push_ignored: kind=${payload.kind} — stream-json stdin has no OOB channel`,
      raw: payload,
    });
  }

  // ---------------------------------------------------------------------------
  // start() — spawn the persistent process
  // ---------------------------------------------------------------------------

  async start(): Promise<void> {
    if (this._attempts.some(a => a.dispatch === "attempted" && a.nativeOutcome === "unknown")) throw new Error("Native outcome unresolved; automatic resume is blocked");
    if (this._proc) throw new Error("Session already started");

    const args = this._buildSpawnArgs();

    // Strip API key env vars — CLI uses subscription auth
    const env: Record<string, string | undefined> = {
      ...process.env,
      ...this._env,
      DISABLE_AUTOUPDATER: "1",
    };
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_AUTH_TOKEN;
    for (const key of Object.keys(env)) if (env[key] === undefined) delete env[key];

    if (this._spawn) {
      this._proc = this._spawn([this._bin, ...args], { cwd: this._cwd, env });
    } else {
      this._proc = Bun.spawn([this._bin, ...args], {
        cwd: this._cwd,
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        env,
      }) as unknown as PipedSubprocess;
    }

    this._alive = true;
    this._endEmitted = false;
    this._emit({ kind: "session_start", timestamp: Date.now() });

    // Background readers — run for session lifetime (don't await)
    const proc = this._proc;
    const stdoutDone = this._readStdout(proc);
    this._readStderr();

    // Monitor process exit for cleanup
    proc.exited.then(async (code) => {
      if (this._proc !== proc || !this._alive) return;
      this._alive = false;
      await stdoutDone; // Drain buffered terminal evidence before interpreting process exit.
      const errMsg = this._stderr.trim()
        ? `Process exited (code ${code}): ${this._stderr.trim().slice(0, 500)}`
        : `Process exited with code ${code}`;
      this._rejectInflight(new Error(errMsg));
      this._rejectQueue(new Error("Session ended"));
      this._rejectControl(new Error("Session ended"));
      this._emit({ kind: "session_end", timestamp: Date.now(), transportOutcome: "failed" });
    });
  }

  private _rejectControl(error: Error): void {
    for (const pending of this._control.values()) pending.reject(error);
    this._control.clear();
  }

  // ---------------------------------------------------------------------------
  // send() — write message to stdin, resolve on result event
  // ---------------------------------------------------------------------------

  async send(
    message: string,
    opts?: SessionSendOptions,
  ): Promise<SessionResult> {
    // Auto-restart after interrupt / process death (crash recovery via --resume).
    // _externalSessionId persists across process lifetimes, so start() will
    // include --resume <id> in spawn args.
    if (this._attempts.some(a => a.dispatch === "attempted" && a.nativeOutcome === "unknown" && (!this._alive || a.localOutcome !== "pending"))) {
      const blocked = new TurnState(); this._attempts.push(blocked);
      throw blocked.fail(new Error("Native outcome unresolved; send not dispatched"), "blocked");
    }
    if (!this._proc && this._externalSessionId) {
      await this.start();
    }

    if (!this._proc) throw new Error("Session not started — call start() first");
    if (!this._alive) throw new Error("Session ended");

    const timeout = opts?.timeout ?? this._defaultTimeout;

    // Compose pre-send hooks in registration order. Each sees the previous
    // hook's output. Errors in a hook reject the send() — callers should
    // unregister problematic hooks or catch.
    let transformed = message;
    for (const hook of this._beforeSendHooks) {
      transformed = await hook(transformed);
    }

    return new Promise<SessionResult>((resolve, reject) => {
      const evidence = new TurnState(); this._attempts.push(evidence);
      const turn: QueuedTurn = { evidence, message: transformed, timeout, resolve, reject, onAdmission: opts?.onAdmission };
      if (!this._alive || (this._inflight && this._inflight.evidence.localOutcome !== "pending")) {
        reject(evidence.fail(new Error("Previous native work unresolved; send not dispatched"), "blocked")); return;
      }

      if (!this._inflight) {
        this._dispatchTurn(turn);
      } else {
        this._queue.push(turn);
      }
    });
  }

  // ---------------------------------------------------------------------------
  // fork() — branch from current conversation state
  // ---------------------------------------------------------------------------

  fork(opts?: { cwd?: string; baseContext?: string; persistSession?: boolean; spawn?: ClaudeCodeSessionConfig["spawn"] }): ClaudeCodeSession {
    if (this._inflight) throw new Error("Cannot fork while native ownership is unresolved");
    if (!this._externalSessionId) {
      throw new Error(
        "Cannot fork — no external session ID yet (send at least one message first)",
      );
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
    });
    forked._forking = true;
    return forked;
  }

  /** Construct a sibling session (fork). Subclasses keep their own transport. */
  protected _construct(config: ClaudeCodeSessionConfig): ClaudeCodeSession { return new ClaudeCodeSession(config); }

  // ---------------------------------------------------------------------------
  // interrupt() — reject the local waiter; native cancellation is unacknowledged
  // ---------------------------------------------------------------------------

  interrupt(): void {
    if (!this._inflight) return;

    this._rejectInflight(new Error("Local waiter interrupted; native cancellation unacknowledged"), "interrupt-request");

    // Native ownership is retained. Waiting sends are rejected without dispatch.
  }

  /**
   * Native interrupt through the CLI control protocol. Resolves "acknowledged"
   * once the CLI confirms and the turn's own terminal arrives (the send()
   * settles through that terminal, normally as a failed/interrupted outcome).
   */
  async interruptNative(opts?: { timeoutMs?: number }): Promise<NativeInterruptOutcome> {
    const turn = this._inflight;
    if (!turn || turn.evidence.dispatch !== "attempted" || turn.evidence.nativeOutcome !== "unknown") return "no-turn";
    const deadline = Date.now() + (opts?.timeoutMs ?? 5_000);
    try {
      await this._controlRequest({ subtype: "interrupt" }, Math.max(1, deadline - Date.now()));
    } catch { return "unacknowledged"; }
    while (turn.evidence.nativeOutcome === "unknown" && this._alive && Date.now() < deadline) await Bun.sleep(10);
    return turn.evidence.nativeOutcome === "unknown" ? "unacknowledged" : "acknowledged";
  }

  /** Account limits via the CLI control protocol (`get_usage`); no model turn. Requires a started session. */
  async readLimits(opts?: { timeoutMs?: number }): Promise<LimitSnapshot | undefined> {
    const response = await this._controlRequest({ subtype: "get_usage" }, opts?.timeoutMs ?? 10_000);
    const snapshot = claudeUsageSnapshot(response.response);
    if (snapshot) this._observeLimits(snapshot);
    return snapshot;
  }

  private _controlRequest(request: Record<string, unknown>, timeoutMs: number): Promise<Record<string, unknown>> {
    if (!this._proc || !this._alive) return Promise.reject(new Error("Session not running"));
    const requestId = `agent-session-${++this._controlSeq}-${crypto.randomUUID()}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this._control.delete(requestId); reject(new Error(`Control request ${String(request.subtype)} timed out`)); }, timeoutMs);
      this._control.set(requestId, {
        resolve: value => { clearTimeout(timer); resolve(value); },
        reject: error => { clearTimeout(timer); reject(error); },
      });
      try {
        this._proc!.stdin.write(JSON.stringify({ type: "control_request", request_id: requestId, request }) + "\n");
        this._proc!.stdin.flush();
      } catch (error) { this._control.delete(requestId); clearTimeout(timer); reject(error as Error); }
    });
  }

  private _observeLimits(snapshot: LimitSnapshot): void {
    this._limits = mergeLimits(this._limits, snapshot);
    this._emit({ kind: "rate_limit", timestamp: Date.now(), correlation: "unknown", unattributedReason: "account-status", limits: this._limits });
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

    this._rejectInflight(new Error("Session killed; native outcome may remain unknown"), "killed");
    this._rejectQueue(new Error("Session killed"));
    this._rejectControl(new Error("Session killed"));

    try { this._proc.stdin.end(); } catch { /* already closed */ }
    try { this._proc.kill(); } catch { /* already dead */ }
    this._proc = null;

    this._emit({ kind: "session_end", timestamp: Date.now() });
  }

  // ---------------------------------------------------------------------------
  // artifact() — full session record for Oracle
  // ---------------------------------------------------------------------------

  artifact(): SessionArtifact {
    return {
      externalSessionId: this._externalSessionId,
      attempts: this.attempts, accounting: "observed-only", diagnostics: this.diagnostics,
      events: [...this._eventLog],
      startedAt: this._startedAt,
      endedAt: this._alive ? undefined : Date.now(),
      turns: this._turns,
      totalTokens: { ...this._totalTokens },
      toolCalls: this._eventLog.filter((e) => e.kind === "tool_use").length,
      toolResults: this._eventLog.filter((e) => e.kind === "tool_result").length,
      errors: this._eventLog.filter((e) => e.kind === "error").length,
    };
  }

  // ---------------------------------------------------------------------------
  // Private — turn dispatch + queue
  // ---------------------------------------------------------------------------

  private _dispatchTurn(turn: QueuedTurn): void {
    this._inflight = turn;
    if (turn.onAdmission) {
      Promise.resolve().then(() => turn.onAdmission!(turn.evidence.snapshot())).then(() => {
        if (this._inflight === turn && this._alive && turn.evidence.localOutcome === "pending") this._writeTurn(turn);
        else if (this._inflight === turn && turn.evidence.dispatch === "not-dispatched") { this._inflight = null; this._processNextTurn(); }
      }).catch(error => {
        turn.reject(turn.evidence.fail(error instanceof Error ? error : new Error(String(error)), "registration"));
        if (this._inflight === turn) { this._inflight = null; this._processNextTurn(); }
      });
      return;
    }
    this._writeTurn(turn);
  }

  private _writeTurn(turn: QueuedTurn): void {
    turn.evidence.dispatch = "attempted";
    this._turnEvents = turn.evidence.events;
    this._resultText = "";

    // Wire format validated empirically against claude 2.1.114:
    // {type:"user", message:{role,content:[{type:"text",text}]}}
    // Alternative shapes ({type:"user_message"}, {role,content}) are silently dropped.
    const payload = JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content: [{ type: "text", text: turn.message }],
      },
    }) + "\n";
    try { this._proc!.stdin.write(payload); this._proc!.stdin.flush(); }
    catch (err) { this._rejectInflight(err as Error); return; }

    // Timeout guard
    if (turn.timeout > 0) {
      this._turnTimer = setTimeout(() => {
        this._turnTimer = null;
        this._rejectInflight(new Error(`Turn timed out after ${turn.timeout}ms`), "timeout");
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
    if (a.nativeOutcome === "unknown") return;
    this._turns++;
    if (a.localOutcome === "pending") {
      a.localOutcome = "resolved";
      this._inflight.resolve(a.result(this._externalSessionId));
    }
    this._inflight = null;

    this._processNextTurn();
  }

  private _processNextTurn(): void {
    if (!this._inflight && this._queue.length > 0 && this._alive) {
      const next = this._queue.shift()!;
      this._dispatchTurn(next);
    }
  }

  private _rejectInflight(err: Error, reason: import("./harness-session").SessionAttempt["localFailure"] = "transport"): void {
    if (!this._inflight) return;
    if (this._turnTimer) { clearTimeout(this._turnTimer); this._turnTimer = null; }
    const a = this._inflight.evidence;
    if ((reason === "transport" || reason === "killed") && a.transportOutcome === "open") a.transportOutcome = reason === "killed" ? "closed" : "failed";
    if (a.localOutcome === "pending") this._inflight.reject(a.fail(err, reason));
    this._rejectQueue(reason === "killed" ? err : new Error("Previous native work unresolved; queued send not dispatched"));
  }

  private _transportFailure(err: Error): void {
    this._alive = false;
    this._rejectInflight(err);
    this._rejectQueue(err);
    this._rejectControl(err);
    this._emit({ kind: "session_end", timestamp: Date.now(), transportOutcome: "failed" });
  }

  private _rejectQueue(err: Error): void {
    for (const turn of this._queue) {
      turn.reject(turn.evidence.fail(err, "blocked"));
    }
    this._queue = [];
  }

  // ---------------------------------------------------------------------------
  // Private — stdout reader (background, runs for session lifetime)
  // ---------------------------------------------------------------------------

  private async _readStdout(proc: PipedSubprocess): Promise<void> {
    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
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
      if (this._proc === proc && this._alive) this._transportFailure(new Error(this._stderr.trim() ? `Native stdout closed: ${this._stderr.trim().slice(0, 500)}` : "Native stdout closed"));
    } catch (err) {
      if (this._proc === proc) this._transportFailure(err as Error);
    }
  }

  // ---------------------------------------------------------------------------
  // Private — stderr reader (accumulates for error context)
  // ---------------------------------------------------------------------------

  private async _readStderr(): Promise<void> {
    const reader = this._proc!.stderr.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        this._stderr += decoder.decode(value, { stream: true });
      }
    } catch { /* ignore */ }
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
    if (raw.type === "control_response") {
      const response = raw.response as Record<string, unknown> | undefined;
      const id = typeof response?.request_id === "string" ? response.request_id : undefined;
      const pending = id ? this._control.get(id) : undefined;
      if (pending && id) {
        this._control.delete(id);
        if (response?.subtype === "success") pending.resolve(response);
        else pending.reject(new Error(typeof response?.error === "string" ? response.error : "Control request failed"));
      }
      return;
    }
    if (raw.type === "control_request") {
      // No client-side handlers (can_use_tool, hooks) are registered on this transport.
      const id = typeof raw.request_id === "string" ? raw.request_id : undefined;
      if (id && this._proc) {
        try {
          this._proc.stdin.write(JSON.stringify({ type: "control_response", response: { subtype: "error", request_id: id, error: "Unsupported by this client" } }) + "\n");
          this._proc.stdin.flush();
        } catch { /* transport failure surfaces on the stream */ }
      }
      this._unattributed(raw, "unrecognized-event"); return;
    }

    if (this._awaitingForkIdentity && raw.type === "system" && raw.subtype === "init" && typeof raw.session_id === "string") {
      this._externalSessionId = raw.session_id;
      this._awaitingForkIdentity = false;
    }
    // A foreign session or repeated result UUID cannot own the current admission.
    if (typeof raw.session_id === "string" && this._externalSessionId && raw.session_id !== this._externalSessionId) {
      this._unattributed(raw, "foreign-session"); return;
    }
    const terminalKey = raw.type === "result" && typeof raw.uuid === "string" ? raw.uuid : undefined;
    if (terminalKey && this._seenTerminals.has(terminalKey)) { this._unattributed(raw, "duplicate-terminal"); return; }
    // Capture the runtime's native session ID the first time we see it.
    // Subsequent messages echo the same ID; we keep our initial capture
    // (for resumed sessions, the config-supplied ID should match).
    if (typeof raw.session_id === "string" && !this._externalSessionId) {
      this._externalSessionId = raw.session_id;
    }

    // Lifecycle/configuration envelopes belong to the session, not to whichever
    // admission is in flight. Every init is preserved once with its binding; it is
    // never attributed to a turn and never compared against an earlier init to infer
    // compaction or restart. Only an explicit compact_boundary is a compaction, and
    // it is emitted exactly once per native uuid with this session's provenance.
    // Foreign bindings were already refused above and cannot invalidate this owner.
    if (raw.type === "system" && raw.subtype === "init") {
      this._unattributed(raw, "session-configuration"); return;
    }
    if (raw.type === "system" && raw.subtype === "compact_boundary") {
      const boundaryKey = typeof raw.uuid === "string" ? raw.uuid : undefined;
      if (boundaryKey && this._seenBoundaries.has(boundaryKey)) { this._unattributed(raw, "duplicate-boundary"); return; }
      if (boundaryKey) this._seenBoundaries.add(boundaryKey);
      this._emit({
        kind: "session_compact",
        timestamp: Date.now(),
        correlation: "unknown",
        nativeSessionId: typeof raw.session_id === "string" ? raw.session_id : this._externalSessionId,
        externalSessionId: this._externalSessionId,
        compactionSource: "claude-code",
        raw,
      });
      return;
    }

    // Account limits are account-level evidence, never part of an admission's output.
    if (raw.type === "rate_limit_event") {
      const snapshot = claudeRateLimitSnapshot(raw.rate_limit_info);
      if (snapshot) this._observeLimits(snapshot);
      else this._unattributed(raw, "account-status");
      return;
    }

    const turn = this._inflight;
    if (!turn) {
      if (terminalKey) this._seenTerminals.add(terminalKey);
      this._unattributed(raw, "no-admission"); return;
    }
    const a = turn.evidence;
    a.identity = { ...a.identity, nativeSessionId: typeof raw.session_id === "string" ? raw.session_id : a.identity.nativeSessionId,
      correlation: "ordered-stream" };
    const terminal = raw.type === "result";
    if (terminal) {
      if (terminalKey) this._seenTerminals.add(terminalKey);
      const subtype = typeof raw.subtype === "string" ? raw.subtype : undefined;
      const reason = typeof raw.terminal_reason === "string" ? raw.terminal_reason : undefined;
      const status = typeof raw.api_error_status === "number" && Number.isFinite(raw.api_error_status) ? raw.api_error_status : undefined;
      // Match Foundry's provider precedence. An optimistic subtype cannot erase
      // an explicit native error; local transport/RPC errors do not enter here.
      const failed = raw.is_error === true || subtype?.startsWith("error_")
        || (status !== undefined && status >= 400) || reason === "api_error";
      a.nativeOutcome = failed ? "failed" : subtype === "success" ? "completed" : "unknown";
      a.terminal = { type: "result", eventId: terminalKey, subtype, reason, apiErrorStatus: status };
    }
    const message = raw.message as Record<string, unknown> | undefined;
    const classified = this._classify(raw);
    if (!classified.length) this._unattributed(raw, "unrecognized-event");
    for (const event of classified) {
      const e = a.record({ ...event, messageId: typeof message?.id === "string" ? message.id : undefined,
        ...(terminal ? { nativeOutcome: a.nativeOutcome, terminal: a.terminal } : {}) });
      this._resultText = a.content;
      // Native result usage is authoritative for the whole turn. Request
      // snapshots can repeat across content blocks and must not be added again.
      if (e.kind === "result" && e.tokens) {
        for (const key of ["input", "output", "cacheRead", "cacheWrite", "cacheWrite5m", "cacheWrite1h", "thinking"] as const) {
          const value = e.tokens[key];
          if (value !== undefined) this._totalTokens[key] = (this._totalTokens[key] ?? 0) + value;
        }
      }
      this._emit(e);
    }
    if (terminal) {
      if (a.nativeOutcome !== "unknown") this._resolveTurn();
      else this._rejectInflight(new Error("Native result has no recognized terminal status"), "unrecognized-terminal");
    }

  }

  // ---------------------------------------------------------------------------
  // Private — spawn args (called once at start())
  // ---------------------------------------------------------------------------

  private _buildSpawnArgs(): string[] {
    // --print + --input-format stream-json = multi-turn stream over stdin
    // --output-format stream-json requires --verbose
    const args: string[] = [
      "--print",
      "--verbose",
      "--input-format", "stream-json",
      "--output-format", "stream-json",
      "--model", this._model,
      ...(this._effort ? ["--effort", this._effort] : []),
      ...(this._maxTurns === null ? [] : ["--max-turns", String(this._maxTurns)]),
      "--permission-mode", this._permissionMode,
      "--include-hook-events",
    ];

    // Resume for fork or crash recovery. _externalSessionId is set from
    // config (crash recovery / fork) or from the stream. Either way, if
    // it's present at spawn time, we --resume.
    if (this._textOnly) args.push(...CLAUDE_TEXT_ONLY_ARGS);
    if (!this._persistSession) args.push("--no-session-persistence");

    if (this._externalSessionId) {
      args.push("--resume", this._externalSessionId);
      if (this._forking) {
        args.push("--fork-session");
        this._awaitingForkIdentity = true;
        this._forking = false;
      }
    }

    // Stable base context injected once at process startup
    if (this._baseContext) {
      args.push("--append-system-prompt", this._baseContext);
    }

    return args;
  }

  // ---------------------------------------------------------------------------
  // Private — event classification
  // ---------------------------------------------------------------------------

  private _classify(msg: Record<string, unknown>): SessionEvent[] {
    const events: SessionEvent[] = [];
    const ts = Date.now();

    const type = msg.type as string | undefined;

    if (type === "assistant") {
      const message = msg.message as Record<string, unknown> | undefined;
      const tokens = parseClaudeUsage(message?.usage);
      if (tokens) {
        // Preserve the envelope (message/request IDs, model and usage tags),
        // including when a process dies before the terminal result arrives.
        events.push({ kind: "usage", timestamp: ts, tokens, raw: msg });
      }
      const content = message?.content;
      if (!Array.isArray(content)) return events;

      for (const block of content) {
        const blockType = (block as Record<string, unknown>).type as string;

        if (blockType === "text") {
          const text = (block as Record<string, unknown>).text as
            | string
            | undefined;
          if (text) {
            events.push({ kind: "text", timestamp: ts, text, raw: block });
          }
        } else if (blockType === "tool_use") {
          events.push({
            kind: "tool_use",
            timestamp: ts,
            callId: typeof block.id === "string" ? block.id : undefined,
            itemId: typeof block.id === "string" ? block.id : undefined,
            toolName: (block as Record<string, unknown>).name as string,
            toolInput: (block as Record<string, unknown>).input as Record<
              string,
              unknown
            >,
            raw: block,
          });
        } else if (blockType === "thinking") {
          const b = block as Record<string, unknown>;
          events.push({
            kind: "thinking",
            timestamp: ts,
            text: (b.thinking ?? b.text ?? b.content) as string | undefined,
            raw: block,
          });
        }
      }
    } else if (type === "user") {
      const message = msg.message as Record<string, unknown> | undefined;
      if (Array.isArray(message?.content)) for (const block of message.content) {
        if (block?.type !== "tool_result") continue;
        events.push({ kind: "tool_result", timestamp: ts, callId: typeof block.tool_use_id === "string" ? block.tool_use_id : undefined,
          ...publicToolResultContent(block.content), toolError: block.is_error === true, raw: block });
      }
    } else if (type === "tool") {
      // Tool result — what the tool returned
      const content = msg.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          const b = block as Record<string, unknown>;
          events.push({
            kind: "tool_result",
            timestamp: ts,
            toolOutput:
              typeof b.text === "string"
                ? b.text
                : typeof b.content === "string"
                  ? b.content
                  : JSON.stringify(block),
            toolError: b.is_error === true,
            raw: block,
          });
        }
      } else if (content != null) {
        events.push({
          kind: "tool_result",
          timestamp: ts,
          toolOutput:
            typeof content === "string" ? content : JSON.stringify(content),
          raw: content,
        });
      }
    } else if (type === "result") {
      events.push({
        kind: "result",
        timestamp: ts,
        text: (msg.result as string) ?? "",
        externalSessionId: msg.session_id as string | undefined,
        tokens: parseClaudeUsage(msg.usage),
        raw: msg,
      });
    } else if (type === "error") {
      const error = msg.error as Record<string, unknown> | undefined;
      events.push({
        kind: "error",
        timestamp: ts,
        text:
          (error?.message as string) ??
          (msg.message as string) ??
          JSON.stringify(msg),
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

  private _unattributed(raw: Record<string, unknown>, reason: NonNullable<SessionEvent["unattributedReason"]>): void {
    const message = raw.message as Record<string, unknown> | undefined;
    // Preserve the original envelope once, without synthesizing admission/native ownership.
    this._emit({ kind: "native_status", timestamp: Date.now(), correlation: "unknown", unattributedReason: reason,
      nativeSessionId: typeof raw.session_id === "string" ? raw.session_id : undefined,
      messageId: typeof message?.id === "string" ? message.id : undefined, raw });
  }

  private _emit(event: SessionEvent): void {
    event = retainEvidence(event);
    if (event.kind === "session_end") {
      if (this._endEmitted) return;
      this._endEmitted = true;
    }
    this._eventLog.push(event);
    for (const handler of this._handlers) {
      try {
        const observation: unknown = handler(event);
        if (observation && typeof (observation as PromiseLike<unknown>).then === "function") {
          void Promise.resolve(observation).catch(() => { this._observerFailures.asynchronous++; });
        }
      } catch { this._observerFailures.synchronous++; }
    }
  }
}
