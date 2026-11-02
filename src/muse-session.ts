import {
  type ApprovalDecisionInput,
  type ApprovalFailure,
  type ApprovalHandler,
  type Connection,
  MspError,
  MuseClient,
  MuseSessionDiscardedError,
  type Session as NativeSession,
  PermissionProfileNotApplied,
  readSessionDurability,
  type SessionDurabilityProfile,
  spawnMspConnection,
} from '@muse-code/sdk';
import type { HostPermissionMode } from './codex-session';
import {
  type BeforeSendHook,
  type HarnessSession,
  NativeBindingMissingError,
  type NativeInterruptOutcome,
  type SessionArtifact,
  type SessionAttempt,
  type SessionEvent,
  type SessionEventHandler,
  type SessionImage,
  type SessionResult,
  type SessionSendOptions,
  type SessionTokens,
  sendableImages,
  type TaskLifecycle,
  type ToolGate,
} from './harness-session';
import { type LimitSnapshot, mergeLimits, museLimitSnapshot } from './limits';
import { retainEvidence } from './retained-evidence';
import { mcpToolParts, ToolGates } from './tool-gate';
import { TRANSPORTS } from './transport';
import { TurnState } from './turn-state';

// ---------------------------------------------------------------------------
// MuseSession — one `muse serve` host per session, driven through Meta's
// `@muse-code/sdk` MuseClient (Muse Session Protocol). The facade opens the
// session, submits turns, answers approvals and folds the view; the calls it
// lacks (turn/interrupt, turn/steer, session/fork, session/setApprovalMode,
// usage/read, userInput/cancel) go through the same connection's `command`.
// Every view notification is classified into the shared SessionEvent taxonomy.
// The Muse session id is the externalSessionId used for cold resume.
//
// Wire contract: Muse Code 1.4.14 / @muse-code/sdk 1.4.14 (lockstep).
// ---------------------------------------------------------------------------

/** The SDK version this session is built against; the served CLI must report the same. */
export const MUSE_SDK_VERSION = '1.4.14';

export type MuseApprovalMode = 'allowAll' | 'promptUnmatched';
export type MusePermissionProfile = ':ask-me' | ':read-only' | ':unrestricted';
export type MuseReasoningEffort =
  | 'none'
  | 'minimal'
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh'
  | 'max'
  | 'ultra';
const EFFORTS: readonly MuseReasoningEffort[] = [
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra',
];

export interface MusePermissions {
  readonly approvalMode: MuseApprovalMode;
  readonly permissionProfile: MusePermissionProfile;
  /** `muse serve --disable-sandbox`: only where nothing is gated. */
  readonly disableSandbox: boolean;
}

/**
 * The Muse permissions for a host permission mode (Claude's mode ids). The profile is always chosen
 * explicitly: the host default (`:auto-review`) lets Muse's AI reviewer decide approvals instead of
 * the gates. `plan` maps to `:read-only` like Codex's read-only sandbox.
 */
export function musePermissions(mode: HostPermissionMode): MusePermissions {
  switch (mode) {
    case 'default':
    case 'acceptEdits':
      return {
        approvalMode: 'promptUnmatched',
        permissionProfile: ':ask-me',
        disableSandbox: false,
      };
    case 'plan':
      return {
        approvalMode: 'promptUnmatched',
        permissionProfile: ':read-only',
        disableSandbox: false,
      };
    case 'bypassPermissions':
      return {
        approvalMode: 'allowAll',
        permissionProfile: ':unrestricted',
        disableSandbox: true,
      };
  }
}

/** What the SDK handshake answered, as this session reads it. */
export type MuseInitializeResult = MuseClient['initializeResult'];
type ApprovalRequest = Parameters<ApprovalHandler>[0];
/** One answer to one question of a `userInput/request` (SDK `UserInputAnswer`). */
export type MuseUserInputAnswer = Parameters<NativeSession['answerUserInput']>[1][number];
/** One question of a `userInput/request` (SDK `UserInputQuestion`). */
export type MuseUserInputQuestion = Readonly<{
  id: string;
  header: string;
  question: string;
  options: readonly Readonly<{ label: string; description?: string }>[];
  selection: Readonly<{ mode: string; minSelections?: number; maxSelections?: number }>;
}>;

/** A question Muse asks during a turn (`userInput/request`). */
export interface MuseUserInputRequest {
  readonly userInputId: string;
  readonly turnId?: string;
  /** The tool that asked (Muse's ask-user tool). */
  readonly toolName?: string;
  readonly questions: readonly MuseUserInputQuestion[];
  /** The in-flight admission, when one is attributable. */
  readonly admissionId?: string;
  /** Aborted when Muse settles the question itself or the session ends; a later answer is discarded. */
  readonly signal: AbortSignal;
}
/** Answers in question order, or undefined to decline (the question is cancelled with a reason). */
export type MuseUserInputHandler = (
  request: MuseUserInputRequest,
) =>
  | readonly MuseUserInputAnswer[]
  | undefined
  | Promise<readonly MuseUserInputAnswer[] | undefined>;

/** An initialized MSP host: the seam tests replace. */
export interface MuseHost {
  readonly connection: Connection;
  readonly initializeResult: MuseInitializeResult;
  /** Settles when the host process has ended. */
  readonly exited: Promise<unknown>;
  /** Bounded stderr tail, for error messages. */
  stderrTail?(): readonly string[];
  /** Orderly shutdown (stdin EOF, then signals). */
  close(): Promise<unknown>;
}

export interface MuseLaunch {
  readonly museBin: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Record<string, string>;
  readonly initialize: Parameters<ReturnType<typeof spawnMspConnection>['initialize']>[0];
}

export type MuseConnect = (launch: MuseLaunch) => Promise<MuseHost>;

export interface MuseSessionConfig {
  /** Path to the `muse` launcher. Defaults to "muse". */
  museBin?: string;
  /** Model id (`modelId`). Omitted → Muse's default. Recorded per run. */
  model?: string;
  /** Reasoning effort for every turn. Omitted → Muse's default. */
  effort?: MuseReasoningEffort;
  /** Working directory and workspace root. */
  cwd?: string;
  /** Default per-send timeout in ms. Defaults to 600000 (10 min). */
  timeout?: number;
  /** Prepended to the first turn's text (Muse has no system-prompt parameter on session/start). */
  baseContext?: string;
  /** Muse's session id. When set, the first send() resumes it (`session/resume`). */
  externalSessionId?: string;
  /** Host permission mode, mapped by `musePermissions`. Defaults to `default` (gated). */
  permissionMode?: HostPermissionMode;
  /**
   * Environment merged over process.env. Per-login isolation goes here: Muse reads its login from
   * `$XDG_CONFIG_HOME/muse/auth.json` (or `MUSE_AUTH_PATH`) and keeps sessions under
   * `$XDG_DATA_HOME/muse`. Metered keys and endpoints are always removed.
   */
  env?: Record<string, string | undefined>;
  /** Persist the actual session id before the first turn is written; a failure blocks work. */
  onSessionReady?: (sessionId: string) => void | Promise<void>;
  /** Replaces the host spawn and handshake. Tests inject a fake; defaults to `muse serve`. */
  connect?: MuseConnect;
}

interface MuseForkSource {
  readonly sessionId: string;
}

interface QueuedTurn {
  onAdmission?: SessionSendOptions['onAdmission'];
  evidence: TurnState;
  message: string;
  images: readonly SessionImage[];
  timeout: number;
  resolve: (result: SessionResult) => void;
  reject: (error: Error) => void;
}

interface TrackedItem {
  kind: string;
  turnId?: string;
  completed: boolean;
  started: boolean;
}

class NativeValidationError extends Error {}

/** A classified event's identity and evidence, before its kind and time. */
type EventBase = Omit<SessionEvent, 'kind' | 'timestamp'>;

const STARTUP_TIMEOUT_MS = 30_000;
const CLIENT_INFO = { name: 'agent_session', title: 'agent-session', version: '1' } as const;

/**
 * Inherited variables that would bill, route or loosen Muse away from its saved subscription login
 * and the gates, by the names the 1.4.14 binary reads: metered keys and endpoints (META_, LLM_,
 * MODEL_, LLAMA_, OPENROUTER_, ANTHROPIC_, OPENAI_), Meta's auth and key-mint endpoints, and MUSE_
 * switches for the model, experiments, contributor mode, the approval judge and a fail-open
 * profile. Muse's own tool runs inherit this environment, so they do not see these either.
 */
const COMPETING_ENV =
  /^(META_|LLM_|MODEL_|LLAMA_|OPENROUTER_|ANTHROPIC_|OPENAI_|TBH_(AUTH|MINT)_BASE_URL$|MUSE_EXPERIMENTAL_|MUSE_(MODEL|CONTRIBUTOR_MODE|DISABLE_APPROVAL_JUDGE|PERMISSION_PROFILE_FAIL_OPEN)$)/;

export class MuseSession implements HarnessSession {
  get transport() {
    return TRANSPORTS['muse-serve'];
  }
  readonly admissionProtocol = 'prewrite-v1' as const;

  // -- Config --
  private readonly _bin: string;
  private readonly _model?: string;
  private readonly _effort?: MuseReasoningEffort;
  private readonly _cwd: string;
  private readonly _defaultTimeout: number;
  private readonly _baseContext?: string;
  private readonly _env?: Record<string, string | undefined>;
  private readonly _permissionMode: HostPermissionMode;
  private readonly _permissions: MusePermissions;
  private readonly _connect: MuseConnect;
  private readonly _onSessionReady?: (sessionId: string) => void | Promise<void>;
  private readonly _config: MuseSessionConfig;
  private _forkFrom?: MuseForkSource;

  // -- Host --
  private _host: MuseHost | null = null;
  private _client: MuseClient | null = null;
  private _session: NativeSession | null = null;
  private _durability?: SessionDurabilityProfile;
  private _startedOnce = false;

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
  private _startedAt = Date.now();
  private _injectedBaseContext = false;
  private _limits?: LimitSnapshot;

  // -- Turns --
  private _queue: QueuedTurn[] = [];
  private _attempts: TurnState[] = [];
  private _inflight: QueuedTurn | null = null;
  private _turnTimer: ReturnType<typeof setTimeout> | null = null;
  private _turnDone?: () => void;
  private _seenTerminals = new Set<string>();
  private _items = new Map<string, TrackedItem>();
  /** Frames for turns not yet known while our turn/start answer is due: the answer names our turn. */
  private _held: Array<{ method: string; params: unknown }> = [];
  /** Turns seen while a turn/start answer was lost: possibly ours, so never claimed as Muse's. */
  private _unknownTurns = new Set<string>();
  /** Settles when the in-flight turn/start answer arrives (or fails). */
  private _ackDue?: Promise<void>;
  private _ackDone?: () => void;
  /** Turns Muse started without a send from this session (cron, monitor, goal, another client). */
  private _museTurns = new Map<string, { content: string; trigger?: string }>();
  /** The session a resume or fork is opening, before it becomes the binding. */
  private _openingId?: string;
  private _turnTokens?: SessionTokens;

  // -- Gates and questions --
  private _gates = new ToolGates();
  private _approvals = new Map<string, AbortController>();
  private _userInputHandler?: MuseUserInputHandler;
  private _userInputs = new Map<string, AbortController>();
  /** Questions already taken: the host sends a request and its notification twin, and re-sends on resume. */
  private _askedInputs = new Set<string>();

  constructor(config: MuseSessionConfig = {}) {
    const bin = config.museBin ?? 'muse';
    if (!/^[a-zA-Z0-9_./\\-]+$/.test(bin))
      throw new Error(`Invalid muse CLI binary path: "${bin}"`);
    if (config.effort && !EFFORTS.includes(config.effort))
      throw new Error(`Invalid muse effort "${config.effort}". Valid: ${EFFORTS.join(', ')}`);
    this._config = config;
    this._bin = bin;
    this._model = config.model;
    this._effort = config.effort;
    this._cwd = config.cwd ?? process.cwd();
    this._defaultTimeout = config.timeout ?? 600_000;
    this._baseContext = config.baseContext;
    this._externalSessionId = config.externalSessionId;
    this._env = config.env;
    this._permissionMode = config.permissionMode ?? 'default';
    this._permissions = musePermissions(this._permissionMode);
    this._connect = config.connect ?? spawnMuseHost;
    this._onSessionReady = config.onSessionReady;
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
  get totalTokens(): Readonly<{ input: number; output: number }> {
    return { ...this._totalTokens };
  }
  /** Latest account limits observed on this session (stream or poll). */
  get limits(): LimitSnapshot | undefined {
    return this._limits;
  }
  /** Whether sessions survive this host (from the handshake); undefined before start(). */
  get durability(): SessionDurabilityProfile | undefined {
    return this._durability;
  }
  inspectAttempt(admissionId: string) {
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

  /** Needs a gated mode (`allowAll` sends no approvals). Forks copy the gates registered now. */
  onToolRequest(gate: ToolGate): () => void {
    if (this._permissions.approvalMode === 'allowAll')
      throw new Error(
        'Tool gates need a Muse session launched with approval mode "promptUnmatched"; under bypassPermissions no approval reaches them',
      );
    return this._gates.add(gate);
  }

  /**
   * Answer Muse's questions (`userInput/request`). One handler at a time, because two cannot both
   * answer one question; registering replaces the previous one. Without a handler, or when it
   * declines or throws, the question is cancelled with a reason so the turn goes on.
   */
  onUserInput(handler: MuseUserInputHandler): () => void {
    this._userInputHandler = handler;
    return () => {
      if (this._userInputHandler === handler) this._userInputHandler = undefined;
    };
  }

  // ---------------------------------------------------------------------------
  // interrupt / kill / artifact / fork
  // ---------------------------------------------------------------------------

  interrupt(): void {
    if (!this._inflight) return;
    this._rejectInflight(
      new Error('Local waiter interrupted; native cancellation unacknowledged'),
      'interrupt-request',
    );
  }

  kill(): void {
    if (!this._host) return;
    this._alive = false;
    this._rejectInflight(new Error('Session killed; native outcome may remain unknown'), 'killed');
    this._rejectQueue(new Error('Session killed'));
    this._withdrawRequests();
    this._turnDone?.();
    this._turnDone = undefined;
    const host = this._host;
    const client = this._client;
    this._host = null;
    this._client = null;
    this._session = null;
    // Frames the host already sent still reach the record; their ownership is unknown.
    const pending = this._inflight?.evidence;
    if (pending?.rpcOutcome === 'pending') pending.rpcOutcome = 'unknown';
    this._flushHeld();
    // Through the client first: it marks the EOF as ours, not a host death that discards sessions.
    void Promise.resolve(client?.close())
      .catch(() => undefined)
      .finally(() => host.close().catch(() => undefined));
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

  /**
   * A new, unstarted session that branches this one (`session/fork` on its own host when it
   * starts). Needs a native session id. Gates registered now are copied.
   */
  fork(opts?: { cwd?: string; baseContext?: string }): HarnessSession {
    const source = this._externalSessionId;
    if (!source) throw new Error('Nothing to fork: the Muse session has no native id yet');
    if (this._inflight) throw new Error('Cannot fork a Muse session while a turn is in flight');
    // The branch already holds the parent's base context; only a new one is prepended. `cwd` moves
    // the fork's host; the forked session keeps the source's workspace root.
    const fork = new MuseSession({
      ...this._config,
      externalSessionId: undefined,
      onSessionReady: undefined,
      baseContext: opts?.baseContext,
      ...(opts?.cwd ? { cwd: opts.cwd } : {}),
    });
    fork._forkFrom = { sessionId: source };
    for (const gate of this._gates.list()) fork._gates.add(gate);
    if (this._userInputHandler) fork._userInputHandler = this._userInputHandler;
    return fork;
  }

  // ---------------------------------------------------------------------------
  // start() — spawn the host, check the version, wire the client
  // ---------------------------------------------------------------------------

  async start(): Promise<void> {
    if (this._inflight)
      throw Error('Native call ownership unresolved; automatic resume is blocked');
    if (this._startedOnce && !this._alive)
      throw Error('Muse host restart requires a new owned instance');
    if (this._host) throw new Error('Session already started');
    this._startedOnce = true;
    try {
      await this._launch();
    } catch (error) {
      this.kill();
      throw error;
    }
  }

  private _childEnv(): Record<string, string> {
    const merged: Record<string, string | undefined> = {
      ...process.env,
      ...this._env,
      MUSE_NO_AUTO_UPDATE: '1',
    };
    const env: Record<string, string> = {};
    // Subscription transport: a metered key or another endpoint never replaces the saved login.
    for (const [key, value] of Object.entries(merged))
      if (value !== undefined && !COMPETING_ENV.test(key)) env[key] = value;
    return env;
  }

  private async _launch(): Promise<void> {
    const host = await this._connect({
      museBin: this._bin,
      args: [
        'serve',
        '--trust-workspace',
        ...(this._permissions.disableSandbox ? ['--disable-sandbox'] : []),
      ],
      cwd: this._cwd,
      env: this._childEnv(),
      initialize: {
        clientInfo: CLIENT_INFO,
        // why: experimentalApi is what makes session/read report permissionState, the only proof the profile applied.
        capabilities: { experimentalApi: true, userInputDialogs: true },
      },
    });
    this._host = host;
    const served = host.initializeResult.serverInfo?.version;
    if (served !== MUSE_SDK_VERSION)
      throw new Error(
        `Muse Code ${served ?? 'unknown'} does not match the pinned @muse-code/sdk ${MUSE_SDK_VERSION}; install Muse Code ${MUSE_SDK_VERSION} or move the SDK pin with the CLI`,
      );
    if (host.initializeResult.schema?.version !== 1)
      throw new Error(
        `Muse Code serves protocol envelope ${String(host.initializeResult.schema?.version)}; this session reads version 1`,
      );
    this._durability = readSessionDurability(host.initializeResult);
    this._tap(host.connection);
    this._client = new MuseClient(host.connection, { durability: this._durability });
    this._alive = true;
    this._endEmitted = false;
    this._emit({
      kind: 'session_start',
      timestamp: Date.now(),
      raw: {
        type: 'host-ready',
        version: served,
        durability: this._durability.kind,
        permissionMode: this._permissionMode,
      },
    });
    void host.exited.then(() => {
      if (this._host !== host || !this._alive) return;
      this._hostDied(host);
    });
  }

  /** The host ended under us. An ephemeral host takes its sessions with it. */
  private _hostDied(host: MuseHost): void {
    const tail = host.stderrTail?.().join('').trim();
    const message = tail ? `Muse host exited: ${tail.slice(-500)}` : 'Muse host exited';
    const binding = this._externalSessionId;
    const error =
      binding && this._durability?.kind !== 'durable'
        ? new Error(message, {
            cause: new NativeBindingMissingError(
              'muse',
              binding,
              `Ephemeral Muse host died; session ${binding} went with it`,
              this._cwd,
            ),
          })
        : new Error(message);
    this._transportFailure(error);
  }

  /**
   * MuseClient claims the connection's single notification and server-request handlers. Wrap both
   * before it does, so every frame still reaches the client first and this session classifies it
   * after the fold has applied it.
   */
  private _tap(connection: Connection): void {
    const onNotification = connection.onNotification.bind(connection);
    connection.onNotification = (handler) =>
      onNotification((notification) => {
        handler(notification);
        this._observe(notification.method, notification.params);
      });
    const onServerRequest = connection.onServerRequest.bind(connection);
    connection.onServerRequest = (handler) =>
      onServerRequest(async (request) => {
        const answer = await handler(request);
        if (request.method === 'userInput/request')
          this._observe('userInput/requested', request.params);
        return answer;
      });
  }

  // ---------------------------------------------------------------------------
  // send() — queue a turn, resolve on its native terminal
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
    if (!this._host && (this._externalSessionId || this._forkFrom)) await this.start();
    if (!this._host) throw new Error('Session not started — call start() first');
    if (!this._alive) throw new Error('Session ended');

    const timeout = opts?.timeout ?? this._defaultTimeout;
    const images = sendableImages(this.transport, opts?.images);
    let transformed = message;
    for (const hook of this._beforeSendHooks) transformed = await hook(transformed);
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
    if (!turn.onAdmission) {
      this._writeTurn(turn);
      return;
    }
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
  }

  private _writeTurn(turn: QueuedTurn): void {
    turn.evidence.dispatch = 'attempted';
    this._sendTurn(turn)
      .then(() => {
        if (this._inflight !== turn) return;
        const tokens = turn.evidence.tokens;
        if (tokens) {
          this._totalTokens.input += tokens.input;
          this._totalTokens.output += tokens.output;
        }
        this._resolveTurn();
      })
      .catch((err: Error) => {
        if (this._inflight !== turn) return;
        if (turn.evidence.rpcOutcome === 'pending') turn.evidence.rpcOutcome = 'unknown';
        this._rejectInflight(err, err instanceof NativeValidationError ? 'validation' : 'rpc');
        this._releaseKnownTurn();
      });
    if (turn.timeout > 0)
      this._turnTimer = setTimeout(() => {
        this._turnTimer = null;
        // An approval waiting on an answer that never came must not hold the host forever.
        this._releaseAck();
        this._rejectInflight(new Error(`Turn timed out after ${turn.timeout}ms`), 'timeout');
      }, turn.timeout);
  }

  private _resolveTurn(): void {
    if (!this._inflight) return;
    this._clearTimer();
    const a = this._inflight.evidence;
    if (a.localOutcome === 'pending') {
      a.localOutcome = 'resolved';
      this._inflight.resolve(a.result(this._externalSessionId));
    }
    this._releaseKnownTurn();
  }

  /** The admission is released once its turn/start answer and its native terminal are both known. */
  private _releaseKnownTurn(): void {
    const a = this._inflight?.evidence;
    if (!a) return;
    const noSend = a.dispatch === 'not-dispatched' && a.localOutcome === 'rejected';
    const rpcKnown = a.rpcOutcome === 'resolved' || a.rpcOutcome === 'failed';
    // A refused turn/start admitted nothing, so no terminal will come.
    const settled = rpcKnown && (a.rpcOutcome === 'failed' || a.nativeOutcome !== 'unknown');
    if (!noSend && !settled) return;
    if (!noSend && a.rpcOutcome === 'resolved') this._turns++;
    this._inflight = null;
    this._processNextTurn();
  }

  private _processNextTurn(): void {
    if (!this._inflight && this._queue.length > 0 && this._alive) {
      const next = this._queue.shift()!;
      this._dispatchTurn(next);
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

  private _transportFailure(err: Error): void {
    this._alive = false;
    this._rejectInflight(err);
    this._rejectQueue(err);
    this._withdrawRequests();
    this._turnDone?.();
    this._turnDone = undefined;
    this._emit({ kind: 'session_end', timestamp: Date.now(), transportOutcome: 'failed' });
  }

  private _rejectQueue(err: Error): void {
    for (const turn of this._queue) turn.reject(turn.evidence.fail(err, 'blocked'));
    this._queue = [];
  }

  private _withdrawRequests(): void {
    for (const controller of this._approvals.values()) controller.abort();
    this._approvals.clear();
    for (const controller of this._userInputs.values()) controller.abort();
    this._userInputs.clear();
  }

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

  // ---------------------------------------------------------------------------
  // Session open (start, resume, fork) and the turn itself
  // ---------------------------------------------------------------------------

  private _refuse(reason: string, status = 'unknown'): never {
    const a = this._inflight?.evidence;
    this._emit({
      ...(a ? { admissionId: a.admissionId, ...a.identity } : {}),
      kind: 'native_status',
      timestamp: Date.now(),
      raw: { type: 'session-refused', reason, status },
    });
    throw new NativeValidationError(
      `Native session validation refused: ${reason} (${status}); no turn was sent`,
    );
  }

  /** A Muse answer that the session does not exist (deleted, other home, ephemeral host gone). */
  private _missing(error: unknown, binding: string, a: TurnState): never {
    if (
      error instanceof MuseSessionDiscardedError ||
      (error instanceof MspError && (error.kind === 'sessionNotFound' || error.kind === 'notFound'))
    ) {
      a.dispatch = 'not-dispatched';
      throw new NativeBindingMissingError(
        'muse',
        binding,
        error instanceof Error ? error.message : String(error),
        this._cwd,
      );
    }
    throw error;
  }

  private async _resume(sessionId: string, a: TurnState): Promise<NativeSession> {
    // Frames the host re-sends during the resume (an open question) belong to this session.
    this._openingId = sessionId;
    try {
      return await this._client!.resumeSession({
        sessionId,
        excludeItems: true,
        permissionProfile: this._permissions.permissionProfile,
        ...(this._model ? { modelId: this._model } : {}),
        // On the resume itself, so an approval re-sent right after the reply reaches the gates.
        onApproval: (request) => this._approval(request),
        onApprovalError: (failure) => this._approvalFailure(failure),
      });
    } catch (error) {
      return this._missing(error, sessionId, a);
    }
  }

  private async _open(a: TurnState): Promise<void> {
    const connection = this._host!.connection;
    const { approvalMode, permissionProfile } = this._permissions;
    let session: NativeSession;
    const binding = this._externalSessionId;
    const method = binding ? 'session/resume' : this._forkFrom ? 'session/fork' : 'session/start';
    if (binding) session = await this._resume(binding, a);
    else if (this._forkFrom) {
      const source = this._forkFrom.sessionId;
      let forked: Record<string, unknown>;
      try {
        forked = await connection.command('session/fork', {
          sessionId: source,
          excludeItems: true,
        });
      } catch (error) {
        return this._missing(error, source, a);
      }
      const id = object(forked.session)?.sessionId;
      if (typeof id !== 'string' || !id) this._refuse('fork-missing-session');
      session = await this._resume(id, a);
    } else {
      try {
        session = await this._client!.startSession({
          workspaceRoot: this._cwd,
          providerId: 'meta',
          approvalMode,
          permissionProfile,
          requirePermissionProfile: true,
          ...(this._model ? { modelId: this._model } : {}),
        });
      } catch (error) {
        if (error instanceof PermissionProfileNotApplied)
          this._refuse('permission-profile-not-applied', String(error.served ?? 'unknown'));
        throw error;
      }
      session.onApproval((request) => this._approval(request));
      session.onApprovalError((failure) => this._approvalFailure(failure));
    }
    const sessionId = session.sessionId;
    if (binding && sessionId !== binding) this._refuse('binding-mismatch');
    // A resumed or forked session keeps its stored approval mode; set it again, then prove both.
    if (method !== 'session/start')
      await connection.command('session/setApprovalMode', { sessionId, mode: approvalMode });
    const read = object((await connection.command('session/read', { sessionId })).session);
    const state = object(read?.permissionState);
    if (state?.profileId !== permissionProfile)
      this._refuse('permission-profile-not-applied', String(state?.profileId ?? 'unknown'));
    if (object(read?.approvalMode)?.mode !== approvalMode)
      this._refuse('approval-mode-not-applied', String(object(read?.approvalMode)?.mode));
    // A gated session is answered by a person through the gates, never by Muse's AI reviewer.
    if (
      approvalMode === 'promptUnmatched' &&
      (state.reviewerAuthority !== 'human' || object(state.axes)?.reviewer !== 'human')
    )
      this._refuse('reviewer-not-human', String(state.reviewerAuthority ?? 'unknown'));
    // A resumed or forked session keeps its stored provider: only Meta bills the subscription login.
    if (read?.providerId !== 'meta') this._refuse('provider-not-meta', String(read?.providerId));
    if (read?.activeTurnId != null) this._refuse('not-idle', 'active');
    this._session = session;
    this._externalSessionId = sessionId;
    this._forkFrom = undefined;
    a.identity = { ...a.identity, nativeSessionId: sessionId };
    if (this._onSessionReady) {
      try {
        await this._onSessionReady(sessionId);
      } catch (cause) {
        throw new NativeValidationError('Native binding persistence failed before turn/start', {
          cause,
        });
      }
    }
    this._emit({
      kind: 'native_status',
      timestamp: Date.now(),
      nativeSessionId: sessionId,
      correlation: 'unknown',
      unattributedReason: 'session-configuration',
      raw: {
        type: 'session-configured',
        method,
        sessionId,
        ...(typeof read?.modelId === 'string' ? { model: read.modelId } : {}),
        ...(typeof read?.providerId === 'string' ? { provider: read.providerId } : {}),
        approvalMode,
        permissionProfile,
        ...(typeof state?.reviewerAuthority === 'string'
          ? { reviewerAuthority: state.reviewerAuthority }
          : {}),
        ...(typeof read?.turnCount === 'number' ? { turnCount: read.turnCount } : {}),
      },
    });
  }

  private async _sendTurn(turn: QueuedTurn): Promise<void> {
    const a = turn.evidence;
    try {
      if (!this._session) await this._open(a);
      // Timeout/kill during open must not cause a later model write.
      if (this._inflight !== turn || a.localOutcome !== 'pending' || !this._alive)
        throw Error('Local admission closed before turn/start; no turn was sent');
    } catch (error) {
      // No turn/start was written, so nothing native is outstanding and the queue may move on.
      a.dispatch = 'not-dispatched';
      throw error;
    }
    this._turnTokens = undefined;
    const ended = new Promise<'ended'>((resolve) => {
      this._turnDone = () => resolve('ended');
    });
    a.rpcOutcome = 'pending';
    this._ackDue = new Promise<void>((resolve) => {
      this._ackDone = resolve;
    });
    let started: Awaited<ReturnType<NativeSession['sendUserTurn']>>;
    try {
      started = await this._session!.sendUserTurn({
        input: [
          { type: 'text', text: turn.message },
          ...turn.images.map((image) => ({
            type: 'image' as const,
            base64Data: image.data,
            mediaType: image.mediaType,
          })),
        ],
        ...(this._effort ? { reasoningEffort: this._effort } : {}),
      });
    } catch (error) {
      a.rpcOutcome = error instanceof MspError ? 'failed' : 'unknown';
      this._flushHeld();
      throw error;
    }
    a.rpcOutcome = 'resolved';
    a.identity = { ...a.identity, turnId: started.turnId, correlation: 'native-turn' };
    this._flushHeld();
    // The SDK's turn wait is the terminal of record; the classifier has already recorded it when the
    // notification named the owned turn, so only a terminal it could not attribute is recorded here.
    const outcome = await Promise.race([started.completed, ended]);
    this._turnDone = undefined;
    if (outcome === 'ended') throw new Error('Muse host ended before the turn reached a terminal');
    if (outcome.kind === 'terminalUnknown') {
      const binding = this._externalSessionId ?? '';
      throw new Error('Ephemeral Muse host died; the turn has no terminal', {
        cause: new NativeBindingMissingError(
          'muse',
          binding,
          'Ephemeral Muse host died',
          this._cwd,
        ),
      });
    }
    if (a.nativeOutcome !== 'unknown') return;
    const method = outcome.kind === 'completed' ? 'turn/completed' : 'turn/unqueued';
    const params = object(outcome.params) ?? {};
    const identity: EventBase = { ...a.identity, admissionId: a.admissionId };
    for (const event of this._terminal(method, params, identity, started.turnId)) {
      if (event.unattributedReason) {
        this._emit(event);
        continue;
      }
      const e = a.record(event);
      if (e.nativeOutcome && e.terminal) {
        a.nativeOutcome = e.nativeOutcome;
        a.terminal = e.terminal;
      }
      this._emit(e);
    }
  }

  // ---------------------------------------------------------------------------
  // Classification — every view notification after the client folded it
  // ---------------------------------------------------------------------------

  private _observe(method: string, params: unknown): void {
    try {
      for (const event of this._classify(method, object(params) ?? {})) {
        const a = this._inflight?.evidence;
        if (!a || event.unattributedReason || !event.admissionId) {
          this._emit(event);
          continue;
        }
        const e = a.record(event);
        if (e.nativeOutcome && e.terminal) {
          a.nativeOutcome = e.nativeOutcome;
          a.terminal = e.terminal;
        }
        this._emit(e);
      }
    } catch {
      this._emit({
        kind: 'native_status',
        timestamp: Date.now(),
        correlation: 'unknown',
        unattributedReason: 'unrecognized-event',
        raw: { method: 'unclassifiable' },
      });
    }
  }

  /** Approvals and questions waiting on the turn/start answer go on, attributed or not. */
  private _releaseAck(): void {
    this._ackDone?.();
    this._ackDone = undefined;
    this._ackDue = undefined;
  }

  /** Classify the frames held for the turn/start answer, now that it named (or did not) our turn. */
  private _flushHeld(): void {
    this._releaseAck();
    const held = this._held;
    this._held = [];
    const a = this._inflight?.evidence;
    if (a?.rpcOutcome === 'unknown' && !a.identity.turnId)
      for (const frame of held) {
        const params = object(frame.params);
        const turnId = str(params?.turnId) ?? str(object(params?.item)?.turnId);
        if (turnId && !this._museTurns.has(turnId)) this._unknownTurns.add(turnId);
      }
    for (const frame of held) this._observe(frame.method, frame.params);
  }

  private _limitEvent(snapshot: LimitSnapshot, raw?: Record<string, unknown>): SessionEvent {
    this._limits = mergeLimits(this._limits, snapshot);
    return {
      kind: 'rate_limit',
      timestamp: Date.now(),
      correlation: 'unknown',
      unattributedReason: 'account-status',
      limits: this._limits,
      ...(raw ? { raw } : {}),
    };
  }

  private _classify(method: string, params: Record<string, unknown>): SessionEvent[] {
    if (method === 'usage/changed') {
      const snapshot = museLimitSnapshot(params, 'stream');
      return snapshot ? [this._limitEvent(snapshot)] : [];
    }
    const sessionId = str(params.sessionId);
    if (!sessionId || (sessionId !== this._externalSessionId && sessionId !== this._openingId))
      return [];
    const now = Date.now();
    const unowned = (
      reason: NonNullable<SessionEvent['unattributedReason']>,
      raw: Record<string, unknown> = {},
    ): SessionEvent[] => [
      {
        kind: 'native_status',
        timestamp: now,
        nativeSessionId: sessionId,
        correlation: 'unknown',
        unattributedReason: reason,
        raw: { method, ...raw },
      },
    ];

    if (method === 'approval/resolved') this._settle(this._approvals, str(params.approvalId), true);
    if (method === 'userInput/settled') this._settle(this._userInputs, str(params.userInputId));
    if (method === 'userInput/requested') {
      this._question(params);
      return [];
    }

    const item = object(params.item);
    const itemId = str(item?.itemId) ?? str(params.itemId);
    let turnId = str(params.turnId) ?? str(item?.turnId);
    if (!turnId && itemId) turnId = this._items.get(itemId)?.turnId;
    const a = this._inflight?.evidence;
    // While our turn/start answer is due, a frame for a turn not yet known could be ours or one
    // Muse started itself; hold it until the answer names our turn, rather than guess.
    const known =
      (!!turnId && (this._museTurns.has(turnId) || this._seenTerminals.has(turnId))) ||
      (!turnId && !!itemId && this._items.has(itemId));
    if (
      a?.dispatch === 'attempted' &&
      a.rpcOutcome === 'pending' &&
      !a.identity.turnId &&
      !known &&
      (!!turnId ||
        method.startsWith('item/') ||
        method.startsWith('turn/') ||
        method === 'session/tokenUsage')
    ) {
      this._held.push({ method, params });
      return [];
    }
    const owned = !!a && !!turnId && turnId === a.identity.turnId;
    // A finished turn never starts again: late frames (usage after the terminal) are diagnostics.
    if (turnId && this._seenTerminals.has(turnId))
      return unowned(method === 'turn/completed' ? 'duplicate-terminal' : 'after-terminal');
    // Held while a turn/start answer that never came was due: the turn may be ours; claim nothing.
    if (turnId && this._unknownTurns.has(turnId))
      return unowned('no-admission').map((event) => ({
        ...event,
        turnId,
        ...(itemId ? { itemId } : {}),
        ...(item ? { raw: { method, itemKind: kindLabel(item) } } : {}),
      }));
    if (!owned) {
      // Work Muse runs without a send from us still reaches the caller, marked as a task.
      if (turnId) return this._museTurn(method, params, sessionId, turnId, item, itemId);
      if (itemId && (item || this._items.has(itemId)))
        return this._background(method, params, sessionId, item, itemId);
      if (method === 'session/goalChanged') return this._goal(params, sessionId);
      return unowned('session-configuration');
    }
    const identity: EventBase = {
      ...a!.identity,
      admissionId: a!.admissionId,
      turnId,
      ...(itemId ? { itemId } : {}),
    };
    const status = (raw: Record<string, unknown> = {}): SessionEvent[] => [
      { ...identity, kind: 'native_status', timestamp: now, raw: { method, ...raw } },
    ];

    switch (method) {
      case 'turn/completed':
      case 'turn/unqueued':
        return this._terminal(method, params, identity, turnId!);
      case 'turn/retryScheduled':
      case 'turn/modelRetryScheduled': {
        const http = typeof params.httpStatus === 'number' ? params.httpStatus : undefined;
        const kind = str(params.errorKind);
        const raw = {
          method,
          reason: str(params.reason),
          ...(http ? { httpStatus: http } : {}),
          ...(kind ? { errorKind: kind } : {}),
          retryDelayMs: params.retryDelayMs,
          attempt: params.attempt,
          maxAttempts: params.maxAttempts,
        };
        // The retry stays on the turn; it is also a rate limit only on HTTP 429 (a server error,
        // or a context or output limit, is not one).
        return [
          { ...identity, kind: 'native_status', timestamp: now, raw },
          ...(http === 429
            ? [
                this._limitEvent(
                  { runtime: 'muse', source: 'stream', observedAt: now, windows: [] },
                  raw,
                ),
              ]
            : []),
        ];
      }
      case 'session/tokenUsage': {
        const tokens = museTokens(params.usage);
        if (!tokens) return status({ malformed: true });
        this._turnTokens = addTokens(this._turnTokens, tokens);
        a!.tokens = this._turnTokens;
        return [{ ...identity, kind: 'usage', timestamp: now, tokens }];
      }
      case 'item/delta':
        return this._delta(params, itemId, identity, status);
      case 'item/started':
      case 'item/updated':
      case 'item/completed':
        return item && itemId ? this._item(method, item, itemId, identity, status) : status();
      default:
        return status();
    }
  }

  /** A turn's native terminal as a result event (plus the quota it hit, as a rate limit). */
  private _terminal(
    method: string,
    params: Record<string, unknown>,
    identity: EventBase,
    turnId: string,
  ): SessionEvent[] {
    this._seenTerminals.add(turnId);
    const now = Date.now();
    const content = this._inflight?.evidence.content ?? '';
    if (method === 'turn/unqueued')
      // Reclaimed before it ran: no turn/completed will ever name it.
      return [
        {
          ...identity,
          kind: 'result',
          timestamp: now,
          text: content,
          nativeOutcome: 'failed',
          terminal: { type: method, turnId, subtype: 'unqueued' },
        },
      ];
    const error = object(params.error);
    const terminal = str(params.terminal) ?? 'unknown';
    const quota = object(error?.quota);
    const reason = str(error?.message) ?? str(params.reason);
    return [
      ...(quota && typeof quota.resetsAtMs === 'number'
        ? [
            this._limitEvent(
              {
                runtime: 'muse',
                source: 'stream',
                observedAt: now,
                windows: [],
                blocked: true,
                ...(str(error?.kind) ? { reachedType: str(error?.kind) } : {}),
              },
              { method, resetsAtMs: quota.resetsAtMs },
            ),
          ]
        : []),
      {
        ...identity,
        kind: 'result',
        timestamp: now,
        text: content,
        ...(this._turnTokens ? { tokens: this._turnTokens } : {}),
        nativeOutcome: terminal === 'completed' && !error ? 'completed' : 'failed',
        terminal: { type: method, turnId, subtype: terminal, ...(reason ? { reason } : {}) },
      },
    ];
  }

  /**
   * A turn Muse started itself: a cron firing, a monitor or background-terminal wake, a goal, or a
   * message from another client of the same session. Its events fold as an admission's would, but
   * belong to none (`unattributedReason: 'task'`); the turn itself is a `task` lifecycle keyed by
   * its turn id, typed `muse-<trigger>` once its first item says what woke it.
   */
  private _museTurn(
    method: string,
    params: Record<string, unknown>,
    sessionId: string,
    turnId: string,
    item: Record<string, unknown> | undefined,
    itemId: string | undefined,
  ): SessionEvent[] {
    const now = Date.now();
    const turnBase: EventBase = {
      nativeSessionId: sessionId,
      turnId,
      correlation: 'native-turn',
      unattributedReason: 'task',
    };
    const base: EventBase = { ...turnBase, ...(itemId ? { itemId } : {}) };
    const status = (raw: Record<string, unknown> = {}): SessionEvent[] => [
      { ...base, kind: 'native_status', timestamp: now, raw: { method, ...raw } },
    ];
    const out: SessionEvent[] = [];
    let entry = this._museTurns.get(turnId);
    const lifecycle = (
      phase: 'started' | 'updated' | 'ended',
      extra: Partial<TaskLifecycle> = {},
    ): SessionEvent => ({
      ...turnBase,
      kind: 'task',
      timestamp: now,
      task: {
        phase,
        taskId: turnId,
        taskType: entry?.trigger ? `muse-${entry.trigger}` : 'muse-turn',
        ...extra,
      },
    });
    if (!entry) {
      entry = { content: '' };
      this._museTurns.set(turnId, entry);
      out.push(lifecycle('started'));
    }
    switch (method) {
      case 'turn/completed':
      case 'turn/unqueued': {
        this._seenTerminals.add(turnId);
        this._museTurns.delete(turnId);
        const reason = str(object(params.error)?.message) ?? str(params.reason);
        out.push(
          lifecycle('ended', {
            status: method === 'turn/unqueued' ? 'unqueued' : (str(params.terminal) ?? 'unknown'),
            ...(entry.content ? { summary: entry.content } : {}),
            ...(reason ? { reason } : {}),
          }),
        );
        return out;
      }
      case 'session/tokenUsage': {
        const tokens = museTokens(params.usage);
        out.push(
          ...(tokens ? [{ ...base, kind: 'usage' as const, timestamp: now, tokens }] : status()),
        );
        return out;
      }
      case 'item/delta':
        out.push(...this._delta(params, itemId, base, status));
        return out;
      case 'item/started':
      case 'item/updated':
      case 'item/completed': {
        if (!item || !itemId) return [...out, ...status()];
        const trigger = museTrigger(item);
        // A specific wake (cron, monitor, …) outranks the prompt message it delivers.
        if (trigger && (!entry.trigger || (entry.trigger === 'message' && trigger !== 'message'))) {
          entry.trigger = trigger;
          const description = triggerDescription(item);
          out.push(lifecycle('updated', description ? { description } : {}));
        }
        const events = this._item(method, item, itemId, base, status);
        for (const event of events)
          if (event.kind === 'text' && event.text && !event.parentToolUseId)
            entry.content = event.text;
        out.push(...events);
        return out;
      }
      default:
        return [...out, ...status()];
    }
  }

  /** An item outside any turn (`turnId: null`): a monitor's feed, a shell run from another client. */
  private _background(
    method: string,
    params: Record<string, unknown>,
    sessionId: string,
    item: Record<string, unknown> | undefined,
    itemId: string,
  ): SessionEvent[] {
    const now = Date.now();
    const base: EventBase = {
      nativeSessionId: sessionId,
      itemId,
      correlation: 'unknown',
      unattributedReason: 'task',
    };
    const status = (raw: Record<string, unknown> = {}): SessionEvent[] => [
      { ...base, kind: 'native_status', timestamp: now, raw: { method, ...raw } },
    ];
    if (method === 'item/delta') return this._delta(params, itemId, base, status);
    if (!item) return status();
    if (item.kind !== 'monitorFeed') return this._item(method, item, itemId, base, status);
    const tracked = this._items.get(itemId) ?? {
      kind: 'monitorFeed',
      completed: false,
      started: false,
    };
    this._items.set(itemId, tracked);
    if (
      tracked.completed ||
      (method !== 'item/completed' && !TERMINAL_ITEM.has(String(item.status)))
    )
      return status({ itemKind: 'monitorFeed' });
    tracked.completed = true;
    const summary = str(item.text) ?? str(item.fallbackText);
    const description = str(item.monitorDescription);
    return [
      {
        ...base,
        kind: 'task',
        timestamp: now,
        task: {
          phase: 'progress',
          taskId: str(item.monitorId) ?? itemId,
          taskType: 'muse-monitor',
          ...(description ? { description } : {}),
          ...(summary ? { summary } : {}),
        },
      },
    ];
  }

  /** The session's goal (create_goal, update_goal, report_progress), as a `muse-goal` task. */
  private _goal(params: Record<string, unknown>, sessionId: string): SessionEvent[] {
    const goal = object(params.goal);
    const status = goal ? (str(goal.status) ?? 'unknown') : 'cleared';
    const description = str(goal?.objective);
    const summary = str(goal?.currentWork);
    return [
      {
        nativeSessionId: sessionId,
        correlation: 'unknown',
        unattributedReason: 'task',
        kind: 'task',
        timestamp: Date.now(),
        task: {
          phase:
            !goal || /^(complete|completed|cleared|cancelled|abandoned)$/i.test(status)
              ? 'ended'
              : 'updated',
          taskId: 'goal',
          taskType: 'muse-goal',
          status,
          ...(description ? { description } : {}),
          ...(summary ? { summary } : {}),
        },
        raw: {
          method: 'session/goalChanged',
          ...(typeof goal?.percentComplete === 'number'
            ? { percentComplete: goal.percentComplete }
            : {}),
          ...(str(goal?.nextWork) ? { nextWork: str(goal?.nextWork) } : {}),
        },
      },
    ];
  }

  private _delta(
    params: Record<string, unknown>,
    itemId: string | undefined,
    base: EventBase,
    status: (raw?: Record<string, unknown>) => SessionEvent[],
  ): SessionEvent[] {
    const delta = str(params.delta);
    const tracked = itemId ? this._items.get(itemId) : undefined;
    if (!delta || !tracked || tracked.completed) return status();
    if (tracked.kind === 'agentMessage' && (params.field ?? 'text') === 'text')
      return [{ ...base, kind: 'text_delta', timestamp: Date.now(), text: delta }];
    if (TOOL_KINDS.has(tracked.kind))
      return [
        {
          ...base,
          kind: 'native_status',
          timestamp: Date.now(),
          text: delta,
          raw: { method: 'item/delta', field: params.field ?? 'output' },
        },
      ];
    return status({ itemKind: tracked.kind });
  }

  private _item(
    method: string,
    item: Record<string, unknown>,
    itemId: string,
    base: EventBase,
    status: (raw?: Record<string, unknown>) => SessionEvent[],
  ): SessionEvent[] {
    const kind = str(item.kind) ?? 'unknown';
    const prior = this._items.get(itemId);
    const tracked: TrackedItem = prior ?? {
      kind,
      turnId: str(item.turnId),
      completed: false,
      started: false,
    };
    this._items.set(itemId, tracked);
    if (tracked.completed) return status({ itemKind: kindLabel(item), duplicate: true });
    const done = method === 'item/completed';
    const ended = done || TERMINAL_ITEM.has(String(item.status));
    const now = Date.now();
    const out: SessionEvent[] = [];

    if (kind === 'agentMessage') {
      if (!done) return status({ itemKind: kind });
      tracked.completed = true;
      return typeof item.text === 'string'
        ? [{ ...base, kind: 'text', timestamp: now, text: item.text }]
        : status({ itemKind: kind, malformed: true });
    }
    if (kind === 'reasoning') {
      if (!done) return status({ itemKind: kind });
      tracked.completed = true;
      const text =
        str(item.text) ??
        (Array.isArray(item.summary)
          ? item.summary.filter((s) => typeof s === 'string').join('\n')
          : undefined);
      return text
        ? [{ ...base, kind: 'thinking', timestamp: now, text }]
        : status({ itemKind: kind });
    }
    if (TOOL_KINDS.has(kind)) {
      const tool = toolIdentity(kind, item);
      if (!tracked.started) {
        tracked.started = true;
        out.push({ ...base, ...tool, kind: 'tool_use', timestamp: now, ...toolInput(kind, item) });
      }
      if (ended) {
        tracked.completed = true;
        const output = str(item.visibleOutput) ?? str(item.failureReason) ?? str(item.fallbackText);
        out.push({
          ...base,
          ...tool,
          kind: 'tool_result',
          timestamp: now,
          ...(output !== undefined ? { toolOutput: output } : { toolOutputOmitted: true }),
          toolError:
            item.status !== 'completed' ||
            (typeof item.exitCode === 'number' && item.exitCode !== 0),
        });
      }
      return out.length ? out : status({ itemKind: kind });
    }
    if (kind === 'subagent') {
      const taskId = str(item.childSessionId) ?? str(item.subagentId) ?? itemId;
      const lifecycle = {
        taskId,
        toolUseId: itemId,
        ...(str(item.role) ? { agentType: str(item.role) } : {}),
        ...(str(item.objective) ? { prompt: str(item.objective) } : {}),
        ...(typeof item.depth === 'number' ? { depth: item.depth } : { depth: 1 }),
        ...(typeof item.background === 'boolean' ? { backgrounded: item.background } : {}),
      };
      if (!tracked.started) {
        tracked.started = true;
        out.push({
          ...base,
          kind: 'subagent',
          timestamp: now,
          subagent: { phase: 'started', ...lifecycle },
        });
      }
      if (ended) {
        tracked.completed = true;
        const summary = str(object(item.result)?.summary) ?? str(item.finalSummary);
        out.push({
          ...base,
          kind: 'subagent',
          timestamp: now,
          subagent: {
            phase: 'ended',
            ...lifecycle,
            status: String(item.status),
            ...(summary ? { summary } : {}),
          },
        });
      } else if (prior)
        out.push({
          ...base,
          kind: 'subagent',
          timestamp: now,
          subagent: { phase: 'updated', ...lifecycle, status: String(item.status) },
        });
      return out;
    }
    if (kind === 'compaction') {
      if (!ended) return status({ itemKind: kind });
      tracked.completed = true;
      return [
        {
          ...base,
          kind: 'session_compact',
          timestamp: now,
          compactionSource: 'muse',
          raw: {
            method,
            outcome: str(item.outcome),
            trigger: str(item.trigger),
            tokensBefore: item.tokensBefore,
            tokensAfter: item.tokensAfter,
          },
        },
      ];
    }
    if (kind === 'reminderChild' || kind === 'workflow') {
      // Muse's own background agents (skill, goal and verify reminders; workflows): tasks, never
      // part of an admission's content.
      const { admissionId: _admission, ...rest } = base;
      const description =
        str(item.reminderAgentId) ?? str(item.label) ?? str(item.entryId) ?? undefined;
      const lifecycle = {
        taskId: str(item.childSessionId) ?? str(item.workflowRunId) ?? itemId,
        taskType: kind === 'reminderChild' ? 'muse-reminder' : 'muse-workflow',
        ...(description ? { description } : {}),
      };
      const taskBase = { ...rest, unattributedReason: 'task' as const };
      if (!tracked.started) {
        tracked.started = true;
        out.push({
          ...taskBase,
          kind: 'task',
          timestamp: now,
          task: { phase: 'started', ...lifecycle },
        });
      }
      if (ended) {
        tracked.completed = true;
        const summary = str(item.finalSummary) ?? str(object(item.result)?.summary);
        out.push({
          ...taskBase,
          kind: 'task',
          timestamp: now,
          task: {
            phase: 'ended',
            ...lifecycle,
            status: String(item.status),
            ...(summary ? { summary } : {}),
          },
        });
      }
      return out.length ? out : status({ itemKind: kind });
    }
    if (done) tracked.completed = true;
    return status({ itemKind: kindLabel(item), status: str(item.status) });
  }

  private _settle(map: Map<string, AbortController>, id: string | undefined, prefix = false) {
    if (!id) return;
    for (const [key, controller] of map)
      if (key === id || (prefix && key.startsWith(`${id}:`))) {
        controller.abort();
        map.delete(key);
      }
  }

  // ---------------------------------------------------------------------------
  // Approvals → gates (stage `permission`); questions → onUserInput
  // ---------------------------------------------------------------------------

  private async _approval(request: ApprovalRequest): Promise<ApprovalDecisionInput> {
    const choices = request.availableChoices;
    const allow = choices.find((c) => c.decision === 'approved' && c.scope === 'once');
    const deny =
      choices.find((c) => c.decision === 'denied' && c.scope === 'once') ??
      choices.find((c) => c.decision === 'abort');
    const stage = request.currentRequirementId?.sourceIndex ?? 0;
    const key = `${request.approvalId}:${stage}`;
    const controller = new AbortController();
    this._approvals.get(key)?.abort();
    this._approvals.set(key, controller);
    // An approval can outrun our turn/start answer; attribute it once the answer names our turn.
    await this._ackDue;
    const a = this._inflight?.evidence;
    const identity =
      a && a.identity.turnId === request.turnId
        ? { ...a.identity, admissionId: a.admissionId, itemId: request.itemId }
        : {
            nativeSessionId: request.sessionId,
            turnId: request.turnId,
            correlation: 'unknown' as const,
            unattributedReason: 'foreign-turn' as const,
          };
    this._emit({
      ...identity,
      kind: 'native_status',
      timestamp: Date.now(),
      raw: { type: 'approval-request', toolName: request.toolName, stage },
    });
    const decision = await this._gates.decide({
      stage: 'permission',
      toolName: request.toolName,
      ...mcpToolParts(request.toolName),
      toolInput: Object.freeze(approvalInput(request)),
      callId: request.toolCallId,
      ...(a && a.identity.turnId === request.turnId ? { admissionId: a.admissionId } : {}),
      ...(request.reviewerReason ? { description: request.reviewerReason } : {}),
      ...(request.subagentOrigin ? { agentId: request.subagentOrigin.subagentId } : {}),
      signal: controller.signal,
    });
    if (this._approvals.get(key) === controller) this._approvals.delete(key);
    const accepted = decision?.behavior === 'allow' && !controller.signal.aborted && !!allow;
    const choice = accepted ? allow : deny;
    if (!choice) {
      this._emit({
        ...identity,
        kind: 'error',
        timestamp: Date.now(),
        text: `Muse offered no approve-once or reject choice for ${request.toolName}; the approval stays open`,
        raw: { type: 'approval-unanswerable', choices: choices.map((c) => c.decision) },
      });
      throw new Error('Muse offered no approve-once or reject choice');
    }
    const feedback =
      !accepted && decision?.behavior === 'deny' && choice.acceptsFeedback
        ? decision.message
        : undefined;
    this._emit({
      ...identity,
      kind: 'native_status',
      timestamp: Date.now(),
      raw: {
        type: 'approval-response',
        toolName: request.toolName,
        stage,
        decision: accepted ? 'approve-once' : choice.decision,
      },
    });
    return { choiceId: choice.choiceId, ...(feedback ? { feedback } : {}) };
  }

  private _approvalFailure(failure: ApprovalFailure): void {
    this._emit({
      kind: 'native_status',
      timestamp: Date.now(),
      nativeSessionId: this._externalSessionId,
      correlation: 'unknown',
      unattributedReason: 'unrecognized-event',
      raw: { type: 'approval-failure', failure: failure.kind, approvalId: failure.approvalId },
    });
  }

  private _question(params: Record<string, unknown>): void {
    const userInputId = str(params.userInputId);
    const sessionId = str(params.sessionId);
    if (!userInputId || !sessionId || this._askedInputs.has(userInputId)) return;
    this._askedInputs.add(userInputId);
    const controller = new AbortController();
    this._userInputs.set(userInputId, controller);
    const turnId = str(params.turnId);
    const questions = Array.isArray(params.questions)
      ? (params.questions as MuseUserInputQuestion[])
      : [];
    const connection = this._host?.connection;
    const handler = this._userInputHandler;
    let identity: EventBase = {
      nativeSessionId: sessionId,
      ...(turnId ? { turnId } : {}),
      correlation: 'unknown',
      unattributedReason: 'task',
    };
    const emit = (type: string, extra: Record<string, unknown> = {}) =>
      this._emit({
        ...identity,
        kind: 'native_status',
        timestamp: Date.now(),
        raw: { type, userInputId, questions: questions.length, ...extra },
      });
    void (async () => {
      // A question can outrun our turn/start answer; attribute it once the answer names our turn.
      // One from a turn Muse started itself is a task's, like the rest of that turn.
      await this._ackDue;
      const a = this._inflight?.evidence;
      const owned = !!a && !!turnId && a.identity.turnId === turnId;
      if (owned) identity = { ...a.identity, admissionId: a.admissionId };
      emit('question-request');
      let answers: readonly MuseUserInputAnswer[] | undefined;
      let reason = 'No client handler answers Muse questions in this session';
      if (handler)
        try {
          answers = await handler({
            userInputId,
            ...(turnId ? { turnId } : {}),
            ...(str(params.toolName) ? { toolName: str(params.toolName) } : {}),
            questions: retainEvidence(questions),
            ...(owned ? { admissionId: a.admissionId } : {}),
            signal: controller.signal,
          });
          if (!answers?.length) reason = 'The client declined to answer';
        } catch (error) {
          answers = undefined;
          reason =
            `The client could not answer: ${error instanceof Error ? error.message : String(error)}`.slice(
              0,
              300,
            );
        }
      if (controller.signal.aborted || !connection || !this._alive) return;
      try {
        if (answers?.length) {
          await connection.command('userInput/answer', { sessionId, userInputId, answers });
          emit('question-answered');
        } else {
          await connection.command('userInput/cancel', {
            sessionId,
            userInputId,
            reason,
          });
          emit('question-cancelled', { reason });
        }
      } catch (error) {
        emit('question-failed', { kind: error instanceof MspError ? error.kind : 'transport' });
      } finally {
        if (this._userInputs.get(userInputId) === controller) this._userInputs.delete(userInputId);
      }
    })();
  }

  // ---------------------------------------------------------------------------
  // Account limits, native interrupt, steer
  // ---------------------------------------------------------------------------

  /** usage/read — no model turn. Undefined until Meta has reported windows on this host. */
  async readLimits(opts?: { timeoutMs?: number }): Promise<LimitSnapshot | undefined> {
    if (!this._host || !this._alive) throw Error('Session not running');
    const result = await bounded(
      this._host.connection.command('usage/read', {}),
      opts?.timeoutMs ?? 10_000,
      'usage/read timed out',
    );
    const snapshot = museLimitSnapshot(result, 'poll');
    if (snapshot) this._emit(this._limitEvent(snapshot));
    return snapshot;
  }

  /** turn/interrupt for the owned turn: "acknowledged" once its own terminal arrives. */
  async interruptNative(opts?: { timeoutMs?: number }): Promise<NativeInterruptOutcome> {
    const a = this._inflight?.evidence;
    const sessionId = this._externalSessionId;
    if (
      a?.dispatch !== 'attempted' ||
      a.nativeOutcome !== 'unknown' ||
      !a.identity.turnId ||
      !sessionId ||
      !this._host
    )
      return 'no-turn';
    const deadline = Date.now() + (opts?.timeoutMs ?? 5_000);
    try {
      await bounded(
        this._host.connection.command('turn/interrupt', { sessionId, turnId: a.identity.turnId }),
        Math.max(1, deadline - Date.now()),
        'turn/interrupt timed out',
      );
    } catch {
      return 'unacknowledged';
    }
    while (a.nativeOutcome === 'unknown' && this._alive && Date.now() < deadline)
      await Bun.sleep(10);
    return a.nativeOutcome === 'unknown' ? 'unacknowledged' : 'acknowledged';
  }

  /** Mid-turn steer (turn/steer) into the owned in-flight turn; otherwise records push_ignored. */
  async push(payload: { kind: string; text: string }): Promise<void> {
    const a = this._inflight?.evidence;
    const sessionId = this._externalSessionId;
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
      !sessionId ||
      !this._host
    )
      return ignored('no owned in-flight turn');
    const identity = { ...a.identity, admissionId: a.admissionId };
    try {
      await bounded(
        this._host.connection.command('turn/steer', {
          sessionId,
          expectedTurnId: a.identity.turnId,
          input: [{ type: 'text', text: payload.text }],
        }),
        10_000,
        'turn/steer unanswered',
      );
      this._emit({
        ...identity,
        kind: 'native_status',
        timestamp: Date.now(),
        raw: { type: 'push-steered', kind: payload.kind },
      });
    } catch (error) {
      // A refusal is the runtime's answer; no answer leaves delivery unknown, never "ignored".
      if (error instanceof MspError) ignored(`turn/steer refused: ${error.message.slice(0, 200)}`);
      else
        this._emit({
          ...identity,
          kind: 'native_status',
          timestamp: Date.now(),
          raw: { type: 'push-unknown', kind: payload.kind },
        });
    }
  }
}

// ---------------------------------------------------------------------------
// Default host: `muse serve` through the SDK's owned-process handshake
// ---------------------------------------------------------------------------

async function spawnMuseHost(launch: MuseLaunch): Promise<MuseHost> {
  const handshake = spawnMspConnection({
    command: launch.museBin,
    args: launch.args,
    cwd: launch.cwd,
    env: launch.env,
    shutdownTimeoutMs: 10_000,
  });
  try {
    const spawned = await bounded(
      handshake.initialize(launch.initialize),
      STARTUP_TIMEOUT_MS,
      `muse serve did not initialize within ${STARTUP_TIMEOUT_MS}ms`,
    );
    return {
      connection: spawned.connection,
      initializeResult: spawned.initializeResult,
      exited: spawned.exited,
      stderrTail: () => handshake.child.stderrTail,
      close: () => spawned.close(),
    };
  } catch (error) {
    await handshake.close().catch(() => undefined);
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TOOL_KINDS = new Set(['toolCall', 'userShell', 'webSearch']);
/** The item that says what woke a turn Muse started itself, and the task type it gives that turn. */
const MUSE_TRIGGERS: Readonly<Record<string, string>> = {
  scheduledFire: 'cron',
  monitorFeed: 'monitor',
  backgroundTerminalCompletion: 'background-terminal',
  overdueNotice: 'overdue',
  userMessage: 'message',
};
/** A monitor wake turn carries no feed item (feeds sit outside turns); its first answer names the source. */
const wakeSources = (item: Record<string, unknown>): string[] =>
  Array.isArray(item.wakeSourceDescriptions)
    ? item.wakeSourceDescriptions.filter((d): d is string => typeof d === 'string' && !!d)
    : [];
function museTrigger(item: Record<string, unknown>): string | undefined {
  return MUSE_TRIGGERS[String(item.kind)] ?? (wakeSources(item).length ? 'monitor' : undefined);
}
function triggerDescription(item: Record<string, unknown>): string | undefined {
  if (item.kind === 'agentMessage' && wakeSources(item).length) return wakeSources(item).join('; ');
  switch (item.kind) {
    case 'scheduledFire':
      return str(item.jobId) ? `cron job ${item.jobId}` : 'cron job';
    case 'monitorFeed':
      return str(item.monitorDescription);
    case 'userMessage':
      return 'a message sent by another client of this session';
    default:
      return str(item.fallbackText);
  }
}
const TERMINAL_ITEM = new Set(['completed', 'failed', 'cancelled', 'rejected', 'timedOut']);
const KNOWN_KINDS = new Set([
  'userMessage',
  'agentMessage',
  'reasoning',
  'toolCall',
  'userShell',
  'subagent',
  'workflow',
  'reminderChild',
  'compaction',
  'hookRun',
  'sideChat',
  'webSearch',
  'monitorFeed',
  'damagedRange',
  'scheduledFire',
  'backgroundTerminalCompletion',
  'overdueNotice',
  'earlierHistory',
]);

const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
const str = (value: unknown): string | undefined =>
  typeof value === 'string' && value ? value : undefined;
/** A known item kind, or `unsupported`: unknown values are not safe labels. */
const kindLabel = (item: Record<string, unknown>) =>
  KNOWN_KINDS.has(String(item.kind)) ? String(item.kind) : 'unsupported';

function bounded<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

function toolIdentity(
  kind: string,
  item: Record<string, unknown>,
): Pick<SessionEvent, 'toolName' | 'toolServer' | 'toolMethod' | 'callId'> {
  const toolName =
    kind === 'userShell' ? 'shell' : kind === 'webSearch' ? 'web_search' : (str(item.tool) ?? kind);
  return {
    toolName,
    ...mcpToolParts(toolName),
    ...(str(item.callId) ? { callId: str(item.callId) } : {}),
  };
}

function toolInput(
  kind: string,
  item: Record<string, unknown>,
): Pick<SessionEvent, 'toolInput' | 'toolInputOmitted'> {
  if (kind === 'userShell' && str(item.commandText))
    return { toolInput: { command: item.commandText } };
  const args = parseArgs(item.args);
  if (args) return { toolInput: args };
  return {
    toolInputOmitted:
      typeof item.args === 'string' ? 'Native arguments are not a JSON object' : 'No arguments',
  };
}

function parseArgs(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    return object(JSON.parse(value));
  } catch {
    return undefined;
  }
}

/** What a gate sees of an approval: the call's arguments, what Muse asks about, and which stage. */
function approvalInput(request: ApprovalRequest): Record<string, unknown> {
  const subject = request.subject;
  const stage = subject.stages?.find(
    (s) => s.requirementId.sourceIndex === request.currentRequirementId.sourceIndex,
  );
  const pick = <K extends keyof typeof subject>(...keys: K[]) =>
    Object.fromEntries(keys.flatMap((k) => (subject[k] !== undefined ? [[k, subject[k]]] : [])));
  return {
    ...(parseArgs(request.rawArgs) ?? {}),
    approval: {
      ...pick('kind', 'command', 'path', 'access', 'host', 'port', 'protocol', 'target'),
      ...(stage
        ? { argv: [...stage.argv], position: stage.position, totalStages: stage.totalStages }
        : {}),
      protectedWrite: request.protectedWrite,
    },
  };
}

/** Muse per-request usage: input includes cached reads and writes, reasoning is part of output. */
function museTokens(value: unknown): SessionTokens | undefined {
  const usage = object(value);
  const count = (v: unknown) =>
    typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : undefined;
  const input = count(usage?.inputTokens),
    output = count(usage?.outputTokens);
  if (!usage || input === undefined || output === undefined) return undefined;
  const cacheRead = count(usage.cacheReadTokens) ?? count(usage.cachedTokens) ?? 0;
  const cacheWrite = count(usage.cacheWriteTokens) ?? 0;
  const thinking = count(usage.reasoningTokens);
  return {
    input: Math.max(0, input - cacheRead - cacheWrite),
    output,
    cacheRead,
    cacheWrite,
    ...(thinking !== undefined ? { thinking } : {}),
    providerUsage: usage,
  };
}

function addTokens(total: SessionTokens | undefined, next: SessionTokens): SessionTokens {
  if (!total) {
    const { providerUsage: _raw, ...first } = next;
    return first;
  }
  const sum = (x?: number, y?: number) =>
    x === undefined && y === undefined ? undefined : (x ?? 0) + (y ?? 0);
  const thinking = sum(total.thinking, next.thinking);
  return {
    input: total.input + next.input,
    output: total.output + next.output,
    cacheRead: sum(total.cacheRead, next.cacheRead),
    cacheWrite: sum(total.cacheWrite, next.cacheWrite),
    ...(thinking !== undefined ? { thinking } : {}),
  };
}
