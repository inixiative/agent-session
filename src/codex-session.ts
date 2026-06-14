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
//   CodexAppServerSession  (experimental) — `codex app-server`  (WebSocket JSON-RPC)
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
   * first send() continues that thread via `codex-reply` — used for fork and
   * crash recovery. Also set by a SessionAdapter resuming a mapped Foundry thread.
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
  protected _eventLog: SessionEvent[] = [];
  protected _handlers: SessionEventHandler[] = [];
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

  get alive(): boolean { return this._alive; }
  get externalSessionId(): string | undefined { return this._externalSessionId; }
  get events(): readonly SessionEvent[] { return this._eventLog; }
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
    this._rejectInflight(new Error("Turn interrupted"));
  }

  kill(): void {
    if (!this._proc) return;
    this._alive = false;

    if (this._turnTimer) {
      clearTimeout(this._turnTimer);
      this._turnTimer = null;
    }

    this._rejectInflight(new Error("Session killed"));
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
    this._emit({ kind: "session_start", timestamp: Date.now() });

    this._readStdout();
    this._readStderr();

    this._proc.exited.then((code) => {
      if (!this._alive) return;
      this._alive = false;
      const errMsg = this._stderr.trim()
        ? `Process exited (code ${code}): ${this._stderr.trim().slice(0, 500)}`
        : `Process exited with code ${code}`;
      this._rejectInflight(new Error(errMsg));
      this._rejectQueue(new Error("Session ended"));
      for (const p of this._pending.values()) p.reject(new Error("Session ended"));
      this._pending.clear();
      this._emit({ kind: "session_end", timestamp: Date.now() });
    });

    await this._handshake();
  }

  // ---------------------------------------------------------------------------
  // send() — queue a turn, resolve on completion (identical control flow)
  // ---------------------------------------------------------------------------

  async send(
    message: string,
    opts?: { timeout?: number },
  ): Promise<SessionResult> {
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
      const turn: QueuedTurn = { message: transformed, timeout, resolve, reject };
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

  private _dispatchTurn(turn: QueuedTurn): void {
    this._inflight = turn;
    this._turnEvents = [];
    this._resultText = "";

    // Send via the subclass's wire protocol. The returned promise resolves when
    // the tools/call (or turn) completes; that resolves the turn.
    this._sendTurn(turn.message)
      .then((tokens) => {
        if (this._inflight !== turn) return; // interrupted / timed out
        if (tokens) {
          this._totalTokens.input += tokens.input;
          this._totalTokens.output += tokens.output;
        }
        this._resolveTurn(tokens);
      })
      .catch((err: Error) => {
        if (this._inflight !== turn) return;
        this._rejectInflight(err);
        this._processNextTurn();
      });

    if (turn.timeout > 0) {
      this._turnTimer = setTimeout(() => {
        this._turnTimer = null;
        this._rejectInflight(new Error(`Turn timed out after ${turn.timeout}ms`));
      }, turn.timeout);
    }
  }

  private _resolveTurn(tokens?: { input: number; output: number }): void {
    if (!this._inflight) return;

    if (this._turnTimer) {
      clearTimeout(this._turnTimer);
      this._turnTimer = null;
    }

    this._turns++;
    const result: SessionResult = {
      content: this._resultText,
      events: [...this._turnEvents],
      tokens: tokens ?? this._turnEvents.find((e) => e.tokens)?.tokens,
      externalSessionId: this._externalSessionId,
    };
    this._inflight.resolve(result);
    this._inflight = null;

    this._processNextTurn();
  }

  private _processNextTurn(): void {
    if (this._queue.length > 0 && this._alive) {
      const next = this._queue.shift()!;
      this._dispatchTurn(next);
    }
  }

  protected _rejectInflight(err: Error): void {
    if (!this._inflight) return;
    if (this._turnTimer) {
      clearTimeout(this._turnTimer);
      this._turnTimer = null;
    }
    this._inflight.reject(err);
    this._inflight = null;
  }

  protected _rejectQueue(err: Error): void {
    for (const turn of this._queue) turn.reject(err);
    this._queue = [];
  }

  // ---------------------------------------------------------------------------
  // Private — stdout/stderr readers (mirrors ClaudeCodeSession)
  // ---------------------------------------------------------------------------

  private async _readStdout(): Promise<void> {
    const reader = this._proc!.stdout.getReader();
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
          this._processLine(line);
        }
      }
      if (buffer.trim()) this._processLine(buffer);
    } catch (err) {
      this._rejectInflight(err as Error);
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
    const raw = msg as Record<string, unknown>;

    // JSON-RPC response to one of our requests (has matching `id` + result/error).
    if (typeof raw.id === "number" && (("result" in raw) || ("error" in raw))) {
      const pending = this._pending.get(raw.id);
      if (pending) {
        this._pending.delete(raw.id);
        if ("error" in raw && raw.error) {
          const e = raw.error as Record<string, unknown>;
          pending.reject(new Error((e.message as string) ?? JSON.stringify(e)));
        } else {
          pending.resolve(raw.result);
        }
        return;
      }
    }

    // Otherwise it's a notification (streamed event) — classify it.
    const classified = this._classify(raw);
    for (const event of classified) {
      this._emit(event);
      this._turnEvents.push(event);
      if (event.kind === "result" || event.kind === "text") {
        if (event.text) this._resultText = event.text;
      }
      if (event.tokens) {
        this._totalTokens.input += event.tokens.input;
        this._totalTokens.output += event.tokens.output;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Private — emit (identical to ClaudeCodeSession)
  // ---------------------------------------------------------------------------

  protected _emit(event: SessionEvent): void {
    this._eventLog.push(event);
    for (const handler of this._handlers) {
      try {
        handler(event);
      } catch (err) {
        console.warn(
          `[${this.constructor.name}] handler error:`,
          (err as Error).message,
        );
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Private — JSON-RPC request helper (resolves on the matching response)
  // ---------------------------------------------------------------------------

  protected _rpcRequest(method: string, params?: unknown): Promise<unknown> {
    const id = ++this._rpcId;
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

  /** Shared fork constructor — subclass passes its own ctor. */
  fork(opts?: { cwd?: string; baseContext?: string }): HarnessSession {
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
    if (threadId && !this._externalSessionId) {
      this._externalSessionId = threadId;
    }
    // Final text: prefer structuredContent.content, else the tool result content.
    const finalText =
      (structured?.content as string | undefined) ??
      this._extractToolText(result?.content);
    if (finalText) this._resultText = finalText;

    // Usage, when the call result reports it. Streamed token_count events are
    // already accounted by the base loop; the call result is the authoritative
    // turn total, returned to _dispatchTurn for the SessionResult. To avoid
    // double-counting against streamed events, we only return it if no streamed
    // token event was seen this turn.
    const sawStreamedTokens = this._turnEvents.some((e) => e.tokens);
    const usage = structured?.usage as Record<string, number> | undefined;
    if (usage && !sawStreamedTokens) {
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
    return classifyCodexEvent(ev, "type");
  }
}

// ---------------------------------------------------------------------------
// CodexAppServerSession (EXPERIMENTAL) — `codex app-server` over WebSocket
// ---------------------------------------------------------------------------
//
// EXPERIMENTAL: the app-server protocol is newer and less battle-tested than
// mcp-server. Prefer CodexMcpSession unless you specifically need app-server.
//
// `codex app-server --listen ws://127.0.0.1:<port>` — localhost needs no auth
// token. JSON-RPC 2.0 with slash-delimited methods:
//   initialize → initialized → thread/start (returns thread.id) → turn/start
// Consume turn/started, item/started, item/completed, turn/completed
// notifications (ThreadItem types agentMessage / reasoning / commandExecution;
// ThreadTokenUsage). Mapped to SessionEvents.
//
// We connect over the spawned process's stdin/stdout JSON-RPC for parity with
// the rest of the harness (the WebSocket listen address is for external
// clients; the stdio channel carries the same JSON-RPC frames). The base
// class's read/write loop is reused unchanged.

export class CodexAppServerSession extends BaseCodexSession {
  /** Resolves when the in-flight turn's `turn/completed` arrives. */
  private _turnDone?: {
    resolve: (t: { input: number; output: number } | undefined) => void;
    reject: (e: Error) => void;
  };

  protected _buildSpawnArgs(): string[] {
    // app-server on localhost needs no auth token. Approvals/sandbox are set
    // per-thread in thread/start (approvalPolicy / sandbox below).
    return ["app-server", "--listen", "ws://127.0.0.1:0"];
  }

  protected async _handshake(): Promise<void> {
    await this._rpcRequest("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "inixiative-bench", version: "0.1.0" },
    });
    this._rpcNotify("initialized");
  }

  protected async _sendTurn(
    message: string,
  ): Promise<{ input: number; output: number } | undefined> {
    // Start (or reuse) a thread. Disable codex's approvals + sandbox so OUR
    // container is the only jail.
    if (!this._externalSessionId) {
      const started = (await this._rpcRequest("thread/start", {
        model: this._model,
        cwd: this._cwd,
        approvalPolicy: "never",
        sandbox: "danger-full-access",
        ...(this._effort ? { modelReasoningEffort: this._effort } : {}),
      })) as Record<string, unknown> | undefined;
      const thread = started?.thread as Record<string, unknown> | undefined;
      const id = (thread?.id ?? started?.threadId) as string | undefined;
      if (id) this._externalSessionId = id;
    }

    const completed = new Promise<{ input: number; output: number } | undefined>(
      (resolve, reject) => {
        this._turnDone = { resolve, reject };
      },
    );

    // turn/start streams turn/started, item/*, turn/completed back as
    // notifications, consumed in _classify; turn/completed resolves the turn.
    await this._rpcRequest("turn/start", {
      threadId: this._externalSessionId,
      input: message,
    });

    return completed;
  }

  protected _classify(msg: Record<string, unknown>): SessionEvent[] {
    const method = msg.method as string | undefined;
    if (!method) return [];
    const params = (msg.params ?? {}) as Record<string, unknown>;

    if (method === "turn/completed") {
      const usage = (params.usage ?? params.tokenUsage) as
        | Record<string, number>
        | undefined;
      const tokens = usage
        ? {
            input: (usage.inputTokens ?? usage.input_tokens ?? 0) as number,
            output: (usage.outputTokens ?? usage.output_tokens ?? 0) as number,
          }
        : undefined;
      this._turnDone?.resolve(tokens);
      this._turnDone = undefined;
      // Note: no `tokens` on this event — _sendTurn returns them to _dispatchTurn,
      // which does the accounting once. Putting tokens here too would double-count.
      return [{ kind: "result", timestamp: Date.now(), text: this._resultText, raw: msg }];
    }

    if (method === "item/completed" || method === "item/started") {
      const item = (params.item ?? params) as Record<string, unknown>;
      return classifyCodexEvent(item, "type");
    }

    // turn/started and other lifecycle notifications carry no turn content.
    return [];
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
    events.push({
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
