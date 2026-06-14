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
  SessionEvent,
  SessionEventHandler,
  SessionResult,
  SessionArtifact,
} from "./harness-session";

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
  /** Working directory for the session. */
  cwd?: string;
  /** Max agentic turns per message. Defaults to 25. */
  maxTurns?: number;
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

export class ClaudeCodeSession implements HarnessSession {
  // -- Config --
  private _bin: string;
  private _model: string;
  private _cwd: string;
  private _maxTurns: number;
  private _permissionMode: string;
  private _defaultTimeout: number;
  private _baseContext?: string;
  private _forking = false;
  private _spawn?: ClaudeCodeSessionConfig["spawn"];

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
  private _eventLog: SessionEvent[] = [];
  private _handlers: SessionEventHandler[] = [];
  private _beforeSendHooks: BeforeSendHook[] = [];
  private _turns = 0;
  private _totalTokens = { input: 0, output: 0 };
  private _startedAt: number;
  /**
   * Whether we've already seen a system/init event on the stream. If a second
   * one arrives it signals a mid-session restart — Claude Code's auto-compact
   * kills and resumes the session, which reproduces the init event. We use
   * this to emit `session_compact` so the FlowOrchestrator can invalidate
   * the Librarian's injection ledger.
   */
  private _sawInit = false;

  // -- Turn queue --
  private _queue: QueuedTurn[] = [];
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
    this._cwd = config?.cwd ?? process.cwd();
    this._maxTurns = config?.maxTurns ?? 25;
    this._permissionMode = config?.permissionMode ?? "bypassPermissions";
    this._defaultTimeout = config?.timeout ?? 600_000;
    this._baseContext = config?.baseContext;
    this._externalSessionId = config?.externalSessionId;
    this._spawn = config?.spawn;
    this._startedAt = Date.now();
  }

  // ---------------------------------------------------------------------------
  // Accessors
  // ---------------------------------------------------------------------------

  get alive(): boolean { return this._alive; }
  get externalSessionId(): string | undefined { return this._externalSessionId; }
  get events(): readonly SessionEvent[] { return this._eventLog; }
  get turns(): number { return this._turns; }
  get totalTokens(): Readonly<{ input: number; output: number }> {
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
    if (this._proc) throw new Error("Session already started");

    const args = this._buildSpawnArgs();

    // Strip API key env vars — CLI uses subscription auth
    const env: Record<string, string | undefined> = {
      ...process.env,
      DISABLE_AUTOUPDATER: "1",
    };
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_AUTH_TOKEN;

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

    // Background readers — run for session lifetime (don't await)
    this._readStdout();
    this._readStderr();

    // Monitor process exit for cleanup
    this._proc.exited.then((code) => {
      if (!this._alive) return;
      this._alive = false;
      const errMsg = this._stderr.trim()
        ? `Process exited (code ${code}): ${this._stderr.trim().slice(0, 500)}`
        : `Process exited with code ${code}`;
      this._rejectInflight(new Error(errMsg));
      this._rejectQueue(new Error("Session ended"));
      this._emit({ kind: "session_end", timestamp: Date.now() });
    });
  }

  // ---------------------------------------------------------------------------
  // send() — write message to stdin, resolve on result event
  // ---------------------------------------------------------------------------

  async send(
    message: string,
    opts?: { timeout?: number },
  ): Promise<SessionResult> {
    // Auto-restart after interrupt / process death (crash recovery via --resume).
    // _externalSessionId persists across process lifetimes, so start() will
    // include --resume <id> in spawn args.
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
      const turn: QueuedTurn = { message: transformed, timeout, resolve, reject };

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

  fork(opts?: { cwd?: string; baseContext?: string }): ClaudeCodeSession {
    if (!this._externalSessionId) {
      throw new Error(
        "Cannot fork — no external session ID yet (send at least one message first)",
      );
    }

    const forked = new ClaudeCodeSession({
      bin: this._bin,
      model: this._model,
      cwd: opts?.cwd ?? this._cwd,
      maxTurns: this._maxTurns,
      permissionMode: this._permissionMode,
      timeout: this._defaultTimeout,
      baseContext: opts?.baseContext ?? this._baseContext,
      externalSessionId: this._externalSessionId,
      spawn: this._spawn,
    });
    forked._forking = true;
    return forked;
  }

  // ---------------------------------------------------------------------------
  // interrupt() — cancel the in-flight turn (best-effort)
  // ---------------------------------------------------------------------------

  interrupt(): void {
    if (!this._inflight) return;

    this._rejectInflight(new Error("Turn interrupted"));

    // Process continues running. When it emits the orphaned result,
    // _processLine dispatches the next queued turn (if any).
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

    this._rejectInflight(new Error("Session killed"));
    this._rejectQueue(new Error("Session killed"));

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
    this._turnEvents = [];
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
    this._proc!.stdin.write(payload);
    this._proc!.stdin.flush();

    // Timeout guard
    if (turn.timeout > 0) {
      this._turnTimer = setTimeout(() => {
        this._turnTimer = null;
        this._rejectInflight(new Error(`Turn timed out after ${turn.timeout}ms`));
        // Don't dispatch next — process may still be working on this turn.
        // Next queued turn dispatches when the orphaned result arrives.
      }, turn.timeout);
    }
  }

  private _resolveTurn(): void {
    if (!this._inflight) return;

    if (this._turnTimer) {
      clearTimeout(this._turnTimer);
      this._turnTimer = null;
    }

    this._turns++;
    const result: SessionResult = {
      content: this._resultText,
      events: [...this._turnEvents],
      tokens: this._turnEvents.find((e) => e.tokens)?.tokens,
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

  private _rejectInflight(err: Error): void {
    if (!this._inflight) return;

    if (this._turnTimer) {
      clearTimeout(this._turnTimer);
      this._turnTimer = null;
    }

    this._inflight.reject(err);
    this._inflight = null;
  }

  private _rejectQueue(err: Error): void {
    for (const turn of this._queue) {
      turn.reject(err);
    }
    this._queue = [];
  }

  // ---------------------------------------------------------------------------
  // Private — stdout reader (background, runs for session lifetime)
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
        buffer = lines.pop()!; // Keep incomplete line in buffer

        for (const line of lines) {
          if (!line.trim()) continue;
          this._processLine(line);
        }
      }

      // Flush remaining buffer
      if (buffer.trim()) {
        this._processLine(buffer);
      }
    } catch (err) {
      this._rejectInflight(err as Error);
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

    // Capture the runtime's native session ID the first time we see it.
    // Subsequent messages echo the same ID; we keep our initial capture
    // (for resumed sessions, the config-supplied ID should match).
    if (typeof raw.session_id === "string" && !this._externalSessionId) {
      this._externalSessionId = raw.session_id;
    }

    // Compaction detection: a system/init message arriving after we've
    // already seen one means the Claude Code session was restarted mid-run.
    // Auto-compact works by killing and resuming the session, which fires
    // a new init event. This tells the FlowOrchestrator that the session's
    // in-memory state was summarized — the Librarian ledger is stale.
    if (raw.type === "system" && (raw.subtype === "init" || raw.subtype === "compact_boundary")) {
      if (this._sawInit && raw.subtype === "init") {
        this._emit({
          kind: "session_compact",
          timestamp: Date.now(),
          externalSessionId: this._externalSessionId,
          compactionSource: "claude-code",
          raw,
        });
      } else if (raw.subtype === "compact_boundary") {
        this._emit({
          kind: "session_compact",
          timestamp: Date.now(),
          externalSessionId: this._externalSessionId,
          compactionSource: "claude-code",
          raw,
        });
      }
      this._sawInit = true;
    }

    const classified = this._classify(raw);
    for (const event of classified) {
      this._emit(event);
      this._turnEvents.push(event);

      if (event.kind === "result") {
        this._resultText = event.text ?? "";
      }
      if (event.tokens) {
        this._totalTokens.input += event.tokens.input;
        this._totalTokens.output += event.tokens.output;
      }
    }

    // Result event resolves the pending turn (or dispatches next if orphaned)
    if (raw.type === "result") {
      if (this._inflight) {
        this._resolveTurn();
      } else {
        // Orphaned result from interrupted/timed-out turn — dispatch next
        this._processNextTurn();
      }
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
      "--max-turns", String(this._maxTurns),
      "--permission-mode", this._permissionMode,
      "--include-hook-events",
    ];

    // Resume for fork or crash recovery. _externalSessionId is set from
    // config (crash recovery / fork) or from the stream. Either way, if
    // it's present at spawn time, we --resume.
    if (this._externalSessionId) {
      args.push("--resume", this._externalSessionId);
      if (this._forking) {
        args.push("--fork-session");
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
      const usage = msg.usage as
        | Record<string, number>
        | undefined;
      events.push({
        kind: "result",
        timestamp: ts,
        text: (msg.result as string) ?? "",
        externalSessionId: msg.session_id as string | undefined,
        tokens: usage
          ? {
              input: usage.input_tokens ?? 0,
              output: usage.output_tokens ?? 0,
            }
          : undefined,
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

  private _emit(event: SessionEvent): void {
    this._eventLog.push(event);
    for (const handler of this._handlers) {
      try {
        handler(event);
      } catch (err) {
        console.warn(
          "[ClaudeCodeSession] handler error:",
          (err as Error).message,
        );
      }
    }
  }
}
