import { isDeepStrictEqual } from 'node:util';
import { codexLimitSnapshot, type LimitSnapshot, mergeLimits } from './limits';
import { retainEvidence } from './retained-evidence';
import { ToolGates } from './tool-gate';
import { TRANSPORTS } from './transport';
import { TurnState } from './turn-state';
// ---------------------------------------------------------------------------
// CodexAppServerSession — one persistent `codex app-server --listen stdio://`
// process per session, driven over JSON-RPC (thread/start, thread/resume,
// turn/start). Every notification is classified into the shared SessionEvent
// taxonomy; a turn resolves once its native terminal and RPC have both settled.
// Approvals and sandbox default to never / danger-full-access (the container
// is the jail); appServer.approvalPolicy routes approvals to onToolRequest().
// The native thread ID is the externalSessionId used for cold resume.
//
// Wire contract: codex-cli 0.155.1 v2 JSON schema.
// ---------------------------------------------------------------------------

import type {
  BeforeSendHook,
  HarnessSession,
  NativeInterruptOutcome,
  SessionArtifact,
  SessionEvent,
  SessionEventHandler,
  SessionResult,
  ToolGate,
} from './harness-session';

// Re-export types so importers can stay on one path (mirrors claude-code-session).
export type {
  SessionArtifact,
  SessionEvent,
  SessionEventKind,
  SessionResult,
} from './harness-session';

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

export type CodexApprovalPolicy = 'never' | 'on-request' | 'untrusted';
export type CodexSandbox = 'read-only' | 'workspace-write' | 'danger-full-access';
export type HostPermissionMode = 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions';

/**
 * The app-server approval policy and sandbox for a host permission mode (Claude's mode ids).
 * `acceptEdits` maps like `default`: under workspace-write, edits inside the workspace are never
 * asked about; only escalations (writes outside it, commands needing more access) reach the gates.
 */
export function codexPermissions(mode: HostPermissionMode): {
  approvalPolicy: CodexApprovalPolicy;
  sandbox: CodexSandbox;
} {
  switch (mode) {
    case 'default':
    case 'acceptEdits':
      return { approvalPolicy: 'on-request', sandbox: 'workspace-write' };
    case 'plan':
      return { approvalPolicy: 'never', sandbox: 'read-only' };
    case 'bypassPermissions':
      return { approvalPolicy: 'never', sandbox: 'danger-full-access' };
  }
}

const SANDBOX_TYPES: Record<CodexSandbox, string> = {
  'read-only': 'readOnly',
  'workspace-write': 'workspaceWrite',
  'danger-full-access': 'dangerFullAccess',
};
const APPROVAL_METHODS = new Set([
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
]);

export type CodexSpawn = (
  cmd: string[],
  opts: { cwd: string; env: Record<string, string | undefined> },
) => PipedSubprocess;

// ---------------------------------------------------------------------------
// Configuration (mirrors ClaudeCodeSessionConfig)
// ---------------------------------------------------------------------------

export interface CodexSessionConfig {
  /** Thread launch options. Config is native launch data, not event/recording data. */
  appServer?: {
    /** Persist the actual returned binding before model admission; failure blocks work. */
    onThreadReady?: (binding: string) => void | Promise<void>;
    requireConfiguration?: boolean;
    config?: Readonly<Record<string, unknown>>;
    requiredMcpServer?: { readonly name: string; readonly tools: readonly string[] };
    /**
     * Native approval policy and sandbox for the thread. Default `never` / `danger-full-access`.
     * With `on-request` or `untrusted`, approval requests go to the gates registered through
     * onToolRequest() (stage `permission` only; Codex has no pre-use stage); with none registered
     * they are declined. The thread is started with `approvalsReviewer: "user"` and refused if the
     * runtime reports another reviewer (a config.toml `approvals_reviewer` would bypass the gates).
     * Under `never` nothing reaches a gate and onToolRequest() throws.
     * `codexPermissions(mode)` maps the host permission modes.
     */
    approvalPolicy?: CodexApprovalPolicy;
    sandbox?: CodexSandbox;
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
   * it to the first turn's prompt. Persists logically for the session via the
   * continued thread.
   */
  baseContext?: string;
  /**
   * codex's native thread ID. When set, the first send() resumes it with
   * `thread/resume` (cold resume by ID).
   */
  externalSessionId?: string;
  /** Environment merged over process.env (e.g. CODEX_HOME for a profile). */
  env?: Record<string, string | undefined>;
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
  onAdmission?: import('./harness-session').SessionSendOptions['onAdmission'];
  evidence: TurnState;
  message: string;
  timeout: number;
  resolve: (result: SessionResult) => void;
  reject: (error: Error) => void;
}

// codex reasoning-effort levels (model_reasoning_effort), low→high.
const VALID_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh'];

class NativeValidationError extends Error {}

export class CodexAppServerSession implements HarnessSession {
  get transport() {
    return TRANSPORTS['codex-app-server'];
  }
  readonly appServerProtocol = 'owned-thread-v1';

  // -- Config --
  private _bin: string;
  private _model: string;
  private _effort?: string;
  private _cwd: string;
  private _defaultTimeout: number;
  private _baseContext?: string;
  private _spawn?: CodexSpawn;
  private _env?: Record<string, string | undefined>;

  // -- Process --
  private _proc: PipedSubprocess | null = null;
  private _stderr = '';

  // -- Session state --
  private _externalSessionId?: string;
  private _alive = false;
  private _endEmitted = false;
  private _eventLog: SessionEvent[] = [];
  private _handlers: SessionEventHandler[] = [];
  private _observerFailures = { synchronous: 0, asynchronous: 0 };
  private _beforeSendHooks: BeforeSendHook[] = [];
  private _turns = 0;
  private _totalTokens = { input: 0, output: 0 };
  private _startedAt: number;
  /** Whether baseContext has been prepended onto a sent turn yet. */
  private _injectedBaseContext = false;

  // -- JSON-RPC --
  /** Monotonic JSON-RPC request id. */
  private _rpcId = 0;
  /** Pending JSON-RPC responses, keyed by request id. */
  private _pending = new Map<
    number,
    { resolve: (result: unknown) => void; reject: (e: Error) => void }
  >();

  // -- Turn queue (identical to ClaudeCodeSession) --
  private _queue: QueuedTurn[] = [];
  private _attempts: TurnState[] = [];
  private _seenTerminals = new Set<string>();
  private _inflight: QueuedTurn | null = null;
  private _resultText = '';
  private _turnTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(config?: CodexSessionConfig) {
    const bin = config?.bin ?? 'codex';
    if (!/^[a-zA-Z0-9_./\\-]+$/.test(bin)) {
      throw new Error(`Invalid codex CLI binary path: "${bin}"`);
    }
    if (config?.effort && !VALID_EFFORTS.includes(config.effort)) {
      throw new Error(
        `Invalid codex effort "${config.effort}". Valid: ${VALID_EFFORTS.join(', ')}`,
      );
    }
    this._bin = bin;
    this._model = config?.model ?? 'gpt-5.5';
    this._effort = config?.effort;
    this._cwd = config?.cwd ?? process.cwd();
    this._defaultTimeout = config?.timeout ?? 600_000;
    this._baseContext = config?.baseContext;
    this._externalSessionId = config?.externalSessionId;
    this._spawn = config?.spawn;
    this._env = config?.env;
    this._startedAt = Date.now();
    const { onThreadReady, ...options } = config?.appServer ?? {};
    this._onThreadReady = onThreadReady;
    this._options = retainEvidence(options);
    const required = this._options.requiredMcpServer;
    if (
      required &&
      (!/^[a-zA-Z0-9_-]+$/.test(required.name) ||
        !required.tools.length ||
        required.tools.some((t) => !/^[a-zA-Z0-9_-]+$/.test(t)))
    )
      throw new NativeValidationError('Invalid required MCP inventory');
  }

  // ---------------------------------------------------------------------------
  // Accessors (identical to ClaudeCodeSession)
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

  // ---------------------------------------------------------------------------
  // interrupt / kill / artifact (identical to ClaudeCodeSession)
  // ---------------------------------------------------------------------------

  interrupt(): void {
    if (!this._inflight) return;
    this._rejectInflight(
      new Error('Local waiter interrupted; native cancellation unacknowledged'),
      'interrupt-request',
    );
  }

  kill(): void {
    if (!this._proc) return;
    this._alive = false;

    if (this._turnTimer) {
      clearTimeout(this._turnTimer);
      this._turnTimer = null;
    }

    this._rejectInflight(new Error('Session killed; native outcome may remain unknown'), 'killed');
    this._rejectQueue(new Error('Session killed'));
    for (const p of this._pending.values()) p.reject(new Error('Session killed'));
    this._pending.clear();
    this._withdrawRequests();

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

    this._emit({ kind: 'session_end', timestamp: Date.now() });
  }

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
  // start() — spawn the persistent process + handshake
  // ---------------------------------------------------------------------------

  async start(): Promise<void> {
    if (this._inflight)
      throw Error('Native call ownership unresolved; automatic resume is blocked');
    if (this._startedOnce && !this._alive)
      throw Error('App-server restart requires a new owned instance and preflight');
    this._startedOnce = true;
    try {
      await this._launch();
    } catch (error) {
      this.kill();
      throw error;
    }
  }

  private async _launch(): Promise<void> {
    if (this._attempts.some((a) => a.dispatch === 'attempted' && a.nativeOutcome === 'unknown'))
      throw new Error('Native outcome unresolved; automatic resume is blocked');
    if (this._proc) throw new Error('Session already started');

    const args = this._buildSpawnArgs();
    const env: Record<string, string | undefined> = {
      ...process.env,
      ...this._env,
      DISABLE_AUTOUPDATER: '1',
    };
    // Subscription transport: an inherited API key never selects metered billing.
    delete env.OPENAI_API_KEY;
    delete env.CODEX_API_KEY;
    for (const key of Object.keys(env)) if (env[key] === undefined) delete env[key];

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

    this._alive = true;
    this._endEmitted = false;
    this._emit({ kind: 'session_start', timestamp: Date.now() });

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
      this._rejectQueue(new Error('Session ended'));
      for (const p of this._pending.values()) p.reject(new Error('Session ended'));
      this._pending.clear();
      this._withdrawRequests();
      this._emit({ kind: 'session_end', timestamp: Date.now(), transportOutcome: 'failed' });
    });

    await this._handshake();
  }

  // ---------------------------------------------------------------------------
  // send() — queue a turn, resolve on completion (identical control flow)
  // ---------------------------------------------------------------------------

  async send(
    message: string,
    opts?: import('./harness-session').SessionSendOptions,
  ): Promise<SessionResult> {
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
      const evidence = new TurnState();
      this._attempts.push(evidence);
      const turn: QueuedTurn = {
        evidence,
        message: transformed,
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
  // Private — turn dispatch + queue (mirrors ClaudeCodeSession)
  // ---------------------------------------------------------------------------

  readonly admissionProtocol = 'prewrite-v1' as const;
  inspectAttempt(admissionId: string) {
    return this._attempts.find((attempt) => attempt.admissionId === admissionId)?.snapshot();
  }

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
    this._resultText = '';

    // Resolves once the native terminal and the turn/start RPC have both settled.
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
        if (turn.evidence.rpcOutcome === 'pending') turn.evidence.rpcOutcome = 'unknown';
        this._rejectInflight(err, err instanceof NativeValidationError ? 'validation' : 'rpc');
        this._releaseKnownTurn();
      });

    if (turn.timeout > 0) {
      this._turnTimer = setTimeout(() => {
        this._turnTimer = null;
        this._rejectInflight(new Error(`Turn timed out after ${turn.timeout}ms`), 'timeout');
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
    if (a.localOutcome === 'pending') {
      a.localOutcome = 'resolved';
      this._inflight.resolve(a.result(this._externalSessionId));
    }
    if (a.nativeOutcome === 'unknown')
      this._rejectQueue(new Error('Native terminal missing; queued send not dispatched'));
    this._releaseKnownTurn();
  }

  private _releaseKnownTurn(): void {
    const a = this._inflight?.evidence;
    if (!a || !this._canReleaseAttempt(a) || a.nativeOutcome === 'unknown') return;
    this._turns++;
    this._inflight = null;
    this._processNextTurn();
  }

  private _processNextTurn(): void {
    if (!this._inflight && this._queue.length > 0 && this._alive) {
      const next = this._queue.shift()!;
      this._dispatchTurn(next);
    }
  }

  private _rejectInflight(
    err: Error,
    reason: import('./harness-session').SessionAttempt['localFailure'] = 'transport',
  ): void {
    if (!this._inflight) return;
    if (this._turnTimer) {
      clearTimeout(this._turnTimer);
      this._turnTimer = null;
    }
    const a = this._inflight.evidence;
    if ((reason === 'transport' || reason === 'killed') && a.transportOutcome === 'open')
      a.transportOutcome = reason === 'killed' ? 'closed' : 'failed';
    if (a.localOutcome === 'pending') this._inflight.reject(a.fail(err, reason));
    this._rejectQueue(new Error('Previous native work unresolved; queued send not dispatched'));
  }

  private _transportFailure(err: Error): void {
    this._alive = false;
    this._rejectInflight(err);
    this._rejectQueue(err);
    this._emit({ kind: 'session_end', timestamp: Date.now(), transportOutcome: 'failed' });
    for (const p of this._pending.values()) p.reject(err);
    this._pending.clear();
    this._withdrawRequests();
  }

  private _rejectQueue(err: Error): void {
    for (const turn of this._queue) turn.reject(turn.evidence.fail(err, 'blocked'));
    this._queue = [];
  }

  // ---------------------------------------------------------------------------
  // Private — stdout/stderr readers (mirrors ClaudeCodeSession)
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
        buffer = lines.pop()!;
        for (const line of lines) {
          if (!line.trim()) continue;
          if (this._proc === proc || !this._proc) this._processLine(line);
        }
      }
      if (buffer.trim() && (this._proc === proc || !this._proc)) this._processLine(buffer);
      if (this._proc === proc && this._alive)
        this._transportFailure(
          new Error(
            this._stderr.trim()
              ? `Native stdout closed: ${this._stderr.trim().slice(0, 500)}`
              : 'Native stdout closed',
          ),
        );
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
    } catch {
      /* ignore */
    }
  }

  // ---------------------------------------------------------------------------
  // Private — JSON-RPC line processor
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
    if (
      typeof raw.method === 'string' &&
      (typeof raw.id === 'string' || typeof raw.id === 'number') &&
      this._serverRequest(raw)
    )
      return;

    // JSON-RPC response to one of our requests (has matching `id` + result/error).
    if (typeof raw.id === 'number' && ('result' in raw || 'error' in raw)) {
      const pending = this._pending.get(raw.id);
      if (pending) {
        this._pending.delete(raw.id);
        const a = this._inflight?.evidence;
        if (a?.identity.rpcRequestId === raw.id) a.rpcOutcome = raw.error ? 'failed' : 'resolved';
        if ('error' in raw && raw.error) {
          const e = raw.error as Record<string, unknown>;
          pending.reject(new Error((e.message as string) ?? JSON.stringify(e)));
        } else {
          // Apply protocol identity synchronously before later lines in this
          // same stdout chunk. Awaiting the promise first can lose a terminal.
          try {
            this._observeRpcResult(raw.id, raw.result);
            pending.resolve(raw.result);
          } catch (error) {
            pending.reject(error instanceof Error ? error : new Error(String(error)));
          }
        }
        return;
      }
    }

    const classified = this._classify(raw);
    for (const event of classified) {
      const a = this._inflight?.evidence;
      if (!a || event.unattributedReason) {
        this._emit(event);
        continue;
      }
      const e = a.record(event);
      this._resultText = a.content;
      if (e.nativeOutcome && e.terminal) {
        a.nativeOutcome = e.nativeOutcome;
        a.terminal = e.terminal;
      }
      if (e.tokens) {
        this._totalTokens.input += e.tokens.input;
        this._totalTokens.output += e.tokens.output;
      }
      this._emit(e);
    }
    this._releaseKnownTurn();
  }

  // ---------------------------------------------------------------------------
  // Private — emit (identical to ClaudeCodeSession)
  // ---------------------------------------------------------------------------

  private _emit(event: SessionEvent): void {
    event = retainEvidence(event);
    if (event.kind === 'session_end') {
      if (this._endEmitted) return;
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

  // ---------------------------------------------------------------------------
  // Private — JSON-RPC request helper (resolves on the matching response)
  // ---------------------------------------------------------------------------

  private _rpcRequest(method: string, params?: unknown): Promise<unknown> {
    const id = ++this._rpcId;
    if (method === 'turn/start' && this._inflight) {
      this._inflight.evidence.identity = { ...this._inflight.evidence.identity, rpcRequestId: id };
      this._inflight.evidence.rpcOutcome = 'pending';
    }
    const payload = `${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`;
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

  private _rpcNotify(method: string, params?: unknown): void {
    const payload = `${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`;
    this._proc!.stdin.write(payload);
    this._proc!.stdin.flush();
  }

  // ---------------------------------------------------------------------------
  // Account limits, native interrupt, steer
  // ---------------------------------------------------------------------------

  private _limits?: LimitSnapshot;

  /** Latest account limits observed on this session (stream or poll). */
  get limits(): LimitSnapshot | undefined {
    return this._limits;
  }

  private _observeLimits(snapshot: LimitSnapshot): SessionEvent {
    this._limits = mergeLimits(this._limits, snapshot);
    return {
      kind: 'rate_limit',
      timestamp: Date.now(),
      correlation: 'unknown',
      unattributedReason: 'account-status',
      limits: this._limits,
    };
  }

  /** account/rateLimits/read — no model turn. Requires a started session. */
  async readLimits(opts?: { timeoutMs?: number }): Promise<LimitSnapshot | undefined> {
    if (!this._proc || !this._alive) throw Error('Session not running');
    let timer: ReturnType<typeof setTimeout> | undefined;
    const result = await Promise.race([
      this._rpcRequest('account/rateLimits/read', { excludeResetCreditDetails: true }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(Error('account/rateLimits/read timed out')),
          opts?.timeoutMs ?? 10_000,
        );
      }),
    ]).finally(() => clearTimeout(timer));
    const snapshot = codexLimitSnapshot(result, 'poll');
    if (snapshot) this._emit(this._observeLimits(snapshot));
    return snapshot;
  }

  /**
   * turn/interrupt for the owned in-flight turn. "acknowledged" once the turn's
   * own turn/completed arrives; the send() then settles through that terminal.
   */
  async interruptNative(opts?: { timeoutMs?: number }): Promise<NativeInterruptOutcome> {
    const a = this._inflight?.evidence;
    if (
      a?.dispatch !== 'attempted' ||
      a.nativeOutcome !== 'unknown' ||
      !a.identity.turnId ||
      !this._externalSessionId
    )
      return 'no-turn';
    const deadline = Date.now() + (opts?.timeoutMs ?? 5_000);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this._rpcRequest('turn/interrupt', {
          threadId: this._externalSessionId,
          turnId: a.identity.turnId,
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(Error('turn/interrupt timed out')),
            Math.max(1, deadline - Date.now()),
          );
        }),
      ]);
    } catch {
      return 'unacknowledged';
    } finally {
      clearTimeout(timer);
    }
    while (a.nativeOutcome === 'unknown' && this._alive && Date.now() < deadline)
      await Bun.sleep(10);
    return a.nativeOutcome === 'unknown' ? 'unacknowledged' : 'acknowledged';
  }

  /** Mid-turn steer (turn/steer) into the owned in-flight turn; otherwise records push_ignored. */
  async push(payload: { kind: string; text: string }): Promise<void> {
    const a = this._inflight?.evidence;
    const ignored = (reason: string) =>
      this._emit({
        kind: 'error',
        timestamp: Date.now(),
        text: `push_ignored: kind=${payload.kind} — ${reason}`,
        raw: { kind: payload.kind },
      });
    if (
      a?.dispatch !== 'attempted' ||
      a.nativeOutcome !== 'unknown' ||
      !a.identity.turnId ||
      !this._externalSessionId
    )
      return ignored('no owned in-flight turn');
    let timer: ReturnType<typeof setTimeout> | undefined,
      timedOut = false;
    try {
      await Promise.race([
        this._rpcRequest('turn/steer', {
          threadId: this._externalSessionId,
          expectedTurnId: a.identity.turnId,
          input: [{ type: 'text', text: payload.text }],
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            timedOut = true;
            reject(Error('turn/steer unanswered'));
          }, 10_000);
        }),
      ]);
      this._emit({
        ...a.identity,
        admissionId: a.admissionId,
        kind: 'native_status',
        timestamp: Date.now(),
        raw: { type: 'push-steered', kind: payload.kind },
      });
    } catch (error) {
      // A refusal is the runtime's answer; no answer leaves delivery unknown, never "ignored".
      if (timedOut || !this._alive)
        this._emit({
          ...a.identity,
          admissionId: a.admissionId,
          kind: 'native_status',
          timestamp: Date.now(),
          raw: { type: 'push-unknown', kind: payload.kind },
        });
      else ignored(`turn/steer refused: ${(error as Error).message.slice(0, 200)}`);
    } finally {
      clearTimeout(timer);
    }
  }
  private readonly _options: NonNullable<CodexSessionConfig['appServer']>;
  private readonly _onThreadReady?: (binding: string) => void | Promise<void>;
  private _startedOnce = false;
  private _threadReady = false;
  private _nativeSessionId?: string;
  private _appAdmission?: string;
  private _turnDone?: () => void;
  private _gates = new ToolGates();
  /** Approval requests awaiting a gate decision, by JSON-RPC request id. */
  private _approvals = new Map<string, AbortController>();
  /** The owned turn's in-progress fileChange items' changes, by item id, for their approvals. */
  private _fileChanges = new Map<string, readonly CodexFileChange[]>();
  private _items = new Map<
    string,
    {
      type: string;
      input?: unknown;
      completed: boolean;
      server?: string;
      tool?: string;
      text?: string;
    }
  >();

  fork(): HarnessSession {
    throw Error(
      'Native app-server fork is not implemented; a same-thread wrapper cannot create a native fork or inherit a process capability',
    );
  }

  /** Needs an `approvalPolicy` other than `never`. Gates registered here are not copied (no fork). */
  onToolRequest(gate: ToolGate): () => void {
    if (this._approvalPolicy === 'never')
      throw new Error(
        'Tool gates need an app-server session launched with approvalPolicy "on-request" or "untrusted"; under "never" no approval reaches them',
      );
    return this._gates.add(gate);
  }

  private _withdrawRequests(): void {
    for (const approval of this._approvals.values()) approval.abort();
    this._approvals.clear();
  }

  private get _approvalPolicy(): CodexApprovalPolicy {
    return this._options.approvalPolicy ?? 'never';
  }

  /** Approval requests are asked of this client, so they must reach the gates. */
  private get _gated(): boolean {
    return this._approvalPolicy !== 'never';
  }

  private get _sandbox(): CodexSandbox {
    return this._options.sandbox ?? 'danger-full-access';
  }

  /** A command or file-change approval for the owned turn, decided by the gates. */
  private _approval(request: Record<string, unknown>): boolean {
    const method = request.method as string;
    const params = object(request.params);
    const a = this._inflight?.evidence;
    if (
      !APPROVAL_METHODS.has(method) ||
      !a?.identity.turnId ||
      params?.threadId !== a.identity.threadId ||
      params?.turnId !== a.identity.turnId ||
      (typeof request.id !== 'string' && typeof request.id !== 'number')
    )
      return false;
    const str = (value: unknown) => (typeof value === 'string' && value ? value : undefined);
    const command = method === 'item/commandExecution/requestApproval';
    const network = object(params.networkApprovalContext);
    const host = str(network?.host),
      protocol = str(network?.protocol);
    const changes = str(params.itemId) ? this._fileChanges.get(params.itemId as string) : undefined;
    const toolInput: Record<string, unknown> = command
      ? {
          ...(str(params.command) ? { command: params.command } : {}),
          ...(str(params.cwd) ? { cwd: params.cwd } : {}),
          ...(str(params.kind) ? { kind: params.kind } : {}),
          ...(host ? { networkApprovalContext: { host, ...(protocol ? { protocol } : {}) } } : {}),
        }
      : {
          ...(str(params.grantRoot) ? { grantRoot: params.grantRoot } : {}),
          ...(changes ? { changes: structuredClone(changes) } : {}),
        };
    const proc = this._proc;
    const id = request.id;
    const key = JSON.stringify(id);
    const controller = new AbortController();
    this._approvals.get(key)?.abort();
    this._approvals.set(key, controller);
    const identity = { ...a.identity, admissionId: a.admissionId };
    this._emit({
      ...identity,
      kind: 'native_status',
      timestamp: Date.now(),
      raw: { type: 'approval-request', method },
    });
    void this._gates
      .decide({
        stage: 'permission',
        toolName: command ? 'shell' : 'apply_patch',
        toolInput: Object.freeze(toolInput),
        ...(str(params.itemId) ? { callId: params.itemId as string } : {}),
        admissionId: a.admissionId,
        ...(str(params.reason) ? { description: params.reason as string } : {}),
        signal: controller.signal,
      })
      .then((decision) => {
        if (controller.signal.aborted || this._proc !== proc || !this._alive || !proc) return;
        this._approvals.delete(key);
        const accepted = decision?.behavior === 'allow';
        try {
          proc.stdin.write(
            `${JSON.stringify({ jsonrpc: '2.0', id, result: { decision: accepted ? 'accept' : 'decline' } })}\n`,
          );
          proc.stdin.flush();
        } catch {
          return;
        }
        this._emit({
          ...identity,
          kind: 'native_status',
          timestamp: Date.now(),
          raw: { type: 'approval-response', method, decision: accepted ? 'accept' : 'decline' },
        });
      })
      .finally(() => {
        if (this._approvals.get(key) === controller) this._approvals.delete(key);
      });
    return true;
  }

  private _serverRequest(request: Record<string, unknown>): boolean {
    if (this._approval(request)) return true;
    // JSON-RPC's explicit method-not-supported refusal also covers unknown future
    // requests. Never approve native work or echo private request parameters.
    const payload = `${JSON.stringify({
      jsonrpc: '2.0',
      id: request.id,
      error: { code: -32601, message: 'Client interaction is unsupported by this adapter' },
    })}\n`;
    const params = object(request.params),
      a = this._inflight?.evidence;
    const identity =
      a?.identity.turnId &&
      params?.threadId === a.identity.threadId &&
      params?.turnId === a.identity.turnId
        ? { ...a.identity, admissionId: a.admissionId }
        : { unattributedReason: 'unrecognized-event' as const };
    try {
      this._proc!.stdin.write(payload);
      this._proc!.stdin.flush();
    } catch {
      this._emit({
        ...identity,
        kind: 'native_status',
        timestamp: Date.now(),
        raw: { type: 'server-request-refusal', status: 'write-failed' },
      });
      return true;
    }
    this._emit({
      ...identity,
      kind: 'native_status',
      timestamp: Date.now(),
      raw: { type: 'server-request-refusal', status: 'refused' },
    });
    return true;
  }

  private _refuse(reason: string, status = 'unknown'): never {
    const a = this._inflight?.evidence;
    this._emit({
      ...(a ? { admissionId: a.admissionId, ...a.identity } : {}),
      kind: 'native_status',
      timestamp: Date.now(),
      raw: { type: 'thread-refused', reason, status },
    });
    throw new NativeValidationError(
      `Native thread validation refused: ${reason} (${status}); no turn was sent`,
    );
  }

  private async _readiness(): Promise<void> {
    const required = this._options.requiredMcpServer;
    if (!required) return;
    let cursor: string | undefined;
    const seen = new Set<string>();
    let found: Record<string, unknown> | undefined;
    // Pagination only, never polling/retrying a starting or failed native server.
    for (let page = 0; page < 32; page++) {
      const result = object(
        await this._rpcRequest('mcpServerStatus/list', {
          threadId: this._externalSessionId,
          detail: 'toolsAndAuthOnly',
          limit: 100,
          ...(cursor ? { cursor } : {}),
        }),
      );
      if (!Array.isArray(result?.data)) this._refuse('mcp-inventory-malformed');
      for (const entry of result.data) {
        const server = object(entry);
        if (server?.name === required.name) {
          if (found) this._refuse('mcp-inventory-duplicate');
          found = server;
        }
      }
      if (result.nextCursor == null) {
        const tools = object(found?.tools);
        if (
          found?.runtimeStatus !== 'connected' ||
          !tools ||
          required.tools.some((name) => object(tools[name])?.name !== name)
        )
          this._refuse('mcp-inventory-unavailable');
        const a = this._inflight!.evidence;
        this._emit({
          ...a.identity,
          admissionId: a.admissionId,
          kind: 'native_status',
          timestamp: Date.now(),
          raw: {
            type: 'mcp-ready',
            status: 'connected',
            server: required.name,
            tools: [...required.tools],
          },
        });
        return;
      }
      if (
        typeof result.nextCursor !== 'string' ||
        !result.nextCursor ||
        seen.has(result.nextCursor)
      )
        this._refuse('mcp-inventory-cursor');
      cursor = result.nextCursor;
      seen.add(cursor);
    }
    this._refuse('mcp-inventory-page-limit');
  }

  private _canReleaseAttempt(a: TurnState): boolean {
    // An observer/write failure may occur after delivery. A terminal alone does
    // not settle the unanswered turn/start call or authorize another admission.
    return a.rpcSettled && (a.rpcOutcome === 'resolved' || a.rpcOutcome === 'failed');
  }

  private _buildSpawnArgs(): string[] {
    return ['app-server', '--listen', 'stdio://'];
  }

  private async _handshake(): Promise<void> {
    this._threadReady = false;
    const initialized = object(
      await this._rpcRequest('initialize', {
        capabilities: {},
        clientInfo: { name: 'inixiative-bench', version: '0.1.0' },
      }),
    );
    if (
      this._options.requireConfiguration &&
      ['userAgent', 'platformFamily', 'platformOs', 'codexHome'].some(
        (key) => typeof initialized?.[key] !== 'string' || !initialized[key],
      )
    )
      throw new NativeValidationError(
        'Native initialize response lacks required configuration; no thread or turn was sent',
      );
    this._rpcNotify('initialized');
  }

  private async _sendTurn(message: string): Promise<{ input: number; output: number } | undefined> {
    const a = this._inflight!.evidence;
    if (!this._threadReady) {
      const binding = this._externalSessionId;
      const method = binding ? 'thread/resume' : 'thread/start';
      const response = object(
        await this._rpcRequest(method, {
          ...(binding ? { threadId: binding } : {}),
          model: this._model,
          cwd: this._cwd,
          approvalPolicy: this._approvalPolicy,
          // Approvals go to the gates, never to a config-selected reviewer (auto_review, guardian).
          ...(this._gated ? { approvalsReviewer: 'user' } : {}),
          sandbox: this._sandbox,
          ...(this._options.config ? { config: this._options.config } : {}),
        }),
      );
      const thread = object(response?.thread),
        id = thread?.id;
      if (typeof id !== 'string' || !id || (binding && id !== binding))
        this._refuse('binding-mismatch');
      // Resume may rejoin a live thread. Never steer known pre-existing work.
      // The installed schema requires status. Missing/unknown state cannot
      // authorize work, even if this response otherwise identifies our thread.
      if (
        object(thread?.status)?.type !== 'idle' ||
        (Array.isArray(thread?.turns) &&
          thread.turns.some((turn) => object(turn)?.status === 'inProgress'))
      )
        this._refuse(
          'not-idle',
          ['active', 'notLoaded', 'systemError'].includes(String(object(thread?.status)?.type))
            ? String(object(thread?.status)?.type)
            : 'unknown',
        );
      if (
        this._gated &&
        (response?.approvalsReviewer !== 'user' || response.approvalPolicy !== this._approvalPolicy)
      )
        this._refuse(
          'approvals-not-routed-to-user',
          ['user', 'auto_review', 'guardian_subagent'].includes(String(response?.approvalsReviewer))
            ? String(response?.approvalsReviewer)
            : 'unknown',
        );
      if (
        this._options.requireConfiguration &&
        (typeof response?.model !== 'string' ||
          !response.model ||
          typeof response.modelProvider !== 'string' ||
          !response.modelProvider ||
          response.cwd !== this._cwd ||
          response.approvalPolicy !== this._approvalPolicy ||
          response.approvalsReviewer !== 'user' ||
          object(response.sandbox)?.type !== SANDBOX_TYPES[this._sandbox] ||
          !Array.isArray(thread?.turns) ||
          thread.turns.some((value) => !this._turn(value)))
      )
        this._refuse('configuration-missing-or-incompatible');
      this._externalSessionId = id;
      this._nativeSessionId =
        typeof thread?.sessionId === 'string' && thread.sessionId ? thread.sessionId : undefined;
      a.identity = {
        ...a.identity,
        threadId: id,
        ...(this._nativeSessionId ? { nativeSessionId: this._nativeSessionId } : {}),
      };
      if (this._onThreadReady) {
        try {
          await this._onThreadReady(id);
        } catch (cause) {
          throw new NativeValidationError('Native binding persistence failed before turn/start', {
            cause,
          });
        }
      }
      this._threadReady = true;
      // Configuration belongs to this process/thread, never to the next turn.
      // Do not copy historical turns, instructions, paths or arbitrary config.
      this._emit({
        kind: 'native_status',
        timestamp: Date.now(),
        threadId: id,
        nativeSessionId: this._nativeSessionId,
        correlation: 'unknown',
        unattributedReason: 'session-configuration',
        raw: {
          type: 'thread-configured',
          method,
          threadId: id,
          ...(object(thread?.status)?.type === 'idle' ? { status: 'idle' } : {}),
          ...(typeof response?.model === 'string' ? { model: response.model } : {}),
          ...(response?.reasoningEffort === null ||
          VALID_EFFORTS.includes(String(response?.reasoningEffort))
            ? { reasoningEffort: response?.reasoningEffort }
            : {}),
          history: {
            source: method,
            turns: Array.isArray(thread?.turns)
              ? thread.turns.slice(0, 200).flatMap((value) => {
                  const t = this._turn(value);
                  return t ? [{ id: t.id, status: t.status }] : [];
                })
              : [],
            available: Array.isArray(thread?.turns),
            hasMore:
              !!response?.turnsBackwardsCursor ||
              (Array.isArray(thread?.turns) && thread.turns.length > 200),
          },
        },
      });
    }
    a.identity = {
      ...a.identity,
      threadId: this._externalSessionId,
      ...(this._nativeSessionId ? { nativeSessionId: this._nativeSessionId } : {}),
    };
    await this._readiness();
    // Timeout/kill during create/resume must not cause a later model write.
    if (this._inflight?.evidence !== a || a.localOutcome !== 'pending' || !this._alive)
      throw Error('Local admission closed before turn/start; no turn was sent');
    a.identity = {
      ...a.identity,
      threadId: this._externalSessionId,
      ...(this._nativeSessionId ? { nativeSessionId: this._nativeSessionId } : {}),
    };
    this._appAdmission = a.admissionId;
    this._items.clear();
    const completed = new Promise<void>((resolve) => {
      this._turnDone = resolve;
    });
    await this._rpcRequest('turn/start', {
      threadId: this._externalSessionId,
      input: [{ type: 'text', text: message }],
      ...(this._effort ? { effort: this._effort } : {}),
    });
    await completed; // Native terminal and RPC acknowledgment are both required.
    return a.tokens;
  }

  private _observeRpcResult(id: number, result: unknown): void {
    const a = this._inflight?.evidence;
    if (!a || this._appAdmission !== a.admissionId || a.identity.rpcRequestId !== id) return;
    const turn = this._turn(object(result)?.turn);
    if (
      !turn ||
      (a.identity.turnId && turn.id !== a.identity.turnId) ||
      (!a.identity.turnId && this._seenTerminals.has(turn.id))
    )
      throw new NativeValidationError(
        'Native turn/start response missing or conflicts with owned turn',
      );
    a.identity = { ...a.identity, turnId: turn.id, correlation: 'native-turn' };
  }

  private _turn(value: unknown): { id: string; status: string; error?: unknown } | undefined {
    const turn = object(value);
    if (
      !turn ||
      typeof turn.id !== 'string' ||
      !turn.id ||
      !Array.isArray(turn.items) ||
      !['inProgress', 'completed', 'failed', 'interrupted'].includes(String(turn.status))
    )
      return;
    return turn as { id: string; status: string; error?: unknown };
  }

  private _classify(msg: Record<string, unknown>): SessionEvent[] {
    const method = typeof msg.method === 'string' ? msg.method : undefined;
    if (!method) return [];
    if (method === 'account/rateLimits/updated') {
      const snapshot = codexLimitSnapshot(msg.params, 'stream');
      return snapshot ? [this._observeLimits(snapshot)] : [];
    }
    if (method === 'serverRequest/resolved') {
      // The runtime settled or withdrew an approval itself: a later gate decision is discarded.
      const requestId = object(msg.params)?.requestId;
      const key = JSON.stringify(requestId);
      this._approvals.get(key)?.abort();
      this._approvals.delete(key);
    }
    const params = object(msg.params),
      turn = this._turn(params?.turn),
      item = object(params?.item);
    const str = (value: unknown) => (typeof value === 'string' && value ? value : undefined);
    const threadId = str(params?.threadId),
      turnId = turn?.id ?? str(params?.turnId),
      itemId = str(item?.id) ?? str(params?.itemId);
    const unowned = (reason: NonNullable<SessionEvent['unattributedReason']>): SessionEvent[] => [
      {
        kind: 'native_status',
        timestamp: Date.now(),
        threadId,
        turnId,
        itemId,
        correlation: 'unknown',
        unattributedReason: reason,
        raw: {
          method: [
            'turn/started',
            'turn/completed',
            'item/started',
            'item/completed',
            'thread/tokenUsage/updated',
            'item/agentMessage/delta',
            'item/commandExecution/outputDelta',
          ].includes(method)
            ? method
            : 'unrecognized',
          ...(item
            ? {
                itemType: ['agentMessage', 'commandExecution', 'reasoning', 'mcpToolCall'].includes(
                  String(item.type),
                )
                  ? item.type
                  : 'unsupported',
              }
            : {}),
        },
      },
    ];
    const a = this._inflight?.evidence;
    if (!threadId || threadId !== this._externalSessionId) return unowned('foreign-session');
    if (!a || this._appAdmission !== a.admissionId) return unowned('no-admission');
    if (turnId && this._seenTerminals.has(turnId))
      return unowned(method === 'turn/completed' ? 'duplicate-terminal' : 'after-terminal');
    if (method === 'turn/started' && turn?.status === 'inProgress' && !a.identity.turnId)
      a.identity = { ...a.identity, threadId, turnId: turn.id, correlation: 'native-turn' };
    if (!turnId || turnId !== a.identity.turnId) return unowned('foreign-turn');
    const identity = { ...a.identity, threadId, turnId, ...(itemId ? { itemId } : {}) };
    const status = (): SessionEvent[] => [
      { ...identity, kind: 'native_status', timestamp: Date.now(), raw: { method } },
    ];
    if (method === 'turn/completed') {
      if (!turn || turn.status === 'inProgress') return unowned('unrecognized-event');
      const error = object(turn.error);
      if (turn.error != null && typeof error?.message !== 'string')
        return unowned('unrecognized-event');
      this._seenTerminals.add(turnId);
      this._fileChanges.clear();
      this._turnDone?.();
      this._turnDone = undefined;
      return [
        {
          ...identity,
          kind: 'result',
          timestamp: Date.now(),
          text: a.content,
          nativeOutcome: turn.status === 'completed' && !error ? 'completed' : 'failed',
          terminal: {
            type: method,
            turnId,
            subtype: turn.status,
            ...(error ? { reason: error.message as string } : {}),
          },
        },
      ];
    }
    if (method === 'thread/tokenUsage/updated') {
      const last = object(object(params?.tokenUsage)?.last);
      if (
        typeof last?.inputTokens !== 'number' ||
        typeof last?.outputTokens !== 'number' ||
        !Number.isSafeInteger(last.inputTokens) ||
        !Number.isSafeInteger(last.outputTokens) ||
        last.inputTokens < 0 ||
        last.outputTokens < 0
      )
        return unowned('unrecognized-event');
      // `last` is a snapshot, not an additive delta. Total accounting happens once
      // when the original native turn and RPC settle; absent usage stays absent.
      a.tokens = { input: last.inputTokens, output: last.outputTokens };
      return status();
    }
    if (method === 'item/agentMessage/delta' || method === 'item/commandExecution/outputDelta') {
      if (!itemId || typeof params?.delta !== 'string') return unowned('unrecognized-event');
      const prior = this._items.get(itemId);
      if (prior?.completed) return unowned('after-terminal');
      if (method === 'item/agentMessage/delta') {
        if (prior && prior.type !== 'agentMessage') return unowned('unmatched-tool');
        this._items.set(itemId, {
          type: 'agentMessage',
          completed: false,
          text: (prior?.text ?? '') + params.delta,
        });
        return [{ ...identity, kind: 'text_delta', timestamp: Date.now(), text: params.delta }];
      }
      if (prior?.type !== 'commandExecution') return unowned('unmatched-tool');
      return [
        {
          ...identity,
          kind: 'native_status',
          timestamp: Date.now(),
          toolName: 'shell',
          text: params.delta,
        },
      ];
    }
    if (method === 'item/fileChange/patchUpdated') {
      // Changes only feed the item's approval request; the event itself stays a diagnostic.
      if (itemId && this._fileChanges.has(itemId))
        this._fileChanges.set(itemId, fileChanges(params?.changes));
      return unowned('unrecognized-event');
    }
    if (method === 'item/completed' || method === 'item/started') {
      if (!itemId || !item || typeof item.type !== 'string') return unowned('unrecognized-event');
      if (item.type === 'fileChange') {
        if (method === 'item/started') this._fileChanges.set(itemId, fileChanges(item.changes));
        else this._fileChanges.delete(itemId);
        return unowned('unrecognized-event');
      }
      if (item.type === 'agentMessage') {
        if (method !== 'item/completed') return status();
        if (this._items.get(itemId)?.completed) return unowned('after-terminal');
        if (
          typeof item.text !== 'string' ||
          (item.phase != null && !['commentary', 'final_answer'].includes(String(item.phase)))
        )
          return unowned('unrecognized-event');
        this._items.set(itemId, { type: item.type, completed: true });
        return [{ ...identity, kind: 'text', timestamp: Date.now(), text: item.text }];
      }
      if (item.type === 'commandExecution') {
        if (typeof item.command !== 'string') return unowned('malformed-tool');
        const prior = this._items.get(itemId);
        if (method === 'item/started') {
          if (prior) return unowned('duplicate-tool');
          this._items.set(itemId, { type: item.type, input: item.command, completed: false });
          return [
            {
              ...identity,
              kind: 'tool_use',
              timestamp: Date.now(),
              toolName: 'shell',
              toolInput: { command: item.command },
            },
          ];
        }
        if (!prior || prior.type !== item.type || prior.input !== item.command)
          return unowned('unmatched-tool');
        if (prior.completed) return unowned('duplicate-tool');
        if (!['completed', 'failed', 'declined'].includes(String(item.status)))
          return unowned('malformed-tool');
        prior.completed = true;
        return [
          {
            ...identity,
            kind: 'tool_result',
            timestamp: Date.now(),
            toolName: 'shell',
            ...(typeof item.aggregatedOutput === 'string'
              ? { toolOutput: item.aggregatedOutput }
              : { toolOutputOmitted: true }),
            toolError:
              item.status !== 'completed' ||
              (typeof item.exitCode === 'number' && item.exitCode !== 0),
          },
        ];
      }
      if (item.type === 'mcpToolCall') {
        if (
          typeof item.server !== 'string' ||
          !item.server ||
          typeof item.tool !== 'string' ||
          !item.tool
        )
          return unowned('malformed-tool');
        const prior = this._items.get(itemId);
        const tool = {
          toolServer: item.server,
          toolMethod: item.tool,
          toolName: `mcp__${item.server}__${item.tool}`,
        };
        if (method === 'item/started') {
          if (prior) return unowned('duplicate-tool');
          if (item.status !== 'inProgress') return unowned('malformed-tool');
          this._items.set(itemId, {
            type: item.type,
            server: item.server,
            tool: item.tool,
            input: retainEvidence(item.arguments),
            completed: false,
          });
          return [
            {
              ...identity,
              ...tool,
              kind: 'tool_use',
              timestamp: Date.now(),
              ...publicMcpArguments(item.arguments),
            },
          ];
        }
        if (
          !prior ||
          prior.type !== item.type ||
          prior.server !== item.server ||
          prior.tool !== item.tool ||
          !isDeepStrictEqual(prior.input, item.arguments)
        )
          return unowned('unmatched-tool');
        if (prior.completed) return unowned('duplicate-tool');
        if (!['completed', 'failed'].includes(String(item.status)))
          return unowned('malformed-tool');
        const error = object(item.error),
          result = object(item.result);
        const output = result ? publicMcpResult(result.content) : undefined;
        if (item.error != null && typeof error?.message !== 'string')
          return unowned('malformed-tool');
        prior.completed = true;
        return [
          {
            ...identity,
            ...tool,
            kind: 'tool_result',
            timestamp: Date.now(),
            ...(output ??
              (error ? { toolOutput: error.message as string } : { toolOutputOmitted: true })),
            toolError: item.status === 'failed' || !!error,
            ...(result && Object.keys(result).some((k) => k !== 'content' && result[k] != null)
              ? { toolOutputOmitted: true }
              : {}),
          },
        ];
      }
      // Reasoning and unsupported items retain safe identity/type diagnostics only.
      return unowned('unrecognized-event');
    }
    return method === 'turn/started' ? status() : unowned('unrecognized-event');
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

/** A fileChange item's change as a file-change gate sees it (`toolInput.changes`). */
export interface CodexFileChange {
  readonly path: string;
  readonly kind: 'add' | 'delete' | 'update';
  /** Rename target of an `update`. */
  readonly movePath?: string;
  /** Unified diff, present while it fits the bound; otherwise `diffOmitted`. */
  readonly diff?: string;
  readonly diffOmitted?: true;
}
const FILE_CHANGE_DIFF_LIMIT = 16 * 1024;
const FILE_CHANGE_DIFF_TOTAL = 64 * 1024;

/** Native FileUpdateChange[] (codex 0.155.1) → CodexFileChange[]; diffs only within the bound. */
function fileChanges(value: unknown): readonly CodexFileChange[] {
  if (!Array.isArray(value)) return [];
  let budget = FILE_CHANGE_DIFF_TOTAL;
  const out: CodexFileChange[] = [];
  for (const entry of value) {
    const change = object(entry);
    const kind = object(change?.kind);
    if (
      typeof change?.path !== 'string' ||
      !change.path ||
      (kind?.type !== 'add' && kind?.type !== 'delete' && kind?.type !== 'update')
    )
      continue;
    const diff = typeof change.diff === 'string' ? change.diff : undefined;
    const fits =
      diff !== undefined && diff.length <= FILE_CHANGE_DIFF_LIMIT && diff.length <= budget;
    if (fits) budget -= diff.length;
    out.push({
      path: change.path,
      kind: kind.type,
      ...(kind.type === 'update' && typeof kind.move_path === 'string' && kind.move_path
        ? { movePath: kind.move_path }
        : {}),
      ...(fits ? { diff } : diff ? { diffOmitted: true as const } : {}),
    });
  }
  return out;
}

function publicMcpArguments(value: unknown): Pick<SessionEvent, 'toolInput' | 'toolInputOmitted'> {
  if (!object(value)) return { toolInputOmitted: 'Native arguments absent or not an object' };
  let omitted = false;
  const clean = (v: unknown, depth = 0): unknown => {
    if (depth > 32) {
      omitted = true;
      return null;
    }
    if (v === null || ['string', 'number', 'boolean'].includes(typeof v)) return v;
    if (Array.isArray(v)) return v.map((x) => clean(x, depth + 1));
    if (!object(v)) {
      omitted = true;
      return null;
    }
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>).flatMap(([key, item]) => {
        if (
          /^(?:__proto__|constructor|prototype|env|environment|authorization|credentials?|api[-_]?key|access[-_]?token|refresh[-_]?token|password|secret|reasoning|thinking)$/i.test(
            key,
          )
        ) {
          omitted = true;
          return [];
        }
        return [[key, clean(item, depth + 1)]];
      }),
    );
  };
  const toolInput = clean(value) as Record<string, unknown>;
  return {
    toolInput,
    ...(omitted ? { toolInputOmitted: 'Non-public or unsupported argument fields omitted' } : {}),
  };
}

/** An mcpToolCall result's content: public text blocks (including the bridge's JSON receipt)
 * are kept; any other block keeps only a known type label. */
function publicMcpResult(
  value: unknown,
): Pick<SessionEvent, 'toolOutput' | 'toolOutputOmitted'> | undefined {
  if (!Array.isArray(value)) return;
  let omitted = false;
  const content = value.map((entry) => {
    const block = object(entry);
    if (block?.type === 'text' && typeof block.text === 'string') {
      if (Object.keys(block).some((k) => k !== 'type' && k !== 'text')) omitted = true;
      return { type: 'text', text: block.text };
    }
    omitted = true;
    // Unknown shape values are not safe labels. Known non-text types retain type only.
    return {
      type: ['image', 'audio', 'resource', 'resource_link'].includes(String(block?.type))
        ? block!.type
        : 'unsupported',
    };
  });
  return {
    toolOutput: JSON.stringify({ content }),
    ...(omitted ? { toolOutputOmitted: true } : {}),
  };
}
