import { TurnState } from "./turn-state";
import { retainEvidence } from "./retained-evidence";
import { isDeepStrictEqual } from "node:util";
// ---------------------------------------------------------------------------
// CodexSession — long-lived OpenAI Codex CLI process with full event capture
// ---------------------------------------------------------------------------
//
// Two implementations of the SAME HarnessSession interface, mirroring
// ClaudeCodeSession. Both keep one persistent `codex` process alive and stream
// turns over a JSON-RPC channel on stdin/stdout, classifying every event into
// the shared SessionEvent taxonomy and resolving a turn on completion.
//
//   CodexMcpSession        (default)      — `codex mcp-server`  (stdio MCP JSON-RPC)
//   CodexAppServerSession  (experimental) — `codex app-server`  (stdio JSON-RPC)
//
// Both DISABLE codex's own approvals + sandbox (the union of
// `--dangerously-bypass-approvals-and-sandbox`) so OUR container is the only
// jail — identical intent to ClaudeCodeSession's `bypassPermissions`.
//
// Architecture (mirrors claude-code-session.ts):
//   start()  → spawn one process, start background stdout reader, MCP handshake
//   send()   → JSON-RPC tools/call (codex / codex-reply), resolve on completion
//   fork()   → new (unstarted) session resuming from the captured threadId
//   kill()   → close stdin, kill process
//
// codex's native "session ID" is the threadId returned by the `codex` tool's
// structuredContent — captured into externalSessionId and used for multi-turn
// (`codex-reply`) and fork.
//
// Verified against codex 0.140.
// ---------------------------------------------------------------------------

import type {
  BeforeSendHook,
  HarnessSession,
  SessionEvent,
  SessionEventHandler,
  SessionResult,
  SessionArtifact,
} from "./harness-session";

// Re-export types so importers can stay on one path (mirrors claude-code-session).
export type {
  SessionEvent,
  SessionEventKind,
  SessionResult,
  SessionArtifact,
} from "./harness-session";

// ---------------------------------------------------------------------------
// Shared subprocess shape (mirrors ClaudeCodeSession.PipedSubprocess)
// ---------------------------------------------------------------------------

/** Concrete type for Bun.spawn with all pipes — also the shape tests mock. */
export interface PipedSubprocess {
  stdin: { write(data: string): void; flush(): void; end(): void };
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  exited: Promise<number>;
  kill(): void;
}

export type CodexSpawn = (
  cmd: string[],
  opts: { cwd: string; env: Record<string, string | undefined> },
) => PipedSubprocess;

// ---------------------------------------------------------------------------
// Configuration (mirrors ClaudeCodeSessionConfig)
// ---------------------------------------------------------------------------

export interface CodexSessionConfig {
  /** Explicit app-server integration. Never applied by the default MCP engine.
   * Config is native launch data, not event/recording data. */
  appServer?: {
    /** Persist the actual returned binding before model admission; failure blocks work. */
    onThreadReady?: (binding: string) => void | Promise<void>;
    requireConfiguration?: boolean;
    config?: Readonly<Record<string, unknown>>;
    requiredMcpServer?: { readonly name: string; readonly tools: readonly string[] };
  };
  /** Path to codex CLI binary. Defaults to "codex". */
  bin?: string;
  /** Model. Defaults to "gpt-5.5". */
  model?: string;
  /**
   * Reasoning-effort level (`model_reasoning_effort`). One of
   * minimal|low|medium|high|xhigh. Omitted → codex's default. Recorded per run.
   */
  effort?: string;
  /** Working directory for the session. */
  cwd?: string;
  /** Default per-send timeout in ms. Defaults to 600000 (10 min). */
  timeout?: number;
  /**
   * Base context to pre-load. Codex has no `--append-system-prompt`; we prepend
   * it to the first turn's prompt (and keep it for fork). Persists logically for
   * the session via the continued thread.
   */
  baseContext?: string;
  /**
   * codex's native thread ID (the value the `codex` tool returns). When set, the
   * first send() uses `codex-reply` on MCP (loaded threads only), or
   * `thread/resume` on app-server. Only app-server supports cold resume by ID.
   */
  externalSessionId?: string;
  /**
   * Override for the process spawner. Defaults to Bun.spawn. Tests inject a fake
   * subprocess that emulates the codex JSON-RPC protocol; the docker-spawn helper
   * wraps the CLI in `docker run`.
   */
  spawn?: CodexSpawn;
}

// ---------------------------------------------------------------------------
// Internal turn queue entry (identical shape to ClaudeCodeSession)
// ---------------------------------------------------------------------------

interface QueuedTurn {
  onAdmission?: import("./harness-session").SessionSendOptions["onAdmission"];
  evidence: TurnState;
  message: string;
  timeout: number;
  resolve: (result: SessionResult) => void;
  reject: (error: Error) => void;
}

// codex reasoning-effort levels (model_reasoning_effort), low→high.
const VALID_EFFORTS = ["minimal", "low", "medium", "high", "xhigh"];

// ---------------------------------------------------------------------------
// Base class — shared queue, event log, classification helpers, lifecycle
// ---------------------------------------------------------------------------
//
// CodexMcpSession and CodexAppServerSession differ only in the wire protocol
// (how start() handshakes, how a turn is sent, and how a raw message maps to
// SessionEvents). Everything else — the turn queue, token accounting, the
// stdout read loop, event emission, fork, artifact — is shared here, exactly as
// ClaudeCodeSession structures it.

abstract class BaseCodexSession implements HarnessSession {
  // -- Config --
  protected _bin: string;
  protected _model: string;
  protected _effort?: string;
  protected _cwd: string;
  protected _defaultTimeout: number;
  protected _baseContext?: string;
  protected _spawn?: CodexSpawn;

  // -- Process --
  protected _proc: PipedSubprocess | null = null;
  protected _stderr = "";

  // -- Session state --
  protected _externalSessionId?: string;
  protected _alive = false;
  private _endEmitted = false;
  protected _eventLog: SessionEvent[] = [];
  protected _handlers: SessionEventHandler[] = [];
  private _observerFailures = { synchronous: 0, asynchronous: 0 };
  protected _beforeSendHooks: BeforeSendHook[] = [];
  protected _turns = 0;
  protected _totalTokens = { input: 0, output: 0 };
  protected _startedAt: number;
  /** Whether baseContext has been prepended onto a sent turn yet. */
  protected _injectedBaseContext = false;
  /** Whether this session was created via fork() (continues a thread). */
  protected _forking = false;

  // -- JSON-RPC --
  /** Monotonic JSON-RPC request id. */
  protected _rpcId = 0;
  /** Pending JSON-RPC responses, keyed by request id. */
  protected _pending = new Map<
    number,
    { resolve: (result: unknown) => void; reject: (e: Error) => void }
  >();

  // -- Turn queue (identical to ClaudeCodeSession) --
  protected _queue: QueuedTurn[] = [];
  protected _attempts: TurnState[] = [];
  protected _seenTerminals = new Set<string>();
  protected _inflight: QueuedTurn | null = null;
  protected _turnEvents: SessionEvent[] = [];
  protected _resultText = "";
  protected _turnTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(config?: CodexSessionConfig) {
    const bin = config?.bin ?? "codex";
    if (!/^[a-zA-Z0-9_.\/\\-]+$/.test(bin)) {
      throw new Error(`Invalid codex CLI binary path: "${bin}"`);
    }
    if (config?.effort && !VALID_EFFORTS.includes(config.effort)) {
      throw new Error(
        `Invalid codex effort "${config.effort}". Valid: ${VALID_EFFORTS.join(", ")}`,
      );
    }
    this._bin = bin;
    this._model = config?.model ?? "gpt-5.5";
    this._effort = config?.effort;
    this._cwd = config?.cwd ?? process.cwd();
    this._defaultTimeout = config?.timeout ?? 600_000;
    this._baseContext = config?.baseContext;
    this._externalSessionId = config?.externalSessionId;
    this._spawn = config?.spawn;
    this._startedAt = Date.now();
  }

  // ---------------------------------------------------------------------------
  // Accessors (identical to ClaudeCodeSession)
  // ---------------------------------------------------------------------------

  get accounting() { return "observed-only" as const; }
  get attempts() { return this._attempts.map(a => a.snapshot()); }
  get diagnostics() { return Object.freeze({ observerFailures: Object.freeze({ ...this._observerFailures }) }); }

  get alive(): boolean { return this._alive; }
  get externalSessionId(): string | undefined { return this._externalSessionId; }
  get events(): readonly SessionEvent[] { return Object.freeze([...this._eventLog]); }
  get turns(): number { return this._turns; }
  get totalTokens(): Readonly<{ input: number; output: number }> {
    return { ...this._totalTokens };
  }

  // ---------------------------------------------------------------------------
  // Event subscription (identical to ClaudeCodeSession)
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
   * Mid-turn push. Like Claude Code's stream-json stdin, codex's tools/call has
   * no out-of-band signal channel mid-turn; we emit a "push_ignored" error event
   * so callers observe the attempt without the model seeing the payload until the
   * next turn.
   */
  async push(payload: { kind: string; text: string }): Promise<void> {
    this._emit({
      kind: "error",
      timestamp: Date.now(),
      text: `push_ignored: kind=${payload.kind} — codex turn has no OOB channel`,
      raw: payload,
    });
  }

  // ---------------------------------------------------------------------------
  // interrupt / kill / artifact (identical to ClaudeCodeSession)
  // ---------------------------------------------------------------------------

  interrupt(): void {
    if (!this._inflight) return;
    this._rejectInflight(new Error("Local waiter interrupted; native cancellation unacknowledged"), "interrupt-request");
  }

  kill(): void {
    if (!this._proc) return;
    this._alive = false;

    if (this._turnTimer) {
      clearTimeout(this._turnTimer);
      this._turnTimer = null;
    }

    this._rejectInflight(new Error("Session killed; native outcome may remain unknown"), "killed");
    this._rejectQueue(new Error("Session killed"));
    for (const p of this._pending.values()) p.reject(new Error("Session killed"));
    this._pending.clear();

    try { this._proc.stdin.end(); } catch { /* already closed */ }
    try { this._proc.kill(); } catch { /* already dead */ }
    this._proc = null;

    this._emit({ kind: "session_end", timestamp: Date.now() });
  }

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
  // start() — spawn the persistent process + handshake (subclass-specific)
  // ---------------------------------------------------------------------------

  async start(): Promise<void> {
    if (this._attempts.some(a => a.dispatch === "attempted" && a.nativeOutcome === "unknown")) throw new Error("Native outcome unresolved; automatic resume is blocked");
    if (this._proc) throw new Error("Session already started");

    const args = this._buildSpawnArgs();
    const env: Record<string, string | undefined> = {
      ...process.env,
      DISABLE_AUTOUPDATER: "1",
    };

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

    const proc = this._proc;
    const stdoutDone = this._readStdout(proc);
    this._readStderr();

    proc.exited.then(async (code) => {
      if (this._proc !== proc || !this._alive) return;
      this._alive = false;
      await stdoutDone; // Drain buffered terminal evidence before interpreting process exit.
      const errMsg = this._stderr.trim()
        ? `Process exited (code ${code}): ${this._stderr.trim().slice(0, 500)}`
        : `Process exited with code ${code}`;
      this._rejectInflight(new Error(errMsg));
      this._rejectQueue(new Error("Session ended"));
      for (const p of this._pending.values()) p.reject(new Error("Session ended"));
      this._pending.clear();
      this._emit({ kind: "session_end", timestamp: Date.now(), transportOutcome: "failed" });
    });

    await this._handshake();
  }

  // ---------------------------------------------------------------------------
  // send() — queue a turn, resolve on completion (identical control flow)
  // ---------------------------------------------------------------------------

  async send(
    message: string,
    opts?: import("./harness-session").SessionSendOptions,
  ): Promise<SessionResult> {
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

    let transformed = message;
    for (const hook of this._beforeSendHooks) {
      transformed = await hook(transformed);
    }

    // Prepend baseContext onto the first turn (codex has no system-prompt flag).
    if (this._baseContext && !this._injectedBaseContext) {
      transformed = `${this._baseContext}\n\n${transformed}`;
      this._injectedBaseContext = true;
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
  // Private — turn dispatch + queue (mirrors ClaudeCodeSession)
  // ---------------------------------------------------------------------------

  readonly admissionProtocol = "prewrite-v1" as const;
  inspectAttempt(admissionId: string) { return this._attempts.find(attempt => attempt.admissionId === admissionId)?.snapshot(); }

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

    // Send via the subclass's wire protocol. The returned promise resolves when
    // the tools/call (or turn) completes; that resolves the turn.
    this._sendTurn(turn.message)
      .then((tokens) => {
        if (this._inflight !== turn) return;
        turn.evidence.rpcSettled = true;
        if (tokens) {
          this._totalTokens.input += tokens.input;
          this._totalTokens.output += tokens.output;
        }
        this._resolveTurn(tokens);
      })
      .catch((err: Error) => {
        if (this._inflight !== turn) return;
        turn.evidence.rpcSettled = true;
        if (turn.evidence.rpcOutcome === "pending") turn.evidence.rpcOutcome = "unknown";
        this._rejectInflight(err, err instanceof NativeValidationError ? "validation" : "rpc");
        this._releaseKnownTurn();
      });

    if (turn.timeout > 0) {
      this._turnTimer = setTimeout(() => {
        this._turnTimer = null;
        this._rejectInflight(new Error(`Turn timed out after ${turn.timeout}ms`), "timeout");
      }, turn.timeout);
    }
  }

  private _resolveTurn(tokens?: { input: number; output: number }): void {
    if (!this._inflight) return;

    if (this._turnTimer) {
      clearTimeout(this._turnTimer);
      this._turnTimer = null;
    }

    const a = this._inflight.evidence;
    a.content = this._resultText;
    a.tokens = tokens ?? a.tokens;
    if (a.localOutcome === "pending") {
      a.localOutcome = "resolved";
      this._inflight.resolve(a.result(this._externalSessionId));
    }
    if (a.nativeOutcome === "unknown") this._rejectQueue(new Error("Native terminal missing; queued send not dispatched"));
    this._releaseKnownTurn();
  }

  private _releaseKnownTurn(): void {
    const a = this._inflight?.evidence;
    if (!a || !this._canReleaseAttempt(a) || a.nativeOutcome === "unknown") return;
    this._turns++;
    this._inflight = null;
    this._processNextTurn();
  }

  protected _canReleaseAttempt(attempt: TurnState): boolean { return attempt.rpcSettled; }

  private _processNextTurn(): void {
    if (!this._inflight && this._queue.length > 0 && this._alive) {
      const next = this._queue.shift()!;
      this._dispatchTurn(next);
    }
  }

  protected _rejectInflight(err: Error, reason: import("./harness-session").SessionAttempt["localFailure"] = "transport"): void {
    if (!this._inflight) return;
    if (this._turnTimer) { clearTimeout(this._turnTimer); this._turnTimer = null; }
    const a = this._inflight.evidence;
    if ((reason === "transport" || reason === "killed") && a.transportOutcome === "open") a.transportOutcome = reason === "killed" ? "closed" : "failed";
    if (a.localOutcome === "pending") this._inflight.reject(a.fail(err, reason));
    this._rejectQueue(new Error("Previous native work unresolved; queued send not dispatched"));
  }

  private _transportFailure(err: Error): void {
    this._alive = false;
    this._rejectInflight(err);
    this._rejectQueue(err);
    this._emit({ kind: "session_end", timestamp: Date.now(), transportOutcome: "failed" });
    for (const p of this._pending.values()) p.reject(err);
    this._pending.clear();
  }

  protected _rejectQueue(err: Error): void {
    for (const turn of this._queue) turn.reject(turn.evidence.fail(err, "blocked"));
    this._queue = [];
  }

  // ---------------------------------------------------------------------------
  // Private — stdout/stderr readers (mirrors ClaudeCodeSession)
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
        buffer = lines.pop()!;
        for (const line of lines) {
          if (!line.trim()) continue;
          if (this._proc === proc || !this._proc) this._processLine(line);
        }
      }
      if (buffer.trim() && (this._proc === proc || !this._proc)) this._processLine(buffer);
      if (this._proc === proc && this._alive) this._transportFailure(new Error(this._stderr.trim() ? `Native stdout closed: ${this._stderr.trim().slice(0, 500)}` : "Native stdout closed"));
    } catch (err) {
      if (this._proc === proc) this._transportFailure(err as Error);
    }
  }

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
  // Private — JSON-RPC line processor (shared envelope; payload is per-protocol)
  // ---------------------------------------------------------------------------

  private _processLine(line: string): void {
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    const raw = object(msg);
    if (!raw) return;
    if (typeof raw.method === "string" && (typeof raw.id === "string" || typeof raw.id === "number") && this._serverRequest(raw)) return;

    // JSON-RPC response to one of our requests (has matching `id` + result/error).
    if (typeof raw.id === "number" && (("result" in raw) || ("error" in raw))) {
      const pending = this._pending.get(raw.id);
      if (pending) {
        this._pending.delete(raw.id);
        const a = this._inflight?.evidence;
        if (a?.identity.rpcRequestId === raw.id) a.rpcOutcome = raw.error ? "failed" : "resolved";
        if ("error" in raw && raw.error) {
          const e = raw.error as Record<string, unknown>;
          pending.reject(new Error((e.message as string) ?? JSON.stringify(e)));
        } else {
          // Apply protocol identity synchronously before later lines in this
          // same stdout chunk. Awaiting the promise first can lose a terminal.
          try { this._observeRpcResult(raw.id, raw.result); pending.resolve(raw.result); }
          catch (error) { pending.reject(error instanceof Error ? error : new Error(String(error))); }
        }
        return;
      }
    }

    const classified = this._classify(raw);
    for (const event of classified) {
      const a = this._inflight?.evidence;
      if (!a || event.unattributedReason) { this._emit(event); continue; }
      const e = a.record(event);
      this._resultText = a.content;
      if (e.nativeOutcome && e.terminal) { a.nativeOutcome = e.nativeOutcome; a.terminal = e.terminal; }
      if (e.tokens) { this._totalTokens.input += e.tokens.input; this._totalTokens.output += e.tokens.output; }
      this._emit(e);
    }
    this._releaseKnownTurn();

  }

  // ---------------------------------------------------------------------------
  // Private — emit (identical to ClaudeCodeSession)
  // ---------------------------------------------------------------------------

  protected _emit(event: SessionEvent): void {
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

  // ---------------------------------------------------------------------------
  // Private — JSON-RPC request helper (resolves on the matching response)
  // ---------------------------------------------------------------------------

  protected _rpcRequest(method: string, params?: unknown): Promise<unknown> {
    const id = ++this._rpcId;
    if ((method === "tools/call" || method === "turn/start") && this._inflight) {
      this._inflight.evidence.identity = { ...this._inflight.evidence.identity, rpcRequestId: id };
      this._inflight.evidence.rpcOutcome = "pending";
    }
    const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
    return new Promise<unknown>((resolve, reject) => {
      this._pending.set(id, { resolve, reject });
      try {
        this._proc!.stdin.write(payload);
        this._proc!.stdin.flush();
      } catch (err) {
        this._pending.delete(id);
        reject(err as Error);
      }
    });
  }

  protected _serverRequest(_request: Record<string, unknown>): boolean { return false; }

  protected _rpcNotify(method: string, params?: unknown): void {
    const payload = JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n";
    this._proc!.stdin.write(payload);
    this._proc!.stdin.flush();
  }

  // ---------------------------------------------------------------------------
  // Subclass hooks — the only protocol-specific surface
  // ---------------------------------------------------------------------------

  /** CLI args for the persistent process. */
  protected abstract _buildSpawnArgs(): string[];
  /** Protocol handshake after spawn (initialize / initialized / etc.). */
  protected abstract _handshake(): Promise<void>;
  /** Send one turn; resolve with token usage when the turn completes. */
  protected abstract _sendTurn(
    message: string,
  ): Promise<{ input: number; output: number } | undefined>;
  /** Map a streamed notification to SessionEvents. */
  protected abstract _classify(msg: Record<string, unknown>): SessionEvent[];

  protected _observeRpcResult(_id: number, _result: unknown): void {}

  /** Shared fork constructor — subclass passes its own ctor. */
  fork(opts?: { cwd?: string; baseContext?: string }): HarnessSession {
    if (this._inflight) throw new Error("Cannot fork while native ownership is unresolved");
    if (!this._externalSessionId) {
      throw new Error(
        "Cannot fork — no thread ID yet (send at least one message first)",
      );
    }
    const Ctor = this.constructor as new (c?: CodexSessionConfig) => BaseCodexSession;
    const forked = new Ctor({
      bin: this._bin,
      model: this._model,
      effort: this._effort,
      cwd: opts?.cwd ?? this._cwd,
      timeout: this._defaultTimeout,
      baseContext: opts?.baseContext ?? this._baseContext,
      externalSessionId: this._externalSessionId,
      spawn: this._spawn,
    });
    forked._forking = true;
    return forked;
  }
}

// ---------------------------------------------------------------------------
// CodexMcpSession (DEFAULT) — `codex mcp-server` over stdio MCP JSON-RPC
// ---------------------------------------------------------------------------
//
// Handshake: initialize → notifications/initialized → tools/list.
// A turn is an MCP `tools/call`:
//   - first turn        → tool "codex"        (params: prompt, model, cwd, ...)
//   - subsequent turns  → tool "codex-reply"  (params: prompt, threadId)
// During the call, codex streams `codex/event` notifications (agent message,
// reasoning, command execution, token usage) — mapped to SessionEvents. The
// threadId comes back in the call result's structuredContent (captured for
// multi-turn + fork).

export class CodexMcpSession extends BaseCodexSession {
  private _mcpAdmission?: string;
  private _mcpCalls = new Map<string, { invocation: Record<string, unknown>; ended: boolean }>();
  protected _buildSpawnArgs(): string[] {
    // Disable codex's own approvals + sandbox (the union of
    // --dangerously-bypass-approvals-and-sandbox) so OUR container is the jail.
    // model_reasoning_effort sets the effort level; passed as TOML-ish `-c` values.
    const args = [
      "mcp-server",
      "-c", `sandbox_mode="danger-full-access"`,
      "-c", `approval_policy="never"`,
    ];
    if (this._effort) {
      args.push("-c", `model_reasoning_effort="${this._effort}"`);
    }
    return args;
  }

  protected async _handshake(): Promise<void> {
    await this._rpcRequest("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "inixiative-bench", version: "0.1.0" },
    });
    this._rpcNotify("notifications/initialized");
    // tools/list confirms the `codex` + `codex-reply` tools are present.
    await this._rpcRequest("tools/list", {});
  }

  protected async _sendTurn(
    message: string,
  ): Promise<{ input: number; output: number } | undefined> {
    const isReply = this._externalSessionId !== undefined;
    const name = isReply ? "codex-reply" : "codex";
    const args: Record<string, unknown> = isReply
      ? { prompt: message, threadId: this._externalSessionId }
      : {
          prompt: message,
          model: this._model,
          cwd: this._cwd,
          // Belt-and-suspenders: also disable per-call (matches spawn `-c` flags).
          sandbox: "danger-full-access",
          "approval-policy": "never",
          ...(this._effort
            ? { config: { model_reasoning_effort: this._effort } }
            : {}),
        };

    const result = (await this._rpcRequest("tools/call", {
      name,
      arguments: args,
    })) as Record<string, unknown> | undefined;

    // Capture the threadId for multi-turn (codex-reply) + fork.
    const structured = result?.structuredContent as
      | Record<string, unknown>
      | undefined;
    const threadId = structured?.threadId as string | undefined;
    if (threadId && this._externalSessionId && threadId !== this._externalSessionId) throw new Error("MCP response changed the native resume binding");
    if (threadId && !this._externalSessionId) {
      this._externalSessionId = threadId;
    }
    if (threadId && this._inflight) this._inflight.evidence.identity = { ...this._inflight.evidence.identity, threadId };
    // Final text: prefer structuredContent.content, else the tool result content.
    const finalText =
      (structured?.content as string | undefined) ??
      this._extractToolText(result?.content);
    if (result?.isError === true) throw new Error(finalText ?? "MCP tools/call failed");
    if (finalText) { this._resultText = finalText; if (this._inflight) this._inflight.evidence.content = finalText; }

    // Usage, when the call result reports it. Streamed token_count events are
    // already accounted by the base loop; the call result is the authoritative
    // turn total, returned to _dispatchTurn for the SessionResult. To avoid
    // double-counting against streamed events, we only return it if no streamed
    // token event was seen this turn.
    const sawStreamedTokens = this._turnEvents.some((e) => e.tokens);
    const usage = structured?.usage as Record<string, number> | undefined;
    if (usage && !sawStreamedTokens && typeof (usage.input_tokens ?? usage.inputTokens) === "number" && typeof (usage.output_tokens ?? usage.outputTokens) === "number") {
      return {
        input: (usage.input_tokens ?? usage.inputTokens ?? 0) as number,
        output: (usage.output_tokens ?? usage.outputTokens ?? 0) as number,
      };
    }
    return undefined;
  }

  private _extractToolText(content: unknown): string | undefined {
    if (!Array.isArray(content)) return undefined;
    const parts: string[] = [];
    for (const block of content) {
      const b = block as Record<string, unknown>;
      if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
    }
    return parts.length ? parts.join("\n") : undefined;
  }

  protected _classify(msg: Record<string, unknown>): SessionEvent[] {
    // Streamed events arrive as JSON-RPC notifications: method "codex/event"
    // with params carrying a `msg` of a tagged type.
    if (msg.method !== "codex/event") return [];
    const params = msg.params as Record<string, unknown> | undefined;
    const ev = (params?.msg ?? params) as Record<string, unknown> | undefined;
    if (!ev) return [];
    const a = this._inflight?.evidence;
    const str = (v: unknown) => typeof v === "string" ? v : undefined;
    const nativeSessionId = str(ev.session_id), threadId = str(ev.thread_id);
    const turnId = str(ev.turn_id), envelopeId = str(params?.id);
    const item = ev.item as Record<string, unknown> | undefined;
    const unowned = (reason: NonNullable<SessionEvent["unattributedReason"]>): SessionEvent[] => [{
      kind: "native_status", timestamp: Date.now(), correlation: "unknown", unattributedReason: reason,
      nativeSessionId, threadId, turnId, callId: str(ev.call_id), itemId: str(item?.id) ?? str(ev.item_id),
      // Keep the envelope too: params.id may explain a rejected correlation.
      // Unowned MCP calls retain identity/type diagnostics, never unrelated tool payloads.
      raw: ev.type === "mcp_tool_call_begin" || ev.type === "mcp_tool_call_end" ? { type: ev.type } : msg,
    }];
    if (threadId && this._externalSessionId && threadId !== this._externalSessionId) return unowned("foreign-session");
    if (nativeSessionId && a?.identity.nativeSessionId && nativeSessionId !== a.identity.nativeSessionId) return unowned("foreign-session");
    if ((envelopeId && this._seenTerminals.has(envelopeId)) || (turnId && this._seenTerminals.has(turnId))) {
      return unowned(ev.type === "task_complete" ? "duplicate-terminal" : "after-terminal");
    }
    if (!a) {
      if (ev.type === "task_complete" && turnId) this._seenTerminals.add(turnId);
      return unowned("no-admission");
    }
    if (ev.type === "session_configured") {
      if (!this._externalSessionId && threadId) this._externalSessionId = threadId;
      a.identity = { ...a.identity, nativeSessionId, threadId };
    }
    if (ev.type !== "session_configured" && a.identity.turnId && envelopeId && envelopeId !== a.identity.turnId) return unowned("foreign-turn");
    if (threadId && a.identity.threadId && threadId !== a.identity.threadId) return unowned("foreign-session");
    if (ev.type === "task_started" && turnId && !a.identity.turnId) a.identity = { ...a.identity, turnId, correlation: "native-turn" };
    if (turnId && turnId !== a.identity.turnId) return unowned("foreign-turn");
    if (ev.type === "task_complete") {
      if (!turnId || turnId !== a.identity.turnId) return unowned("unrecognized-event");
      this._seenTerminals.add(turnId);
      return [{ ...a.identity, kind: "result", timestamp: Date.now(), nativeOutcome: "completed", terminal: { type: "task_complete", turnId }, raw: ev }];
    }
    const identity = { ...a.identity, threadId: threadId ?? a.identity.threadId, turnId: turnId ?? a.identity.turnId,
      callId: str(ev.call_id), itemId: str(item?.id) ?? str(ev.item_id) };
    if (ev.type === "mcp_tool_call_begin" || ev.type === "mcp_tool_call_end") {
      const invocation = object(ev.invocation);
      if (!identity.callId || !invocation || typeof invocation.server !== "string" || !invocation.server
        || typeof invocation.tool !== "string" || !invocation.tool) return unowned("malformed-tool");
      if (this._mcpAdmission !== a.identity.admissionId) {
        this._mcpAdmission = a.identity.admissionId; this._mcpCalls.clear();
      }
      // Compare the original argument value, including absence. Never join a result
      // for another server/tool or silently substitute arguments from its envelope.
      const join = { server: invocation.server, tool: invocation.tool, arguments: invocation.arguments };
      const prior = this._mcpCalls.get(identity.callId);
      const tool = { toolName: `mcp__${invocation.server}__${invocation.tool}`, toolServer: invocation.server, toolMethod: invocation.tool };
      if (ev.type === "mcp_tool_call_begin") {
        if (prior) return unowned("duplicate-tool");
        this._mcpCalls.set(identity.callId, { invocation: structuredClone(join), ended: false });
        const args = publicMcpArguments(invocation.arguments);
        return [{ ...identity, ...tool, kind: "tool_use", timestamp: Date.now(), ...args }];
      }
      if (!prior || !isDeepStrictEqual(prior.invocation, join)) return unowned("unmatched-tool");
      if (prior.ended) return unowned("duplicate-tool");
      const result = publicMcpResult(ev.result);
      if (!result) return unowned("malformed-tool");
      prior.ended = true;
      return [{ ...identity, ...tool, kind: "tool_result", timestamp: Date.now(), ...result }];
    }
    if (["session_configured", "task_started", "item_started", "item_completed"].includes(String(ev.type))) {
      return [{ ...identity, kind: "native_status", timestamp: Date.now(), nativeOutcome: a.nativeOutcome, raw: ev }];
    }
    // Notifications without a turn ID are associated only with the single owned RPC.
    const classified = classifyCodexEvent(ev, "type");
    return classified.length ? classified.map(event => ({ ...identity, ...event })) : unowned("unrecognized-event");
  }
}

// ---------------------------------------------------------------------------
// CodexAppServerSession (EXPERIMENTAL) — `codex app-server` over stdio
// ---------------------------------------------------------------------------
//
// Wire contract: installed codex-cli 0.153.4 v2 JSON schema. Controlled tests
// establish source behavior, not a real create/resume/native-completion capture.
// No default switch. Full history hydration, native fork and cancellation remain
// separate integration work; a local interrupt never acknowledges native stop.

class NativeValidationError extends Error {}

export class CodexAppServerSession extends BaseCodexSession {
  readonly appServerProtocol = "owned-thread-v1";
  private readonly _options: NonNullable<CodexSessionConfig["appServer"]>;
  private readonly _onThreadReady?: (binding: string) => void | Promise<void>;
  private _startedOnce = false;
  private _threadReady = false;
  private _nativeSessionId?: string;
  private _appAdmission?: string;
  private _turnDone?: () => void;
  private _items = new Map<string, { type: string; input?: unknown; completed: boolean; server?: string; tool?: string; text?: string }>();

  constructor(config?: CodexSessionConfig) {
    super(config);
    const {onThreadReady,...options}=config?.appServer??{};
    this._onThreadReady=onThreadReady;
    this._options = retainEvidence(options);
    const required = this._options.requiredMcpServer;
    if (required && (!/^[a-zA-Z0-9_-]+$/.test(required.name) || !required.tools.length || required.tools.some(t => !/^[a-zA-Z0-9_-]+$/.test(t))))
      throw new NativeValidationError("Invalid required MCP inventory");
  }

  override fork(): HarnessSession { throw Error("Native app-server fork is not implemented; a same-thread wrapper cannot create a native fork or inherit a process capability"); }

  override async start(): Promise<void> {
    if (this._inflight) throw Error("Native call ownership unresolved; automatic resume is blocked");
    if (this._startedOnce && !this._alive) throw Error("App-server restart requires a new owned instance and preflight");
    this._startedOnce = true;
    try { await super.start(); }
    catch(error) { this.kill(); throw error; }
  }

  protected override _serverRequest(request: Record<string, unknown>): boolean {
    // JSON-RPC's explicit method-not-supported refusal also covers unknown future
    // requests. Never approve native work or echo private request parameters.
    const payload = JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "Client interaction is unsupported by this adapter" } }) + "\n";
    const params=object(request.params),a=this._inflight?.evidence;
    const identity=a?.identity.turnId && params?.threadId===a.identity.threadId && params?.turnId===a.identity.turnId
      ? {...a.identity,admissionId:a.admissionId} : {unattributedReason:"unrecognized-event" as const};
    try { this._proc!.stdin.write(payload); this._proc!.stdin.flush(); }
    catch { this._emit({ ...identity, kind: "native_status", timestamp: Date.now(), raw: { type: "server-request-refusal", status: "write-failed" } }); return true; }
    this._emit({ ...identity, kind: "native_status", timestamp: Date.now(), raw: { type: "server-request-refusal", status: "refused" } });
    return true;
  }

  private _refuse(reason: string, status = "unknown"): never {
    const a = this._inflight?.evidence;
    this._emit({ ...(a ? { admissionId: a.admissionId, ...a.identity } : {}), kind: "native_status", timestamp: Date.now(),
      raw: { type: "thread-refused", reason, status } });
    throw new NativeValidationError(`Native thread validation refused: ${reason} (${status}); no turn was sent`);
  }

  private async _readiness(): Promise<void> {
    const required = this._options.requiredMcpServer;
    if (!required) return;
    let cursor: string | undefined;
    const seen = new Set<string>(); let found: Record<string, unknown> | undefined;
    // Pagination only, never polling/retrying a starting or failed native server.
    for (let page = 0; page < 32; page++) {
      const result = object(await this._rpcRequest("mcpServerStatus/list", { threadId: this._externalSessionId, detail: "toolsAndAuthOnly", limit: 100, ...(cursor ? { cursor } : {}) }));
      if (!Array.isArray(result?.data)) this._refuse("mcp-inventory-malformed");
      for (const entry of result.data) {
        const server = object(entry);
        if (server?.name === required.name) { if (found) this._refuse("mcp-inventory-duplicate"); found = server; }
      }
      if (result.nextCursor == null) {
        const tools = object(found?.tools);
        if (!found || found.runtimeStatus !== "connected" || !tools || required.tools.some(name => object(tools[name])?.name !== name))
          this._refuse("mcp-inventory-unavailable");
        const a = this._inflight!.evidence;
        this._emit({ ...a.identity, admissionId: a.admissionId, kind: "native_status", timestamp: Date.now(), raw: { type: "mcp-ready", status: "connected", server: required.name, tools: [...required.tools] } });
        return;
      }
      if (typeof result.nextCursor !== "string" || !result.nextCursor || seen.has(result.nextCursor)) this._refuse("mcp-inventory-cursor");
      cursor = result.nextCursor; seen.add(cursor);
    }
    this._refuse("mcp-inventory-page-limit");
  }

  protected override _canReleaseAttempt(a: TurnState): boolean {
    // An observer/write failure may occur after delivery. A terminal alone does
    // not settle the unanswered turn/start call or authorize another admission.
    return a.rpcSettled && (a.rpcOutcome === "resolved" || a.rpcOutcome === "failed");
  }

  protected _buildSpawnArgs(): string[] {
    return ["app-server", "--listen", "stdio://"];
  }

  protected async _handshake(): Promise<void> {
    this._threadReady = false;
    const initialized = object(await this._rpcRequest("initialize", {
      capabilities: {},
      clientInfo: { name: "inixiative-bench", version: "0.1.0" },
    }));
    if (this._options.requireConfiguration && ["userAgent","platformFamily","platformOs","codexHome"].some(key=>typeof initialized?.[key]!=="string" || !initialized[key]))
      throw new NativeValidationError("Native initialize response lacks required configuration; no thread or turn was sent");
    this._rpcNotify("initialized");
  }

  protected async _sendTurn(
    message: string,
  ): Promise<{ input: number; output: number } | undefined> {
    const a = this._inflight!.evidence;
    if (!this._threadReady) {
      const binding = this._externalSessionId;
      const method = binding ? "thread/resume" : "thread/start";
      const response = object(await this._rpcRequest(method, {
        ...(binding ? { threadId: binding } : {}),
        model: this._model,
        cwd: this._cwd,
        approvalPolicy: "never",
        sandbox: "danger-full-access",
        ...(this._options.config ? { config: this._options.config } : {}),
      }));
      const thread = object(response?.thread), id = thread?.id;
      if (typeof id !== "string" || !id || (binding && id !== binding)) this._refuse("binding-mismatch");
      // Resume may rejoin a live thread. Never steer known pre-existing work.
      // The installed schema requires status. Missing/unknown state cannot
      // authorize work, even if this response otherwise identifies our thread.
      if (object(thread?.status)?.type !== "idle"
        || (Array.isArray(thread?.turns) && thread.turns.some(turn => object(turn)?.status === "inProgress")))
        this._refuse("not-idle", ["active", "notLoaded", "systemError"].includes(String(object(thread?.status)?.type)) ? String(object(thread?.status)?.type) : "unknown");
      if (this._options.requireConfiguration && (typeof response?.model !== "string" || !response.model || typeof response.modelProvider !== "string" || !response.modelProvider
        || response.cwd !== this._cwd || response.approvalPolicy !== "never" || response.approvalsReviewer !== "user" || object(response.sandbox)?.type !== "dangerFullAccess"
        || !Array.isArray(thread?.turns) || thread.turns.some(value=>!this._turn(value)))) this._refuse("configuration-missing-or-incompatible");
      this._externalSessionId = id;
      this._nativeSessionId = typeof thread?.sessionId === "string" && thread.sessionId ? thread.sessionId : undefined;
      a.identity = { ...a.identity, threadId: id, ...(this._nativeSessionId ? {nativeSessionId:this._nativeSessionId} : {}) };
      if (this._onThreadReady) {
        try { await this._onThreadReady(id); }
        catch (cause) { throw new NativeValidationError("Native binding persistence failed before turn/start", {cause}); }
      }
      this._threadReady = true;
      // Configuration belongs to this process/thread, never to the next turn.
      // Do not copy historical turns, instructions, paths or arbitrary config.
      this._emit({ kind: "native_status", timestamp: Date.now(), threadId: id,
        nativeSessionId: this._nativeSessionId, unattributedReason: "session-configuration", raw: { type: "thread-configured", method, threadId: id,
          ...(object(thread?.status)?.type === "idle" ? { status: "idle" } : {}),
          ...(typeof response?.model === "string" ? { model: response.model } : {}),
          ...(response?.reasoningEffort === null || VALID_EFFORTS.includes(String(response?.reasoningEffort)) ? { reasoningEffort: response?.reasoningEffort } : {}),
          history: { source: method, turns: Array.isArray(thread?.turns) ? thread.turns.slice(0,200).flatMap(value => {const t=this._turn(value);return t?[{id:t.id,status:t.status}]:[];}) : [],
            available: Array.isArray(thread?.turns), hasMore: !!response?.turnsBackwardsCursor || (Array.isArray(thread?.turns) && thread.turns.length>200) } } });
    }
    a.identity = { ...a.identity, threadId: this._externalSessionId, ...(this._nativeSessionId ? { nativeSessionId: this._nativeSessionId } : {}) };
    await this._readiness();
    // Timeout/kill during create/resume must not cause a later model write.
    if (this._inflight?.evidence !== a || a.localOutcome !== "pending" || !this._alive) throw Error("Local admission closed before turn/start; no turn was sent");
    a.identity = { ...a.identity, threadId: this._externalSessionId, ...(this._nativeSessionId ? { nativeSessionId: this._nativeSessionId } : {}) };
    this._appAdmission = a.admissionId; this._items.clear();
    const completed = new Promise<void>(resolve => { this._turnDone = resolve; });
    await this._rpcRequest("turn/start", {
      threadId: this._externalSessionId,
      input: [{ type: "text", text: message }],
      ...(this._effort ? { effort: this._effort } : {}),
    });
    await completed; // Native terminal and RPC acknowledgment are both required.
    return a.tokens;
  }

  protected override _observeRpcResult(id: number, result: unknown): void {
    const a = this._inflight?.evidence;
    if (!a || this._appAdmission !== a.admissionId || a.identity.rpcRequestId !== id) return;
    const turn = this._turn(object(result)?.turn);
    if (!turn || (a.identity.turnId && turn.id !== a.identity.turnId)
      || (!a.identity.turnId && this._seenTerminals.has(turn.id))) throw new NativeValidationError("Native turn/start response missing or conflicts with owned turn");
    a.identity = { ...a.identity, turnId: turn.id, correlation: "native-turn" };
  }

  private _turn(value: unknown): { id: string; status: string; error?: unknown } | undefined {
    const turn = object(value);
    if (!turn || typeof turn.id !== "string" || !turn.id || !Array.isArray(turn.items)
      || !["inProgress", "completed", "failed", "interrupted"].includes(String(turn.status))) return;
    return turn as { id: string; status: string; error?: unknown };
  }

  protected _classify(msg: Record<string, unknown>): SessionEvent[] {
    const method = typeof msg.method === "string" ? msg.method : undefined;
    if (!method) return [];
    const params = object(msg.params), turn = this._turn(params?.turn), item = object(params?.item);
    const str = (value: unknown) => typeof value === "string" && value ? value : undefined;
    const threadId = str(params?.threadId), turnId = turn?.id ?? str(params?.turnId), itemId = str(item?.id) ?? str(params?.itemId);
    const unowned = (reason: NonNullable<SessionEvent["unattributedReason"]>): SessionEvent[] => [{
      kind: "native_status", timestamp: Date.now(), threadId, turnId, itemId, correlation: "unknown", unattributedReason: reason,
      raw: { method: ["turn/started", "turn/completed", "item/started", "item/completed", "thread/tokenUsage/updated", "item/agentMessage/delta", "item/commandExecution/outputDelta"].includes(method) ? method : "unrecognized",
        ...(item ? { itemType: ["agentMessage", "commandExecution", "reasoning", "mcpToolCall"].includes(String(item.type)) ? item.type : "unsupported" } : {}) },
    }];
    const a = this._inflight?.evidence;
    if (!threadId || threadId !== this._externalSessionId) return unowned("foreign-session");
    if (!a || this._appAdmission !== a.admissionId) return unowned("no-admission");
    if (turnId && this._seenTerminals.has(turnId)) return unowned(method === "turn/completed" ? "duplicate-terminal" : "after-terminal");
    if (method === "turn/started" && turn?.status === "inProgress" && !a.identity.turnId)
      a.identity = { ...a.identity, threadId, turnId: turn.id, correlation: "native-turn" };
    if (!turnId || turnId !== a.identity.turnId) return unowned("foreign-turn");
    const identity = { ...a.identity, threadId, turnId, ...(itemId ? { itemId } : {}) };
    const status = (): SessionEvent[] => [{ ...identity, kind: "native_status", timestamp: Date.now(), raw: { method } }];
    if (method === "turn/completed") {
      if (!turn || turn.status === "inProgress") return unowned("unrecognized-event");
      const error = object(turn.error);
      if (turn.error != null && typeof error?.message !== "string") return unowned("unrecognized-event");
      this._seenTerminals.add(turnId);
      this._turnDone?.();
      this._turnDone = undefined;
      return [{ ...identity, kind: "result", timestamp: Date.now(), text: a.content,
        nativeOutcome: turn.status === "completed" && !error ? "completed" : "failed",
        terminal: { type: method, turnId, subtype: turn.status, ...(error ? { reason: error.message as string } : {}) } }];
    }
    if (method === "thread/tokenUsage/updated") {
      const last = object(object(params?.tokenUsage)?.last);
      if (typeof last?.inputTokens !== "number" || typeof last?.outputTokens !== "number"
        || !Number.isSafeInteger(last.inputTokens) || !Number.isSafeInteger(last.outputTokens) || last.inputTokens < 0 || last.outputTokens < 0) return unowned("unrecognized-event");
      // `last` is a snapshot, not an additive delta. Total accounting happens once
      // when the original native turn and RPC settle; absent usage stays absent.
      a.tokens = { input: last.inputTokens, output: last.outputTokens };
      return status();
    }
    if (method === "item/agentMessage/delta" || method === "item/commandExecution/outputDelta") {
      if (!itemId || typeof params?.delta !== "string") return unowned("unrecognized-event");
      const prior = this._items.get(itemId);
      if (prior?.completed) return unowned("after-terminal");
      if (method === "item/agentMessage/delta") {
        if (prior && prior.type !== "agentMessage") return unowned("unmatched-tool");
        this._items.set(itemId, { type: "agentMessage", completed: false, text: (prior?.text ?? "") + params.delta });
        return [{ ...identity, kind: "text_delta", timestamp: Date.now(), text: params.delta }];
      }
      if (prior?.type !== "commandExecution") return unowned("unmatched-tool");
      return [{ ...identity, kind: "native_status", timestamp: Date.now(), toolName: "shell", text: params.delta }];
    }
    if (method === "item/completed" || method === "item/started") {
      if (!itemId || !item || typeof item.type !== "string") return unowned("unrecognized-event");
      if (item.type === "agentMessage") {
        if (method !== "item/completed") return status();
        if (this._items.get(itemId)?.completed) return unowned("after-terminal");
        if (typeof item.text !== "string" || (item.phase != null && !["commentary", "final_answer"].includes(String(item.phase)))) return unowned("unrecognized-event");
        this._items.set(itemId, { type: item.type, completed: true });
        return [{ ...identity, kind: "text", timestamp: Date.now(), text: item.text }];
      }
      if (item.type === "commandExecution") {
        if (typeof item.command !== "string") return unowned("malformed-tool");
        const prior = this._items.get(itemId);
        if (method === "item/started") {
          if (prior) return unowned("duplicate-tool");
          this._items.set(itemId, { type: item.type, input: item.command, completed: false });
          return [{ ...identity, kind: "tool_use", timestamp: Date.now(), toolName: "shell", toolInput: { command: item.command } }];
        }
        if (!prior || prior.type !== item.type || prior.input !== item.command) return unowned("unmatched-tool");
        if (prior.completed) return unowned("duplicate-tool");
        if (!["completed", "failed", "declined"].includes(String(item.status))) return unowned("malformed-tool");
        prior.completed = true;
        return [{ ...identity, kind: "tool_result", timestamp: Date.now(), toolName: "shell",
          ...(typeof item.aggregatedOutput === "string" ? { toolOutput: item.aggregatedOutput } : { toolOutputOmitted: true }),
          toolError: item.status !== "completed" || (typeof item.exitCode === "number" && item.exitCode !== 0) }];
      }
      if (item.type === "mcpToolCall") {
        if (typeof item.server !== "string" || !item.server || typeof item.tool !== "string" || !item.tool) return unowned("malformed-tool");
        const prior = this._items.get(itemId);
        const tool = { toolServer: item.server, toolMethod: item.tool, toolName: `mcp__${item.server}__${item.tool}` };
        if (method === "item/started") {
          if (prior) return unowned("duplicate-tool");
          if (item.status !== "inProgress") return unowned("malformed-tool");
          this._items.set(itemId, { type: item.type, server: item.server, tool: item.tool, input: retainEvidence(item.arguments), completed: false });
          return [{ ...identity, ...tool, kind: "tool_use", timestamp: Date.now(), ...publicMcpArguments(item.arguments) }];
        }
        if (!prior || prior.type !== item.type || prior.server !== item.server || prior.tool !== item.tool || !isDeepStrictEqual(prior.input, item.arguments)) return unowned("unmatched-tool");
        if (prior.completed) return unowned("duplicate-tool");
        if (!["completed", "failed"].includes(String(item.status))) return unowned("malformed-tool");
        const error = object(item.error), result = object(item.result);
        const output = result ? publicMcpResult({ Ok: { content: result.content } }) : undefined;
        if (item.error != null && typeof error?.message !== "string") return unowned("malformed-tool");
        prior.completed = true;
        return [{ ...identity, ...tool, kind: "tool_result", timestamp: Date.now(),
          ...(output ?? (error ? { toolOutput: error.message as string } : { toolOutputOmitted: true })),
          toolError: item.status === "failed" || !!error,
          ...(result && Object.keys(result).some(k => k !== "content" && result[k] != null) ? { toolOutputOmitted: true } : {}) }];
      }
      // Reasoning and unsupported items retain safe identity/type diagnostics only.
      return unowned("unrecognized-event");
    }
    return method === "turn/started" ? status() : unowned("unrecognized-event");
  }
}

// ---------------------------------------------------------------------------
// Shared event mapping — codex item/event → SessionEvent
// ---------------------------------------------------------------------------
//
// Both protocols carry the same ThreadItem / event shapes (agent message,
// reasoning, command execution, token usage). `tag` is the discriminant field
// ("type" for both mcp `codex/event.msg.type` and app-server `item.type`).
//
//   agent_message / agentMessage     → text
//   reasoning / agent_reasoning      → thinking
//   command_execution / commandExecution → tool_use (+ tool_result when done)
//   token_count / usage              → tokens (attached to a result event)

const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

function publicMcpArguments(value: unknown): Pick<SessionEvent, "toolInput" | "toolInputOmitted"> {
  if (!object(value)) return { toolInputOmitted: "Native arguments absent or not an object" };
  let omitted = false;
  const clean = (v: unknown, depth = 0): unknown => {
    if (depth > 32) { omitted = true; return null; }
    if (v === null || ["string", "number", "boolean"].includes(typeof v)) return v;
    if (Array.isArray(v)) return v.map(x => clean(x, depth + 1));
    if (!object(v)) { omitted = true; return null; }
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).flatMap(([key, item]) => {
      if (/^(?:__proto__|constructor|prototype|env|environment|authorization|credentials?|api[-_]?key|access[-_]?token|refresh[-_]?token|password|secret|reasoning|thinking)$/i.test(key)) { omitted = true; return []; }
      return [[key, clean(item, depth + 1)]];
    }));
  };
  const toolInput = clean(value) as Record<string, unknown>;
  return { toolInput, ...(omitted ? { toolInputOmitted: "Non-public or unsupported argument fields omitted" } : {}) };
}

/** Rust Result<CallToolResult,String> from protocol.rs. This is legacy event
 * normalization, not the app-server ThreadItem schema. Keep all public text
 * blocks (including the bridge's JSON receipt), not arbitrary envelope fields. */
function publicMcpResult(value: unknown): Pick<SessionEvent, "toolOutput" | "toolError" | "toolOutputOmitted"> | undefined {
  const result = object(value);
  if (!result || Object.keys(result).length !== 1) return;
  if (typeof result.Err === "string") return { toolOutput: result.Err, toolError: true };
  const ok = object(result.Ok);
  if (!ok || !Array.isArray(ok.content) || (ok.isError !== undefined && typeof ok.isError !== "boolean")) return;
  let omitted = Object.keys(ok).some(k => k !== "content" && k !== "isError");
  const content = ok.content.map(value => {
    const block = object(value);
    if (block?.type === "text" && typeof block.text === "string") {
      if (Object.keys(block).some(k => k !== "type" && k !== "text")) omitted = true;
      return { type: "text", text: block.text };
    }
    omitted = true;
    // Unknown shape values are not safe labels. Known non-text types retain type only.
    return { type: ["image", "audio", "resource", "resource_link"].includes(String(block?.type)) ? block!.type : "unsupported" };
  });
  return { toolOutput: JSON.stringify({ content, ...(ok.isError !== undefined ? { isError: ok.isError } : {}) }),
    ...(ok.isError !== undefined ? { toolError: ok.isError as boolean } : {}), ...(omitted ? { toolOutputOmitted: true } : {}) };
}

function classifyCodexEvent(
  ev: Record<string, unknown>,
  tag: string,
): SessionEvent[] {
  const ts = Date.now();
  const type = String(ev[tag] ?? "").toLowerCase();
  const events: SessionEvent[] = [];

  // Agent message → text.
  if (type === "agent_message" || type === "agentmessage" || type === "agent_message_delta") {
    const text = (ev.message ?? ev.text ?? ev.delta) as string | undefined;
    if (text) events.push({ kind: "text", timestamp: ts, text, raw: ev });
    return events;
  }

  // Reasoning → thinking.
  if (
    type === "reasoning" ||
    type === "agent_reasoning" ||
    type === "agentreasoning" ||
    type === "agent_reasoning_delta"
  ) {
    const text = (ev.text ?? ev.reasoning ?? ev.delta ?? ev.summary) as string | undefined;
    if (text) events.push({ kind: "thinking", timestamp: ts, text, raw: ev });
    return events;
  }

  // Command execution → tool_use, plus tool_result if output is present.
  if (
    type === "command_execution" ||
    type === "commandexecution" ||
    type === "exec_command_begin" ||
    type === "exec_command_end"
  ) {
    const command = (ev.command ?? ev.cmd) as string | string[] | undefined;
    const cmdStr = Array.isArray(command) ? command.join(" ") : command;
    if (type !== "exec_command_end") events.push({
      kind: "tool_use",
      timestamp: ts,
      toolName: "shell",
      toolInput: cmdStr ? { command: cmdStr } : (ev as Record<string, unknown>),
      raw: ev,
    });
    const output = (ev.output ?? ev.stdout ?? ev.aggregated_output) as
      | string
      | undefined;
    const exitCode = (ev.exit_code ?? ev.exitCode) as number | undefined;
    if (output !== undefined || exitCode !== undefined) {
      events.push({
        kind: "tool_result",
        timestamp: ts,
        toolOutput: output ?? "",
        toolError: exitCode !== undefined && exitCode !== 0,
        raw: ev,
      });
    }
    return events;
  }

  // Token usage → carried on a result-less event so accounting picks it up.
  if (
    type === "token_count" ||
    type === "token_usage" ||
    type === "usage" ||
    type === "tokenusage"
  ) {
    const u = (ev.info ?? ev.usage ?? ev) as Record<string, unknown>;
    const input =
      (u.input_tokens ?? u.inputTokens ?? u.total_input_tokens ?? 0) as number;
    const output =
      (u.output_tokens ?? u.outputTokens ?? u.total_output_tokens ?? 0) as number;
    if (input || output) {
      events.push({
        kind: "result",
        timestamp: ts,
        tokens: { input, output },
        raw: ev,
      });
    }
    return events;
  }

  // Errors.
  if (type === "error" || type === "stream_error") {
    events.push({
      kind: "error",
      timestamp: ts,
      text: (ev.message ?? ev.error ?? JSON.stringify(ev)) as string,
      raw: ev,
    });
    return events;
  }

  // Unclassified events are preserved via `raw` on nothing — but we keep them
  // out of turn content. Oracle can still introspect via the live stream.
  return events;
}

// ---------------------------------------------------------------------------
// Default export selection
// ---------------------------------------------------------------------------

/**
 * The default CodexSession is the MCP variant (stdio mcp-server). Import
 * CodexAppServerSession explicitly for the experimental app-server variant.
 */
export const CodexSession = CodexMcpSession;
