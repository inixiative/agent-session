import { resolve } from 'node:path';
import type { HostPermissionMode, PipedSubprocess } from './codex-session';
import {
  type BeforeSendHook,
  type HarnessSession,
  NativeBindingMissingError,
  type NativeInterruptOutcome,
  NativeModelMissingError,
  type PushOutcome,
  type SessionArtifact,
  type SessionAttempt,
  type SessionEvent,
  type SessionEventHandler,
  type SessionImage,
  type SessionResult,
  type SessionSendOptions,
  type SessionTokens,
  sendableImages,
  type ToolGate,
} from './harness-session';
import { JsonRpcConnection, JsonRpcError } from './json-rpc';
import { retainEvidence } from './retained-evidence';
import { mcpToolParts, ToolGates } from './tool-gate';
import { TRANSPORTS } from './transport';
import { TurnState } from './turn-state';

// ---------------------------------------------------------------------------
// AcpSession — Agent Client Protocol (ACP v1) session over stdio JSON-RPC 2.0
// ---------------------------------------------------------------------------
//
// Drives any ACP v1 stdio agent — Antigravity (`agy acp --stdio`), Gemini CLI
// (`gemini --acp`), or another compliant ACP server — through the shared
// HarnessSession contract. Every `session/update` notification maps into the
// shared SessionEvent taxonomy; `session/request_permission` routes through
// ToolGates (fail-closed when gated, auto-approve under bypassPermissions).
// ---------------------------------------------------------------------------

const ACP_PROTOCOL_VERSION = 1;
const DEFAULT_TURN_TIMEOUT_MS = 600_000;
const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;
const DEFAULT_CLOSE_GRACE_MS = 2_000;
const CLIENT_INFO = { name: 'agent-session', title: 'agent-session', version: '1' } as const;

const MISSING_SESSION_PATTERN =
  /session\s+(?:id\s+)?not\s+found|unknown\s+session|no\s+such\s+session|session\s+does\s+not\s+exist/i;
const MISSING_MODEL_PATTERN =
  /model\s+(?:id\s+)?['"`]?[\w.:/-]*['"`]?\s+(?:not\s+found|does\s+not\s+exist|is\s+not\s+(?:supported|available))|unknown\s+model|invalid\s+model|model_not_found|invalid\s+value.*(?:config\s+option\s+)?['"`]?model['"`]?/i;
const ANTIGRAVITY_AUTH_URL_PREFIX = 'Open the following link to authenticate the ACP server: ';
const ANTIGRAVITY_NO_BROWSER_PREFIX = 'No browser is available here';
const AUTH_ERROR_PATTERN = /auth|sign[\s-]?in|log[\s-]?in|unauthenticated|credential/i;

/**
 * Inherited env vars that would override Gemini CLI OAuth/Google login with a
 * metered API key, service account, or GCP project. Stripped by default in `geminiCliAcpLaunch`.
 */
export const GEMINI_CLI_COMPETING_ENV: readonly string[] = Object.freeze([
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'GOOGLE_GENAI_USE_VERTEXAI',
  'GEMINI_CLI_AUTH_OVERRIDE',
  'GOOGLE_CLOUD_PROJECT',
  'GOOGLE_CLOUD_LOCATION',
  'GOOGLE_CLOUD_QUOTA_PROJECT',
  'GCLOUD_PROJECT',
  'CLOUDSDK_CORE_PROJECT',
]);

/**
 * Inherited env vars that would override Antigravity subscription auth with a
 * metered API key, service account, GCP project, Vertex AI, or auth override.
 * Stripped by default in `agyAcpLaunch`.
 */
export const AGY_COMPETING_ENV: readonly string[] = Object.freeze([
  ...GEMINI_CLI_COMPETING_ENV,
  'AGY_ACP_CCPA_PROJECT',
  'AGY_ACP_ENABLE_OAUTH',
  'AGY_ACP_FORCE_FILE_STORAGE',
]);

export type AcpMcpServer =
  | {
      readonly type?: undefined;
      readonly name: string;
      readonly command: string;
      readonly args: readonly string[];
      readonly env: readonly { readonly name: string; readonly value: string }[];
    }
  | {
      readonly type: 'http' | 'sse';
      readonly name: string;
      readonly url: string;
      readonly headers: readonly { readonly name: string; readonly value: string }[];
    };

export interface AcpServerCapabilities {
  readonly loadSession: boolean;
  readonly promptCapabilities: {
    readonly image: boolean;
    readonly audio: boolean;
    readonly embeddedContext: boolean;
  };
  readonly mcpCapabilities: {
    readonly http: boolean;
    readonly sse: boolean;
    readonly acp: boolean;
  };
  readonly sessionCapabilities: {
    readonly resume: boolean;
    readonly fork: boolean;
    readonly close: boolean;
  };
  /** Agent supports `_meta.antigravity.systemPrompt.append` on session create/resume/load. */
  readonly systemPromptAppend: boolean;
  readonly agentInfo?: {
    readonly name: string;
    readonly title?: string;
    readonly version?: string;
  };
}

export interface AcpConfigOption {
  readonly id: string;
  readonly name: string;
  readonly category?: string;
  readonly type: 'select' | 'boolean';
  readonly currentValue: string | boolean;
  readonly options?: readonly { readonly value: string; readonly name: string }[];
}

export type AcpSpawn = (
  cmd: readonly string[],
  opts: { cwd: string; env: Record<string, string | undefined> },
) => PipedSubprocess;

export interface AcpSessionConfig {
  /** Agent command, e.g. `["agy", "acp", "--stdio"]` or `["gemini", "--acp"]`. */
  command: readonly string[];
  /** Working directory for the subprocess and ACP `session/new` / `session/load`. */
  cwd?: string;
  /** Environment merged over `process.env`. Keys with `undefined` value are omitted. */
  env?: Record<string, string | undefined>;
  /** Env var names or regex patterns removed from the child environment (e.g. `AGY_COMPETING_ENV`). */
  stripEnv?: readonly (string | RegExp)[];
  /** Default per-send timeout in ms. Defaults to 600000 (10 min). */
  timeout?: number;
  /** Startup / handshake RPC timeout in ms. Defaults to 30000 (30 s). */
  startupTimeout?: number;
  /** Model id applied after session creation/load via `session/set_config_option` or `session/set_model`. */
  model?: string;
  /** Reasoning effort applied after session creation/load when the agent advertises a `thought_level` / `effort` config option. */
  effort?: string;
  /** Host permission mode. Under `bypassPermissions`, inbound permission asks auto-approve; otherwise they go to `onToolRequest()` gates (fail-closed when none registered). Defaults to `default`. */
  permissionMode?: HostPermissionMode;
  /** Passed natively via `_meta.antigravity.systemPrompt.append` when advertised; otherwise prepended to the first turn's text. */
  baseContext?: string;
  /** Native ACP `sessionId` to resume during `start()`. */
  externalSessionId?: string;
  /**
   * Which ACP resume method to try first when `externalSessionId` is set. Defaults to `'resume'`
   * (prefers `session/resume` to avoid replaying history `AcpSession` discards, falling back to
   * `session/load`).
   */
  resumeMethod?: 'resume' | 'load';
  /** MCP servers passed to `session/new` / `session/load`, filtered by the agent's advertised `mcpCapabilities`. */
  mcpServers?: readonly AcpMcpServer[];
  /** Persist the returned native `sessionId` before the session becomes live; a rejection aborts `start()`. */
  onSessionReady?: (sessionId: string) => void | Promise<void>;
  /** Override subprocess spawn (for tests or container wrapping). Defaults to `Bun.spawn`. */
  spawn?: AcpSpawn;
}

type SharedLaunchOptions = Omit<AcpSessionConfig, 'command' | 'stripEnv'> & {
  /** CLI binary path or name. */
  bin?: string;
  /** `'subscription'` (default) strips competing Google/Gemini API keys; `'api'` preserves them. */
  billing?: 'subscription' | 'api';
  /** Additional workspace directories to grant the agent. */
  addDirs?: readonly string[];
  /** Enable CLI sandbox mode. */
  sandbox?: boolean;
};

export interface AgyAcpLaunchOptions extends SharedLaunchOptions {
  /**
   * Override `--app-data-dir` for profile isolation.
   * Note: `agy` joins this path beneath `--gemini-dir` even when given an absolute path.
   */
  appDataDir?: string;
  /** Override `--gemini-dir`. */
  geminiDir?: string;
  /** Named agent passed via `--agent`. */
  agent?: string;
}

export interface GeminiCliAcpLaunchOptions extends SharedLaunchOptions {
  /** Pass `--skip-trust` to trust the workspace non-interactively. */
  skipTrust?: boolean;
}

/** Build an `AcpSessionConfig` for Antigravity CLI (`agy acp --stdio`). */
export function agyAcpLaunch(opts: AgyAcpLaunchOptions = {}): AcpSessionConfig {
  const {
    bin = 'agy',
    billing = 'subscription',
    addDirs,
    sandbox,
    appDataDir,
    geminiDir,
    agent,
    permissionMode,
    env,
    ...rest
  } = opts;
  const command: string[] = [bin, 'acp', '--stdio'];
  if (permissionMode === 'bypassPermissions') command.push('--dangerously-skip-permissions');
  if (sandbox) command.push('--sandbox');
  if (appDataDir) command.push('--app-data-dir', appDataDir);
  if (geminiDir) command.push('--gemini-dir', geminiDir);
  if (agent) command.push('--agent', agent);
  for (const dir of addDirs ?? []) command.push('--add-dir', dir);
  return {
    ...rest,
    command,
    // Prevent `agy` from self-updating in place mid-session, and drop inherited Electron Crashpad pipes.
    env: { AGY_CLI_DISABLE_AUTO_UPDATE: '1', CHROME_CRASHPAD_PIPE_NAME: undefined, ...env },
    ...(permissionMode ? { permissionMode } : {}),
    ...(billing === 'subscription' ? { stripEnv: AGY_COMPETING_ENV } : {}),
  };
}

function geminiApprovalMode(mode: HostPermissionMode): 'default' | 'auto_edit' | 'plan' | 'yolo' {
  switch (mode) {
    case 'default':
      return 'default';
    case 'acceptEdits':
      return 'auto_edit';
    case 'plan':
      return 'plan';
    case 'bypassPermissions':
      return 'yolo';
  }
}

/** Build an `AcpSessionConfig` for Gemini CLI (`gemini --acp`). */
export function geminiCliAcpLaunch(opts: GeminiCliAcpLaunchOptions = {}): AcpSessionConfig {
  const {
    bin = 'gemini',
    billing = 'subscription',
    addDirs,
    sandbox,
    skipTrust,
    permissionMode,
    model,
    ...rest
  } = opts;
  const command: string[] = [bin, '--acp'];
  if (permissionMode) command.push('--approval-mode', geminiApprovalMode(permissionMode));
  if (model) command.push('--model', model);
  if (sandbox) command.push('--sandbox');
  if (skipTrust) command.push('--skip-trust');
  for (const dir of addDirs ?? []) command.push('--include-directories', dir);
  return {
    ...rest,
    command,
    ...(permissionMode ? { permissionMode } : {}),
    ...(model ? { model } : {}),
    ...(billing === 'subscription' ? { stripEnv: GEMINI_CLI_COMPETING_ENV } : {}),
  };
}

interface QueuedTurn {
  onAdmission?: SessionSendOptions['onAdmission'];
  evidence: TurnState;
  message: string;
  images: readonly SessionImage[];
  timeout: number;
  cancelling?: boolean;
  resolve: (result: SessionResult) => void;
  reject: (error: Error) => void;
}

interface TrackedToolCall {
  toolName: string;
  started: boolean;
  completed: boolean;
}

interface PendingApproval {
  readonly id: string | number;
  readonly controller: AbortController;
  responded: boolean;
}

interface AcpPermissionOption {
  readonly optionId: string;
  readonly name: string;
  readonly kind: string;
}

const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const str = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined;

const nonNegInt = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

export class AcpSession implements HarnessSession {
  get transport() {
    return TRANSPORTS.acp;
  }
  readonly admissionProtocol = 'prewrite-v1' as const;

  // -- Config --
  private readonly _command: readonly string[];
  private readonly _cwd: string;
  private readonly _env?: Record<string, string | undefined>;
  private readonly _stripEnv: readonly (string | RegExp)[];
  private readonly _defaultTimeout: number;
  private readonly _startupTimeout: number;
  private readonly _model?: string;
  private readonly _effort?: string;
  private readonly _permissionMode: HostPermissionMode;
  private readonly _baseContext?: string;
  private readonly _resumeMethod: 'resume' | 'load';
  private readonly _mcpServers: readonly AcpMcpServer[];
  private readonly _onSessionReady?: (sessionId: string) => void | Promise<void>;
  private readonly _spawn?: AcpSpawn;

  // -- Transport --
  private _proc: PipedSubprocess | null = null;
  private _rpc: JsonRpcConnection | null = null;
  private _exitPromise: Promise<void> | null = null;
  private _capabilities?: AcpServerCapabilities;
  private _configOptions: AcpConfigOption[] = [];
  private _currentModeId?: string;
  private _startedOnce = false;
  private _closing = false;
  private _loadingSession = false;

  // -- Session state --
  private _externalSessionId?: string;
  private _alive = false;
  private _startEmitted = false;
  private _endEmitted = false;
  private _eventLog: SessionEvent[] = [];
  private _handlers: SessionEventHandler[] = [];
  private _observerFailures = { synchronous: 0, asynchronous: 0 };
  private _beforeSendHooks: BeforeSendHook[] = [];
  private _turns = 0;
  private _totalTokens = { input: 0, output: 0 };
  private _startedAt = Date.now();
  private _injectedBaseContext = false;

  // -- Turns --
  private _queue: QueuedTurn[] = [];
  private _attempts: TurnState[] = [];
  private _inflight: QueuedTurn | null = null;
  private _turnTimer: ReturnType<typeof setTimeout> | null = null;
  private _turnToolCalls = new Map<string, TrackedToolCall>();
  private _turnUsage?: SessionTokens;

  // -- Tool gates --
  private _gates = new ToolGates();
  private _approvals = new Map<string | number, PendingApproval>();

  constructor(config: AcpSessionConfig) {
    const firstArg = config?.command?.[0];
    if (!config?.command?.length || !str(firstArg) || firstArg.includes('\0'))
      throw new Error('AcpSession requires a non-empty command');
    this._command = [...config.command];
    this._cwd = resolve(config.cwd ?? process.cwd());
    this._env = config.env;
    this._stripEnv = config.stripEnv ? [...config.stripEnv] : [];
    this._defaultTimeout = config.timeout ?? DEFAULT_TURN_TIMEOUT_MS;
    this._startupTimeout = config.startupTimeout ?? DEFAULT_STARTUP_TIMEOUT_MS;
    this._model = config.model;
    this._effort = config.effort;
    this._permissionMode = config.permissionMode ?? 'default';
    this._baseContext = config.baseContext;
    this._externalSessionId = config.externalSessionId;
    this._resumeMethod = config.resumeMethod ?? 'resume';
    this._mcpServers = config.mcpServers ? [...config.mcpServers] : [];
    this._onSessionReady = config.onSessionReady;
    this._spawn = config.spawn;
  }

  // ---------------------------------------------------------------------------
  // Accessors
  // ---------------------------------------------------------------------------

  get accounting() {
    return 'observed-only' as const;
  }
  get attempts(): readonly SessionAttempt[] {
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
  /** Server capabilities negotiated during `start()`; `undefined` before `start()`. */
  get serverCapabilities(): AcpServerCapabilities | undefined {
    return this._capabilities;
  }
  /** Latest config options advertised by the ACP agent. */
  get configOptions(): readonly AcpConfigOption[] {
    return Object.freeze([...this._configOptions]);
  }
  /** Current mode id advertised by the ACP agent, if any. */
  get currentModeId(): string | undefined {
    return this._currentModeId;
  }

  inspectAttempt(admissionId: string): SessionAttempt | undefined {
    return this._attempts.find((attempt) => attempt.admissionId === admissionId)?.snapshot();
  }

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

  /** Needs a gated mode; under `bypassPermissions` permission requests auto-approve without gates. */
  onToolRequest(gate: ToolGate): () => void {
    if (this._permissionMode === 'bypassPermissions')
      throw new Error(
        'Tool gates need a gated ACP session; under bypassPermissions permissions auto-approve without reaching gates',
      );
    return this._gates.add(gate);
  }

  fork(): HarnessSession {
    throw new Error('ACP session fork is not implemented');
  }

  async push(payload: { kind: string; text: string }): Promise<PushOutcome> {
    const reason = 'ACP transport does not support mid-turn steering';
    this._emit({
      kind: 'error',
      timestamp: Date.now(),
      text: `push_ignored: kind=${payload.kind} — ${reason}`,
      raw: { kind: payload.kind },
    });
    return { outcome: 'ignored', reason };
  }

  // ---------------------------------------------------------------------------
  // Lifecycle: start / interrupt / interruptNative / kill / close / artifact
  // ---------------------------------------------------------------------------

  async start(): Promise<void> {
    if (this._inflight)
      throw new Error('Native call ownership unresolved; automatic resume is blocked');
    if (this._rpc) throw new Error('Session already started');
    if (this._startedOnce && !this._alive)
      throw new Error('ACP session restart requires a new owned instance');
    this._startedOnce = true;
    this._closing = false;

    let failStartupAuth: ((err: Error) => void) | null = null;
    const startupAuthFailed = new Promise<never>((_, reject) => {
      failStartupAuth = reject;
    });
    // Prevent unhandled rejections if an auth line arrives after startup already settled.
    void startupAuthFailed.catch(() => {});
    const onAuthPromptLine = (line: string) => {
      if (!line.startsWith(ANTIGRAVITY_AUTH_URL_PREFIX)) return;
      failStartupAuth?.(
        new Error(
          'ACP agent sign-in required; authenticate the CLI (e.g. `agy acp --login`) and retry.',
        ),
      );
    };

    const env = this._childEnv();
    const proc = this._spawn
      ? this._spawn(this._command, { cwd: this._cwd, env })
      : (Bun.spawn([...this._command], {
          cwd: this._cwd,
          env,
          stdin: 'pipe',
          stdout: 'pipe',
          stderr: 'pipe',
        }) as unknown as PipedSubprocess);
    this._proc = proc;
    const rpc = new JsonRpcConnection(proc, {
      onNotification: (method, params) => this._onNotification(method, params),
      onRequest: (id, method, params) => this._onRequest(id, method, params),
      onNonJsonLine: onAuthPromptLine,
      onStderrLine: onAuthPromptLine,
      onClose: (error) => {
        if (this._rpc !== rpc || this._closing) return;
        this._transportFailure(error);
      },
    });
    this._rpc = rpc;

    const startupRpc = <T>(call: Promise<T>): Promise<T> => Promise.race([call, startupAuthFailed]);

    try {
      const initRaw = await startupRpc(
        rpc.request(
          'initialize',
          {
            protocolVersion: ACP_PROTOCOL_VERSION,
            clientInfo: CLIENT_INFO,
            clientCapabilities: {},
          },
          this._startupTimeout,
        ),
      );
      this._capabilities = parseCapabilities(initRaw);

      const mcpServers = filterMcpServers(this._mcpServers, this._capabilities.mcpCapabilities);
      const nativeSystemPrompt =
        this._baseContext && this._capabilities.systemPromptAppend ? this._baseContext : undefined;
      const sessionMetaParam = nativeSystemPrompt
        ? { _meta: { antigravity: { systemPrompt: { append: nativeSystemPrompt } } } }
        : {};
      let sessionMeta: Record<string, unknown> | undefined;

      if (this._externalSessionId) {
        const binding = this._externalSessionId;
        const canResume = this._capabilities.sessionCapabilities.resume;
        const canLoad = this._capabilities.loadSession;
        const runResume = async () =>
          object(
            await startupRpc(
              rpc.request(
                'session/resume',
                { sessionId: binding, cwd: this._cwd, mcpServers, ...sessionMetaParam },
                this._startupTimeout,
              ),
            ),
          );
        const runLoad = async () => {
          this._loadingSession = true;
          try {
            return object(
              await startupRpc(
                rpc.request(
                  'session/load',
                  { sessionId: binding, cwd: this._cwd, mcpServers, ...sessionMetaParam },
                  this._startupTimeout,
                ),
              ),
            );
          } finally {
            this._loadingSession = false;
          }
        };

        try {
          if (this._resumeMethod === 'resume' && canResume) {
            try {
              sessionMeta = await runResume();
            } catch (error) {
              if (error instanceof JsonRpcError && error.code === -32601 && canLoad)
                sessionMeta = await runLoad();
              else throw error;
            }
          } else if (canLoad) {
            sessionMeta = await runLoad();
          } else if (canResume) {
            sessionMeta = await runResume();
          } else {
            throw new NativeBindingMissingError(
              'acp',
              binding,
              'ACP agent does not advertise session/load or session/resume capability',
              this._cwd,
            );
          }
        } catch (error) {
          if (isMissingSessionError(error))
            throw new NativeBindingMissingError(
              'acp',
              binding,
              error instanceof Error ? error.message : String(error),
              this._cwd,
            );
          throw error;
        }
      } else {
        sessionMeta = object(
          await startupRpc(
            rpc.request(
              'session/new',
              { cwd: this._cwd, mcpServers, ...sessionMetaParam },
              this._startupTimeout,
            ),
          ),
        );
        const sessionId = str(sessionMeta?.sessionId);
        if (!sessionId) throw new Error('ACP session/new did not return a sessionId');
        this._externalSessionId = sessionId;
      }

      if (nativeSystemPrompt) this._injectedBaseContext = true;

      this._applySessionState(sessionMeta);
      await startupRpc(this._applyInitialMode(rpc, this._externalSessionId, sessionMeta));
      await startupRpc(this._applyInitialModelAndEffort(rpc, this._externalSessionId, sessionMeta));

      if (this._onSessionReady) await this._onSessionReady(this._externalSessionId);

      failStartupAuth = null;
      this._alive = true;
      this._startEmitted = true;
      this._endEmitted = false;
      this._emit({
        kind: 'session_start',
        timestamp: Date.now(),
        externalSessionId: this._externalSessionId,
        nativeSessionId: this._externalSessionId,
        raw: {
          type: 'acp-ready',
          agentInfo: this._capabilities.agentInfo,
          capabilities: this._capabilities,
          permissionMode: this._permissionMode,
        },
      });
    } catch (error) {
      failStartupAuth = null;
      await this._beginClose(500);
      if (isStartupSignInError(error))
        throw new Error(
          `ACP agent sign-in required: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      throw error;
    }
  }

  interrupt(): void {
    if (!this._inflight) return;
    this._rejectInflight(
      new Error('Local waiter interrupted; native cancellation unacknowledged'),
      'interrupt-request',
    );
  }

  /** Send ACP `session/cancel` for the active session and wait (bounded) for `session/prompt` to settle. */
  async interruptNative(opts?: { timeoutMs?: number }): Promise<NativeInterruptOutcome> {
    const turn = this._inflight;
    const a = turn?.evidence;
    if (
      !turn ||
      a?.dispatch !== 'attempted' ||
      a.nativeOutcome !== 'unknown' ||
      !this._externalSessionId ||
      !this._rpc ||
      !this._alive
    )
      return 'no-turn';

    turn.cancelling = true;
    const deadline = Date.now() + (opts?.timeoutMs ?? 5_000);
    try {
      this._rpc.notify('session/cancel', { sessionId: this._externalSessionId });
    } catch {
      return 'unacknowledged';
    }
    this._cancelPendingApprovals(true);

    while (a.nativeOutcome === 'unknown' && this._alive && Date.now() < deadline)
      await Bun.sleep(10);
    return a.nativeOutcome === 'unknown' ? 'unacknowledged' : 'acknowledged';
  }

  kill(): void {
    void this._beginClose(DEFAULT_CLOSE_GRACE_MS);
  }

  /** Tear down the child process cleanly (best-effort session/close when idle, then SIGTERM -> SIGKILL grace). */
  async close(opts?: { graceMs?: number }): Promise<void> {
    await this._beginClose(opts?.graceMs ?? DEFAULT_CLOSE_GRACE_MS, true);
  }

  private _beginClose(graceMs: number, sendSessionClose = false): Promise<void> {
    if (this._exitPromise) return this._exitPromise;
    if (!this._rpc || !this._proc) return Promise.resolve();
    const rpcForClose =
      sendSessionClose &&
      this._alive &&
      !this._closing &&
      !this._inflight &&
      this._capabilities?.sessionCapabilities.close &&
      this._externalSessionId &&
      this._rpc &&
      !this._rpc.closed
        ? { rpc: this._rpc, sessionId: this._externalSessionId }
        : null;
    // Flip closing/alive synchronously before any await so concurrent sends refuse, concurrent
    // closes coalesce, and a child exiting on `session/close` never fires `_transportFailure()`.
    if (rpcForClose) {
      this._closing = true;
      this._alive = false;
    }
    const done = (async () => {
      if (rpcForClose) {
        await rpcForClose.rpc
          .request(
            'session/close',
            { sessionId: rpcForClose.sessionId },
            Math.min(500, Math.max(50, graceMs)),
          )
          .catch(() => {});
      }
      const teardown = this._teardown();
      if (!teardown) return;
      const { proc, rpc } = teardown;
      rpc.kill();
      const exited = proc.exited.then(
        () => true as const,
        () => true as const,
      );
      let timer: ReturnType<typeof setTimeout> | undefined;
      const settled = await Promise.race([
        exited,
        new Promise<false>((resolve) => {
          timer = setTimeout(() => resolve(false), graceMs);
          timer.unref?.();
        }),
      ]);
      if (timer) clearTimeout(timer);
      if (!settled) {
        forceKill(proc);
        let killTimer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([
          exited,
          new Promise<void>((resolve) => {
            killTimer = setTimeout(resolve, 1_000);
            killTimer.unref?.();
          }),
        ]);
        if (killTimer) clearTimeout(killTimer);
      }
    })();
    this._exitPromise = done;
    return done;
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
  // send() — prewrite-v1 turn admission and ACP `session/prompt`
  // ---------------------------------------------------------------------------

  async send(message: string, opts?: SessionSendOptions): Promise<SessionResult> {
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
    if (!this._rpc || !this._externalSessionId)
      throw new Error('Session not started — call start() first');
    if (!this._alive) throw new Error('Session ended');

    const timeout = opts?.timeout ?? this._defaultTimeout;
    const images = sendableImages(this.transport, opts?.images);
    if (images.length > 0 && !this._capabilities?.promptCapabilities.image)
      throw new Error('ACP agent does not advertise image prompt capability');

    let transformed = message;
    for (const hook of this._beforeSendHooks) transformed = await hook(transformed);

    return new Promise<SessionResult>((resolve, reject) => {
      const evidence = new TurnState();
      evidence.identity = {
        nativeSessionId: this._externalSessionId,
        correlation: 'ordered-stream',
      };
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
      if (!this._inflight) this._dispatchTurn(turn);
      else this._queue.push(turn);
    });
  }

  private _dispatchTurn(turn: QueuedTurn): void {
    this._inflight = turn;
    const onAdmission = turn.onAdmission;
    if (!onAdmission) {
      this._writeTurn(turn);
      return;
    }
    Promise.resolve()
      .then(() => onAdmission(turn.evidence.snapshot()))
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
  }

  private _writeTurn(turn: QueuedTurn): void {
    const rpc = this._rpc;
    const sessionId = this._externalSessionId;
    if (!rpc || !sessionId || !this._alive) {
      this._rejectInflight(new Error('Session ended before turn dispatch'), 'transport');
      return;
    }
    const a = turn.evidence;
    a.dispatch = 'attempted';
    a.rpcOutcome = 'pending';
    this._turnToolCalls.clear();
    this._turnUsage = undefined;

    let text = turn.message;
    if (this._baseContext && !this._injectedBaseContext) {
      text = `${this._baseContext}\n\n${text}`;
      this._injectedBaseContext = true;
    }

    const prompt: Array<Record<string, unknown>> = [
      { type: 'text', text },
      ...turn.images.map((image) => ({
        type: 'image',
        mimeType: image.mediaType,
        data: image.data,
      })),
    ];

    if (turn.timeout > 0) {
      this._turnTimer = setTimeout(() => {
        this._turnTimer = null;
        this._rejectInflight(new Error(`Turn timed out after ${turn.timeout}ms`), 'timeout');
      }, turn.timeout);
    }

    rpc
      .request('session/prompt', { sessionId, prompt })
      .then((raw) => {
        this._finishTurnResponse(turn, raw);
      })
      .catch((error: unknown) => {
        this._failTurnResponse(turn, error instanceof Error ? error : new Error(String(error)));
      });
  }

  private _finishTurnResponse(turn: QueuedTurn, raw: unknown): void {
    const a = turn.evidence;
    const response = object(raw) ?? {};
    const stopReason = str(response.stopReason);
    // Strict allowlist matching Claude/Codex/Muse: only explicit `end_turn` is a completed turn.
    const nativeOutcome = stopReason === 'end_turn' ? 'completed' : 'failed';
    const terminal = { type: 'session/prompt', subtype: stopReason ?? 'missing' } as const;
    const tokens = acpTokens(response.usage) ?? this._turnUsage;

    a.rpcOutcome = 'resolved';
    a.nativeOutcome = nativeOutcome;
    a.terminal = terminal;

    const resultEvent = a.record({
      kind: 'result',
      timestamp: Date.now(),
      text: a.content,
      nativeOutcome,
      terminal,
      ...(tokens ? { tokens } : {}),
      raw: response,
    });
    this._emit(resultEvent);

    if (a.tokens) {
      this._totalTokens.input += a.tokens.input;
      this._totalTokens.output += a.tokens.output;
    }

    if (this._inflight === turn) {
      this._clearTimer();
      this._cancelPendingApprovals(false);
      if (a.localOutcome === 'pending') {
        a.localOutcome = 'resolved';
        turn.resolve(a.result(this._externalSessionId));
      }
      this._turns++;
      this._inflight = null;
      this._processNextTurn();
    }
  }

  private _failTurnResponse(turn: QueuedTurn, error: Error): void {
    const a = turn.evidence;
    if (error instanceof JsonRpcError) {
      a.rpcOutcome = 'failed';
      a.nativeOutcome = 'failed';
      a.terminal = { type: 'session/prompt', subtype: 'rpc_error', reason: error.message };
      const errEvent = a.record({
        kind: 'error',
        timestamp: Date.now(),
        text: error.message,
        nativeOutcome: 'failed',
        terminal: a.terminal,
        raw: { code: error.code, message: error.message },
      });
      this._emit(errEvent);

      const surfaced = isMissingModelError(error)
        ? new NativeModelMissingError('acp', this._model ?? 'unknown', error.message)
        : error;

      if (this._inflight === turn) {
        this._clearTimer();
        this._cancelPendingApprovals(false);
        if (a.localOutcome === 'pending') turn.reject(a.fail(surfaced, 'rpc'));
        this._inflight = null;
        this._processNextTurn();
      }
      return;
    }

    // Transport / close error (e.g. child crashed mid-turn).
    if (a.rpcOutcome === 'pending') a.rpcOutcome = 'unknown';
    if (this._inflight === turn) {
      this._cancelPendingApprovals(false);
      this._rejectInflight(error, 'transport');
    } else if (a.localOutcome === 'pending') {
      turn.reject(a.fail(error, 'transport'));
    }
  }

  private _processNextTurn(): void {
    if (!this._inflight && this._alive) {
      const next = this._queue.shift();
      if (next) this._dispatchTurn(next);
    }
  }

  private _clearTimer(): void {
    if (this._turnTimer) {
      clearTimeout(this._turnTimer);
      this._turnTimer = null;
    }
  }

  private _rejectInflight(err: Error, reason: SessionAttempt['localFailure'] = 'transport'): void {
    if (!this._inflight) return;
    this._clearTimer();
    const a = this._inflight.evidence;
    if ((reason === 'transport' || reason === 'killed') && a.transportOutcome === 'open')
      a.transportOutcome = reason === 'killed' ? 'closed' : 'failed';
    if (a.localOutcome === 'pending') this._inflight.reject(a.fail(err, reason));
    this._rejectQueue(new Error('Previous native work unresolved; queued send not dispatched'));
  }

  private _rejectQueue(err: Error): void {
    for (const turn of this._queue) turn.reject(turn.evidence.fail(err, 'blocked'));
    this._queue = [];
  }

  private _transportFailure(err: Error): void {
    this._alive = false;
    this._cancelPendingApprovals(false);
    this._rejectInflight(err, 'transport');
    this._rejectQueue(err);
    if (this._startEmitted)
      this._emit({ kind: 'session_end', timestamp: Date.now(), transportOutcome: 'failed' });
  }

  private _teardown(): { proc: PipedSubprocess; rpc: JsonRpcConnection } | null {
    const proc = this._proc;
    const rpc = this._rpc;
    if (!rpc || !proc) return null;
    this._closing = true;
    this._alive = false;
    this._clearTimer();
    this._cancelPendingApprovals(false);
    this._rejectInflight(new Error('Session closed; native outcome may remain unknown'), 'killed');
    this._rejectQueue(new Error('Session closed'));
    this._proc = null;
    this._rpc = null;
    if (this._startEmitted) this._emit({ kind: 'session_end', timestamp: Date.now() });
    return { proc, rpc };
  }

  // ---------------------------------------------------------------------------
  // Startup helpers: env, capabilities, model/effort
  // ---------------------------------------------------------------------------

  private _childEnv(): Record<string, string | undefined> {
    const merged: Record<string, string | undefined> = { ...process.env, ...this._env };
    const env: Record<string, string | undefined> = {};
    for (const [key, value] of Object.entries(merged)) {
      if (value === undefined) continue;
      if (this._shouldStripEnv(key)) continue;
      env[key] = value;
    }
    return env;
  }

  private _shouldStripEnv(key: string): boolean {
    for (const rule of this._stripEnv) {
      if (typeof rule === 'string' ? rule === key : rule.test(key)) return true;
    }
    return false;
  }

  private _applySessionState(meta: Record<string, unknown> | undefined): void {
    if (!meta) return;
    const modes = object(meta.modes);
    const currentModeId = str(modes?.currentModeId);
    if (currentModeId) this._currentModeId = currentModeId;
    if (Array.isArray(meta.configOptions))
      this._configOptions = parseConfigOptions(meta.configOptions);
    if (!this._currentModeId) {
      const modeOpt = this._configOptions.find(
        (opt) => (opt.category === 'mode' || opt.id === 'mode') && opt.type === 'select',
      );
      if (typeof modeOpt?.currentValue === 'string' && modeOpt.currentValue)
        this._currentModeId = modeOpt.currentValue;
    }
  }

  private _emitConfigStatus(sessionId: string, raw: Record<string, unknown>): void {
    this._emit({
      kind: 'native_status',
      timestamp: Date.now(),
      nativeSessionId: sessionId,
      correlation: 'unknown',
      unattributedReason: 'session-configuration',
      raw,
    });
  }

  private async _applyInitialMode(
    rpc: JsonRpcConnection,
    sessionId: string,
    sessionMeta: Record<string, unknown> | undefined,
  ): Promise<void> {
    const candidates = MODE_CANDIDATES[this._permissionMode];
    const modeOpt = this._configOptions.find(
      (opt) => (opt.category === 'mode' || opt.id === 'mode') && opt.type === 'select',
    );
    const modeChoices = modeOpt?.options;
    if (modeOpt && modeChoices?.length) {
      const target = candidates.find((candidate) =>
        modeChoices.some((choice) => choice.value === candidate),
      );
      if (target && modeOpt.currentValue !== target) {
        try {
          const updated = object(
            await rpc.request(
              'session/set_config_option',
              { sessionId, configId: modeOpt.id, value: target },
              this._startupTimeout,
            ),
          );
          if (Array.isArray(updated?.configOptions))
            this._configOptions = parseConfigOptions(updated.configOptions);
          this._currentModeId = target;
        } catch (error) {
          if (error instanceof JsonRpcError && (error.code === -32601 || error.code === -32602)) {
            this._emitConfigStatus(sessionId, { type: 'mode-switch-unsupported', mode: target });
          } else {
            throw error;
          }
        }
      }
      return;
    }

    const modes = object(sessionMeta?.modes);
    const available = Array.isArray(modes?.availableModes)
      ? modes.availableModes
          .map((entry) => str(object(entry)?.id))
          .filter((id): id is string => !!id)
      : [];
    if (!available.length) return;
    const target = candidates.find((candidate) => available.includes(candidate));
    if (!target || this._currentModeId === target) return;
    try {
      await rpc.request('session/set_mode', { sessionId, modeId: target }, this._startupTimeout);
      this._currentModeId = target;
    } catch (error) {
      if (error instanceof JsonRpcError && (error.code === -32601 || error.code === -32602)) {
        this._emitConfigStatus(sessionId, { type: 'mode-switch-unsupported', mode: target });
      } else {
        throw error;
      }
    }
  }

  private async _applyInitialModelAndEffort(
    rpc: JsonRpcConnection,
    sessionId: string,
    sessionMeta: Record<string, unknown> | undefined,
  ): Promise<void> {
    if (this._model) {
      const modelOpt = this._configOptions.find(
        (opt) => opt.category === 'model' || opt.id === 'model',
      );
      if (modelOpt) {
        if (modelOpt.currentValue !== this._model) {
          try {
            const updated = object(
              await rpc.request(
                'session/set_config_option',
                { sessionId, configId: modelOpt.id, value: this._model },
                this._startupTimeout,
              ),
            );
            if (Array.isArray(updated?.configOptions))
              this._configOptions = parseConfigOptions(updated.configOptions);
          } catch (error) {
            if (isMissingModelError(error, true))
              throw new NativeModelMissingError('acp', this._model, (error as Error).message);
            throw error;
          }
        }
      } else {
        const models = object(sessionMeta?.models);
        const currentModelId = str(models?.currentModelId);
        if (currentModelId !== this._model) {
          try {
            await rpc.request(
              'session/set_model',
              { sessionId, modelId: this._model },
              this._startupTimeout,
            );
          } catch (error) {
            if (error instanceof JsonRpcError && error.code === -32601) {
              // Agent does not support runtime model switching via session/set_model.
              this._emitConfigStatus(sessionId, {
                type: 'model-switch-unsupported',
                model: this._model,
              });
            } else if (isMissingModelError(error, true)) {
              throw new NativeModelMissingError('acp', this._model, (error as Error).message);
            } else {
              throw error;
            }
          }
        }
      }
    }

    if (this._effort) {
      const effortOpt = this._configOptions.find(
        (opt) =>
          opt.type === 'select' &&
          (opt.category === 'thought_level' ||
            opt.category === 'thinking' ||
            opt.id === 'effort' ||
            opt.id === 'thought_level' ||
            opt.id === 'reasoning_effort'),
      );
      if (effortOpt && effortOpt.currentValue !== this._effort) {
        const unsupportedChoice =
          effortOpt.options?.length &&
          !effortOpt.options.some((choice) => choice.value === this._effort);
        if (unsupportedChoice) {
          this._emitConfigStatus(sessionId, { type: 'effort-unsupported', effort: this._effort });
          return;
        }
        try {
          const updated = object(
            await rpc.request(
              'session/set_config_option',
              { sessionId, configId: effortOpt.id, value: this._effort },
              this._startupTimeout,
            ),
          );
          if (Array.isArray(updated?.configOptions))
            this._configOptions = parseConfigOptions(updated.configOptions);
        } catch (error) {
          if (error instanceof JsonRpcError && (error.code === -32601 || error.code === -32602)) {
            this._emitConfigStatus(sessionId, { type: 'effort-unsupported', effort: this._effort });
          } else {
            throw error;
          }
        }
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Inbound JSON-RPC notifications (`session/update`)
  // ---------------------------------------------------------------------------

  private _onNotification(method: string, params: Record<string, unknown> | undefined): void {
    if (method !== 'session/update' || !params) return;
    const sessionId = str(params.sessionId);
    const update = object(params.update);
    if (!update) return;
    const now = Date.now();

    if (this._externalSessionId && sessionId && sessionId !== this._externalSessionId) {
      this._emit({
        kind: 'native_status',
        timestamp: now,
        nativeSessionId: sessionId,
        correlation: 'unknown',
        unattributedReason: 'foreign-session',
        raw: update,
      });
      return;
    }

    if (this._loadingSession) {
      this._emit({
        kind: 'native_status',
        timestamp: now,
        nativeSessionId: sessionId ?? this._externalSessionId,
        correlation: 'unknown',
        unattributedReason: 'session-configuration',
        raw: update,
      });
      return;
    }

    const updateKind = str(update.sessionUpdate);
    if (updateKind === 'current_mode_update') {
      const modeId = str(update.currentModeId);
      if (modeId) this._currentModeId = modeId;
      this._emit({
        kind: 'native_status',
        timestamp: now,
        nativeSessionId: this._externalSessionId,
        correlation: 'unknown',
        unattributedReason: 'session-configuration',
        raw: update,
      });
      return;
    }
    if (updateKind === 'config_option_update') {
      if (Array.isArray(update.configOptions))
        this._configOptions = parseConfigOptions(update.configOptions);
      this._emit({
        kind: 'native_status',
        timestamp: now,
        nativeSessionId: this._externalSessionId,
        correlation: 'unknown',
        unattributedReason: 'session-configuration',
        raw: update,
      });
      return;
    }

    const a = this._inflight?.evidence;
    if (a?.dispatch !== 'attempted') {
      this._emit({
        kind: 'native_status',
        timestamp: now,
        nativeSessionId: this._externalSessionId,
        correlation: 'unknown',
        unattributedReason: 'no-admission',
        raw: update,
      });
      return;
    }
    if (a.nativeOutcome !== 'unknown') {
      this._emit({
        kind: 'native_status',
        timestamp: now,
        nativeSessionId: this._externalSessionId,
        correlation: 'unknown',
        unattributedReason: 'after-terminal',
        raw: update,
      });
      return;
    }

    for (const event of this._classifyUpdate(update, now)) {
      const recorded = a.record(event);
      this._emit(recorded);
    }
  }

  private _classifyUpdate(update: Record<string, unknown>, now: number): SessionEvent[] {
    const kind = str(update.sessionUpdate);
    switch (kind) {
      case 'agent_message_chunk': {
        const content = object(update.content);
        if (content?.type === 'text' && typeof content.text === 'string')
          return [{ kind: 'text_delta', timestamp: now, text: content.text, raw: update }];
        return [{ kind: 'native_status', timestamp: now, raw: update }];
      }
      case 'agent_thought_chunk': {
        const content = object(update.content);
        if (content?.type === 'text' && typeof content.text === 'string')
          return [{ kind: 'thinking', timestamp: now, text: content.text, raw: update }];
        return [{ kind: 'native_status', timestamp: now, raw: update }];
      }
      case 'tool_call':
      case 'tool_call_update':
        return this._classifyToolUpdate(kind, update, now);
      case 'usage_update': {
        const tokens = acpTokens(update.usage) ?? acpTokens(update);
        if (tokens) {
          this._turnUsage = tokens;
          return [{ kind: 'usage', timestamp: now, tokens, raw: update }];
        }
        const used = nonNegInt(update.used);
        if (used !== undefined)
          return [
            {
              kind: 'usage',
              timestamp: now,
              tokens: { input: used, output: 0, providerUsage: update },
              raw: update,
            },
          ];
        return [{ kind: 'native_status', timestamp: now, raw: update }];
      }
      case 'compaction_update':
        if (update.status === 'completed')
          return [
            { kind: 'session_compact', timestamp: now, compactionSource: 'acp', raw: update },
          ];
        return [{ kind: 'native_status', timestamp: now, raw: update }];
      default:
        return [{ kind: 'native_status', timestamp: now, raw: update }];
    }
  }

  private _classifyToolUpdate(
    kind: 'tool_call' | 'tool_call_update',
    update: Record<string, unknown>,
    now: number,
  ): SessionEvent[] {
    const callId = str(update.toolCallId);
    const prev = callId ? this._turnToolCalls.get(callId) : undefined;
    const toolName = resolveAcpToolName(update, prev?.toolName);
    const tracked: TrackedToolCall = prev ?? { toolName, started: false, completed: false };
    tracked.toolName = toolName;
    if (callId) this._turnToolCalls.set(callId, tracked);

    const out: SessionEvent[] = [];
    const status = str(update.status);
    const terminalStatus = status === 'completed' || status === 'failed';

    if (!tracked.started && (kind === 'tool_call' || terminalStatus)) {
      tracked.started = true;
      const toolInput = object(update.rawInput);
      out.push({
        kind: 'tool_use',
        timestamp: now,
        ...(callId ? { callId } : {}),
        toolName,
        ...mcpToolParts(toolName),
        ...(toolInput ? { toolInput } : {}),
        raw: update,
      });
    }

    if (terminalStatus && !tracked.completed) {
      tracked.completed = true;
      const toolOutput = extractToolOutput(update);
      out.push({
        kind: 'tool_result',
        timestamp: now,
        ...(callId ? { callId } : {}),
        toolName,
        ...mcpToolParts(toolName),
        ...(toolOutput !== undefined ? { toolOutput } : { toolOutputOmitted: true }),
        toolError: status === 'failed',
        raw: update,
      });
    }

    if (!out.length) {
      out.push({
        kind: 'native_status',
        timestamp: now,
        ...(callId ? { callId } : {}),
        raw: update,
      });
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // Inbound JSON-RPC requests (`session/request_permission`)
  // ---------------------------------------------------------------------------

  private _onRequest(
    id: string | number,
    method: string,
    params: Record<string, unknown> | undefined,
  ): boolean {
    if (method !== 'session/request_permission') return false;
    void this._handlePermissionRequest(id, params);
    return true;
  }

  private async _handlePermissionRequest(
    id: string | number,
    params: Record<string, unknown> | undefined,
  ): Promise<void> {
    const rpc = this._rpc;
    if (!rpc || rpc.closed) return;

    const sessionId = str(params?.sessionId);
    const toolCall = object(params?.toolCall);
    const callId = str(toolCall?.toolCallId);
    const prevName = callId ? this._turnToolCalls.get(callId)?.toolName : undefined;
    const toolName = resolveAcpToolName(toolCall, prevName);
    const rawInput = object(toolCall?.rawInput) ?? {};
    const options = parsePermissionOptions(params?.options);
    const allowOption =
      options.find((opt) => opt.kind === 'allow_once') ??
      options.find((opt) => opt.kind === 'allow_always');
    const rejectOption =
      options.find((opt) => opt.kind === 'reject_once') ??
      options.find((opt) => opt.kind === 'reject_always');

    if (sessionId && this._externalSessionId && sessionId !== this._externalSessionId) {
      this._emit({
        kind: 'native_status',
        timestamp: Date.now(),
        nativeSessionId: sessionId,
        correlation: 'unknown',
        unattributedReason: 'foreign-session',
        ...(callId ? { callId } : {}),
        raw: {
          type: 'approval-response',
          toolName,
          decision: 'cancelled',
          reason: 'foreign-session',
        },
      });
      rpc.respond(id, { outcome: { outcome: 'cancelled' } });
      return;
    }

    const turn = this._inflight;
    const a = turn?.evidence;
    if (
      this._loadingSession ||
      !turn ||
      !a ||
      a.dispatch !== 'attempted' ||
      a.nativeOutcome !== 'unknown' ||
      turn.cancelling
    ) {
      const unattributedReason = this._loadingSession
        ? ('session-configuration' as const)
        : a && a.nativeOutcome !== 'unknown'
          ? ('after-terminal' as const)
          : ('no-admission' as const);
      this._emit({
        ...(turn?.cancelling && a
          ? { ...a.identity, admissionId: a.admissionId }
          : {
              nativeSessionId: sessionId ?? this._externalSessionId,
              correlation: 'unknown' as const,
              unattributedReason,
            }),
        ...(callId ? { callId } : {}),
        kind: 'native_status',
        timestamp: Date.now(),
        raw: {
          type: 'approval-response',
          toolName,
          decision: 'cancelled',
          ...(turn?.cancelling ? { reason: 'turn-cancelling' } : {}),
        },
      });
      rpc.respond(id, { outcome: { outcome: 'cancelled' } });
      return;
    }

    const identity = { ...a.identity, admissionId: a.admissionId, ...(callId ? { callId } : {}) };

    this._emit({
      ...identity,
      kind: 'native_status',
      timestamp: Date.now(),
      raw: { type: 'approval-request', toolName, ...(callId ? { callId } : {}) },
    });

    // Antigravity routes native user-input questions over `session/request_permission` with
    // `toolCallId: "interaction_*"` and `kind: "allow_once"` choices; never auto-pick an answer.
    if (callId?.startsWith('interaction_')) {
      rpc.respond(id, { outcome: { outcome: 'cancelled' } });
      this._emit({
        ...identity,
        kind: 'native_status',
        timestamp: Date.now(),
        raw: {
          type: 'approval-response',
          toolName,
          decision: 'cancelled',
          reason: 'user-input-unsupported',
        },
      });
      return;
    }

    if (this._permissionMode === 'bypassPermissions') {
      if (allowOption) {
        rpc.respond(id, { outcome: { outcome: 'selected', optionId: allowOption.optionId } });
      } else {
        rpc.respond(id, { outcome: { outcome: 'cancelled' } });
      }
      this._emit({
        ...identity,
        kind: 'native_status',
        timestamp: Date.now(),
        raw: {
          type: 'approval-response',
          toolName,
          decision: allowOption ? 'allow' : 'cancelled',
          ...(allowOption ? { optionId: allowOption.optionId } : {}),
        },
      });
      return;
    }

    const pending: PendingApproval = {
      id,
      controller: new AbortController(),
      responded: false,
    };
    this._approvals.set(id, pending);

    const decision = await this._gates.decide({
      stage: 'permission',
      toolName,
      ...mcpToolParts(toolName),
      toolInput: Object.freeze(structuredClone(rawInput)),
      ...(callId ? { callId } : {}),
      admissionId: a.admissionId,
      ...(str(toolCall?.title) ? { description: str(toolCall?.title) } : {}),
      signal: pending.controller.signal,
    });

    if (this._approvals.get(id) === pending) this._approvals.delete(id);
    if (pending.responded) return;
    pending.responded = true;

    if (
      pending.controller.signal.aborted ||
      turn.cancelling ||
      !this._alive ||
      this._rpc !== rpc ||
      rpc.closed
    ) {
      if (this._rpc === rpc && !rpc.closed) rpc.respond(id, { outcome: { outcome: 'cancelled' } });
      return;
    }

    if (decision?.behavior === 'allow' && allowOption) {
      rpc.respond(id, { outcome: { outcome: 'selected', optionId: allowOption.optionId } });
      this._emit({
        ...identity,
        kind: 'native_status',
        timestamp: Date.now(),
        raw: {
          type: 'approval-response',
          toolName,
          decision: 'allow',
          optionId: allowOption.optionId,
        },
      });
      return;
    }

    if (rejectOption) {
      rpc.respond(id, { outcome: { outcome: 'selected', optionId: rejectOption.optionId } });
    } else {
      rpc.respond(id, { outcome: { outcome: 'cancelled' } });
    }
    this._emit({
      ...identity,
      kind: 'native_status',
      timestamp: Date.now(),
      raw: {
        type: 'approval-response',
        toolName,
        decision: rejectOption ? 'reject' : 'cancelled',
        ...(rejectOption ? { optionId: rejectOption.optionId } : {}),
        ...(decision?.behavior === 'deny' ? { reason: decision.message } : {}),
      },
    });
  }

  private _cancelPendingApprovals(replyCancelled: boolean): void {
    const rpc = this._rpc;
    for (const pending of this._approvals.values()) {
      pending.controller.abort();
      if (replyCancelled && !pending.responded && rpc && !rpc.closed) {
        pending.responded = true;
        rpc.respond(pending.id, { outcome: { outcome: 'cancelled' } });
      }
    }
    this._approvals.clear();
  }

  // ---------------------------------------------------------------------------
  // Event emission
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
        if (observation && typeof (observation as PromiseLike<unknown>).then === 'function')
          void Promise.resolve(observation).catch(() => {
            this._observerFailures.asynchronous++;
          });
      } catch {
        this._observerFailures.synchronous++;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Wire parsing helpers
// ---------------------------------------------------------------------------

const MODE_CANDIDATES: Readonly<Record<HostPermissionMode, readonly string[]>> = {
  default: ['default'],
  acceptEdits: ['acceptEdits', 'accept-edits', 'auto_edit'],
  plan: ['plan'],
  bypassPermissions: ['bypassPermissions', 'yolo'],
};

function resolveAcpToolName(
  update: Record<string, unknown> | undefined,
  prevName: string | undefined,
): string {
  const rawInput = object(update?.rawInput);
  const serverName = str(rawInput?.ServerName);
  const mcpToolName = str(rawInput?.ToolName);
  const explicitName = str(update?.name);
  if (serverName && mcpToolName && (!explicitName || explicitName === 'call_mcp_tool'))
    return `mcp__${serverName}__${mcpToolName}`;
  // Subsequent tool_call_update frames may repeat `name: "call_mcp_tool"` without rawInput; keep the resolved MCP name.
  if (explicitName === 'call_mcp_tool' && prevName?.startsWith('mcp__')) return prevName;
  return explicitName ?? prevName ?? str(update?.title) ?? str(update?.kind) ?? 'tool';
}

function parseCapabilities(raw: unknown): AcpServerCapabilities {
  const res = object(raw);
  const caps = object(res?.agentCapabilities);
  const prompt = object(caps?.promptCapabilities);
  const mcp = object(caps?.mcpCapabilities);
  const session = object(caps?.sessionCapabilities);
  const antigravityMeta = object(object(caps?._meta)?.antigravity);
  const systemPromptMeta = object(antigravityMeta?.systemPrompt);
  const info = object(res?.agentInfo);
  const name = str(info?.name);
  return Object.freeze({
    loadSession: caps?.loadSession === true,
    promptCapabilities: Object.freeze({
      image: prompt?.image === true,
      audio: prompt?.audio === true,
      embeddedContext: prompt?.embeddedContext === true,
    }),
    mcpCapabilities: Object.freeze({
      http: mcp?.http === true,
      sse: mcp?.sse === true,
      acp: mcp?.acp === true,
    }),
    sessionCapabilities: Object.freeze({
      resume: session?.resume !== undefined && session.resume !== null && session.resume !== false,
      fork: session?.fork !== undefined && session.fork !== null && session.fork !== false,
      close: session?.close !== undefined && session.close !== null && session.close !== false,
    }),
    systemPromptAppend: systemPromptMeta?.append === true,
    ...(name
      ? {
          agentInfo: Object.freeze({
            name,
            ...(str(info?.title) ? { title: str(info?.title) } : {}),
            ...(str(info?.version) ? { version: str(info?.version) } : {}),
          }),
        }
      : {}),
  });
}

function filterMcpServers(
  servers: readonly AcpMcpServer[],
  capabilities: AcpServerCapabilities['mcpCapabilities'],
): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const server of servers) {
    if ('type' in server && server.type !== undefined) {
      if (server.type === 'http' && !capabilities.http) continue;
      if (server.type === 'sse' && !capabilities.sse) continue;
      out.push({
        type: server.type,
        name: server.name,
        url: server.url,
        headers: server.headers.map((h) => ({ name: h.name, value: h.value })),
      });
    } else {
      out.push({
        name: server.name,
        command: server.command,
        args: [...server.args],
        env: server.env.map((e) => ({ name: e.name, value: e.value })),
      });
    }
  }
  return out;
}

function parseConfigOptions(raw: readonly unknown[]): AcpConfigOption[] {
  const parsed: AcpConfigOption[] = [];
  for (const item of raw) {
    const opt = object(item);
    const id = str(opt?.id);
    const name = str(opt?.name);
    if (!opt || !id || !name) continue;
    const type = opt.type === 'boolean' ? 'boolean' : 'select';
    if (type === 'boolean' && typeof opt.currentValue === 'boolean') {
      parsed.push({
        id,
        name,
        ...(str(opt.category) ? { category: str(opt.category) } : {}),
        type: 'boolean',
        currentValue: opt.currentValue,
      });
      continue;
    }
    if (typeof opt.currentValue !== 'string') continue;
    const choices: Array<{ value: string; name: string }> = [];
    if (Array.isArray(opt.options)) {
      for (const entry of opt.options) {
        const obj = object(entry);
        if (!obj) continue;
        if (Array.isArray(obj.options)) {
          for (const nested of obj.options) {
            const sub = object(nested);
            const subValue = str(sub?.value);
            const subName = str(sub?.name);
            if (subValue && subName) choices.push({ value: subValue, name: subName });
          }
        } else {
          const optValue = str(obj.value);
          const optName = str(obj.name);
          if (optValue && optName) choices.push({ value: optValue, name: optName });
        }
      }
    }
    parsed.push({
      id,
      name,
      ...(str(opt.category) ? { category: str(opt.category) } : {}),
      type: 'select',
      currentValue: opt.currentValue,
      ...(choices.length ? { options: choices } : {}),
    });
  }
  return parsed;
}

function parsePermissionOptions(raw: unknown): AcpPermissionOption[] {
  if (!Array.isArray(raw)) return [];
  const out: AcpPermissionOption[] = [];
  for (const item of raw) {
    const opt = object(item);
    const optionId = str(opt?.optionId);
    const kind = str(opt?.kind);
    if (!optionId || !kind) continue;
    out.push({ optionId, name: str(opt?.name) ?? optionId, kind });
  }
  return out;
}

function extractToolOutput(update: Record<string, unknown>): string | undefined {
  if (Array.isArray(update.content)) {
    const parts: string[] = [];
    for (const entry of update.content) {
      const item = object(entry);
      if (!item) continue;
      if (item.type === 'content') {
        const inner = object(item.content);
        if (inner?.type === 'text' && typeof inner.text === 'string') parts.push(inner.text);
      } else if (item.type === 'diff' && typeof item.path === 'string') {
        parts.push(`diff:${item.path}`);
      } else if (item.type === 'terminal' && typeof item.terminalId === 'string') {
        parts.push(`terminal:${item.terminalId}`);
      }
    }
    if (parts.length) return parts.join('\n');
  }
  const rawOutput = update.rawOutput;
  if (typeof rawOutput === 'string') return rawOutput;
  const rawObj = object(rawOutput);
  if (rawObj) {
    if (typeof rawObj.output === 'string') return rawObj.output;
    if (typeof rawObj.text === 'string') return rawObj.text;
    if (typeof rawObj.combinedOutput === 'string') return rawObj.combinedOutput;
    if (typeof rawObj.combined_output === 'string') return rawObj.combined_output;
    return JSON.stringify(rawObj);
  }
  return undefined;
}

function acpTokens(value: unknown): SessionTokens | undefined {
  const usage = object(value);
  if (!usage) return undefined;
  const inputTokens = nonNegInt(usage.inputTokens);
  const outputTokens = nonNegInt(usage.outputTokens);
  if (inputTokens === undefined || outputTokens === undefined) return undefined;
  const cacheRead = nonNegInt(usage.cachedReadTokens) ?? nonNegInt(usage.cacheReadTokens);
  const cacheWrite = nonNegInt(usage.cachedWriteTokens) ?? nonNegInt(usage.cacheWriteTokens);
  const thinking = nonNegInt(usage.thoughtTokens) ?? nonNegInt(usage.thinkingTokens);
  const totalTokens = nonNegInt(usage.totalTokens);

  // If cached counts are included inside inputTokens (e.g. totalTokens == inputTokens + outputTokens [+ thinking]),
  // subtract them so `input` excludes cached reads/writes per SessionTokens contract.
  const cachedSum = (cacheRead ?? 0) + (cacheWrite ?? 0);
  const inclusiveInput =
    cachedSum > 0 &&
    totalTokens !== undefined &&
    (inputTokens + outputTokens === totalTokens ||
      inputTokens + outputTokens + (thinking ?? 0) === totalTokens);
  const input = inclusiveInput ? Math.max(0, inputTokens - cachedSum) : inputTokens;

  return {
    input,
    output: outputTokens,
    ...(cacheRead !== undefined ? { cacheRead } : {}),
    ...(cacheWrite !== undefined ? { cacheWrite } : {}),
    ...(thinking !== undefined ? { thinking } : {}),
    providerUsage: usage,
  };
}

function isStartupSignInError(error: unknown): boolean {
  if (!(error instanceof JsonRpcError)) return false;
  if (error.code === -32000 && AUTH_ERROR_PATTERN.test(error.message)) return true;
  return error.code === -32603 && error.message.startsWith(ANTIGRAVITY_NO_BROWSER_PREFIX);
}

function isMissingSessionError(error: unknown): boolean {
  if (!(error instanceof JsonRpcError)) return false;
  if (error.code === -32002) return true;
  return MISSING_SESSION_PATTERN.test(error.message);
}

function isMissingModelError(error: unknown, isModelSetCall = false): boolean {
  if (!(error instanceof JsonRpcError)) return false;
  if (isModelSetCall && error.code === -32602) return true;
  return MISSING_MODEL_PATTERN.test(error.message);
}

function forceKill(proc: PipedSubprocess): void {
  try {
    (proc as { kill(signal?: number | NodeJS.Signals): void }).kill('SIGKILL');
  } catch {
    /* already dead */
  }
}
