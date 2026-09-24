// ---------------------------------------------------------------------------
// CodexPrimedSessions — primed decision sessions on one warm `codex app-server`
// ---------------------------------------------------------------------------
//
// One process per account hosts every key's session as its own thread:
//
//   prime   thread/start (persisted; role instructions as developer instructions)
//           + one primer turn carrying the stable context as user-role data.
//           The primed thread is the key's live session and its cached prefix.
//   decide  thread/fork (ephemeral, through the primer turn, same instructions)
//           + turn/start with the cycle input, then thread/unsubscribe.
//           The primed thread never receives a decision, so each cycle starts
//           from exactly the primed state. Decisions on one key run concurrently.
//   miss    no primed session for this context yet: the decision runs inline on
//           a fresh thread (context + input) and priming happens in the
//           background, never on the decision's critical path. A key whose
//           primed context is replaced before it ever served is volatile and
//           primes only once its context repeats.
//   evict   thread/delete of the primed thread.
//
// Verified against codex-cli 0.155.1: ephemeral threads refuse rollback and
// fork, and persisted threads refuse thread/rollback ("paginated threads"), so
// reset is a fork of a persisted primed thread. Forks must restate the
// instructions or they run on Codex's default base prompt and miss the cache.
//
// Text-only: tool features and plugins are disabled at launch; MCP servers,
// notify hooks and tool/environment instructions are disabled per thread;
// threads run read-only with approvals "never". Any non-text item,
// MCP server startup or server request on a decision thread is a violation:
// the turn is interrupted and the process recycled.
// ---------------------------------------------------------------------------

import { JsonRpcConnection, JsonRpcError } from "./json-rpc";
import type { PipedSubprocess } from "./codex-session";
import type { SessionTokens } from "./harness-session";
import { codexLimitSnapshot, mergeLimits, type LimitSnapshot } from "./limits";
import {
  DecisionError, primeHash, Slots,
  type DecisionRequest, type DecisionResult, type PrimedEvent, type PrimedSessions, type PrimedSnapshot, type PrimeSpec,
} from "./primed";

/** Codex features a decision never needs; same surface Foundry disables for `codex exec` decisions. */
export const CODEX_DECISION_DISABLED_FEATURES: readonly string[] = [
  "shell_tool", "unified_exec", "apps", "plugins", "remote_plugin", "browser_use", "browser_use_external",
  "computer_use", "image_generation", "memories", "multi_agent", "goals", "hooks", "view_image", "sleep_tool",
  "skill_search", "tool_suggest", "shell_snapshot", "skill_mcp_dependency_install", "workspace_dependencies",
  "in_app_browser", "in_app_local_automation", "personality", "mentions_v2",
];

/**
 * Per-thread configuration for decisions: no notify hook, no built-in MCP server,
 * no project docs or skills, and none of the instruction surfaces that describe
 * tools or the environment. Applied on thread/start and thread/fork (verified
 * equivalent to launch-level `-c` overrides), so the launch argv carries only
 * approval, web-search and feature flags that credential launchers accept.
 */
export const CODEX_DECISION_THREAD_CONFIG: Readonly<Record<string, unknown>> = Object.freeze({
  notify: [], "mcp_servers.node_repl.enabled": false, project_doc_max_bytes: 0, "skills.enabled": false,
  include_permissions_instructions: false, include_environment_context: false, include_apps_instructions: false,
  include_apps_usage_instructions: false, include_collaboration_mode_instructions: false,
  include_plugin_usage_instructions: false, include_skills_usage_instructions: false,
});

/** `codex app-server` argv (without the binary) for tool-free decision sessions. */
export function codexDecisionLaunchArgs(): string[] {
  return ["app-server", "--listen", "stdio://", "-c", 'approval_policy="never"', "-c", 'web_search="disabled"',
    ...CODEX_DECISION_DISABLED_FEATURES.flatMap(feature => ["--disable", feature])];
}

const TEXT_ITEMS = new Set(["userMessage", "agentMessage", "reasoning"]);
const PRIMER_SUFFIX = "\n\nThe above is standing context for the decisions that follow. Reply with OK only.";
const DEFAULT_BASE = "You are a text-only decision function. Use only the supplied instructions and context. "
  + "You have no tools. Return exactly the requested answer, with no preamble.";
const VALID_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];

export interface CodexPrimedConfig {
  /** Path to the codex binary. Default "codex". */
  bin?: string;
  model: string;
  effort?: string;
  /** Private, otherwise empty working directory. It also identifies this host's threads for orphan cleanup. */
  cwd: string;
  /** Replaces Codex's own base instructions for every session. */
  baseInstructions?: string;
  /** Merged over process.env. OPENAI_API_KEY / CODEX_API_KEY are always removed. */
  env?: Record<string, string | undefined>;
  /**
   * Process launcher (tests, containers, credential-lock wrappers). May be async;
   * a rejection fails the decision before dispatch.
   */
  spawn?: (cmd: string[], opts: { cwd: string; env: Record<string, string | undefined> }) => PipedSubprocess | Promise<PipedSubprocess>;
  /** Concurrent decision turns across all keys. Default 8. */
  maxConcurrent?: number;
  /** Primed sessions kept live; the least recently used idle key is evicted beyond this. Default 256. */
  maxSessions?: number;
  /** Evict keys idle longer than this. Default 30 min. */
  idleMs?: number;
  /** Default decision deadline including wait and priming. Default 30 s. */
  timeoutMs?: number;
  /** Require a ChatGPT subscription login (account/read). Default true. */
  requireSubscription?: boolean;
  /** Delete primed threads left in `cwd` by a crashed host at process start. Default true. */
  sweepOrphans?: boolean;
  /** Background primer turns at once, outside the decision slots. Default 2. */
  maxBackgroundPrimes?: number;
  /**
   * Hedge a slow decision: when it has not finished after this many ms, the same
   * input starts on a second branch, the first to finish wins and the other is
   * interrupted. Cuts backend tail latency at the cost of a duplicate request for
   * the slow fraction. Off when omitted.
   */
  hedgeAfterMs?: number;
  /**
   * Codex service tier for decision threads (e.g. "fast"). Measured on gpt-6-luna: p50 2.23 s vs 2.52 s
   * with no tier, and a tighter tail. May consume subscription usage faster; off when omitted.
   */
  serviceTier?: string;
  clientName?: string;
  onEvent?: (event: PrimedEvent) => void;
}

interface Primed {
  readonly key: string;
  readonly hash: string;
  readonly generation: number;
  readonly baseThreadId: string;
  readonly primedTurnId?: string;
  model?: string;
  lastUsed: number;
  /** Decisions currently forked from this session. */
  inUse: number;
  servedWarm: boolean;
  /** Replaced or evicted while in use: deleted when the last decision finishes. */
  stale?: "idle" | "capacity" | "reprime" | "requested" | "close";
}

interface KeyState {
  lastHash?: string;
  volatile: boolean;
  priming?: { hash: string; done: Promise<void> };
}

interface Branch {
  readonly key: string;
  /** The process this branch's thread lives on; only its notifications and loss apply. */
  readonly conn: JsonRpcConnection;
  turnId?: string;
  text?: string;
  finalText?: string;
  partial: string;
  usage?: Record<string, unknown>;
  violation?: string;
  error?: string;
  terminal?: { status: string; error?: Record<string, unknown> };
  lost?: boolean;
  /** Resolves on the native terminal. */
  done: Promise<void>;
  finish(): void;
  /** Resolves on the terminal, a violation or process loss. */
  attention: Promise<void>;
  wake(): void;
}

const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const count = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

/** Codex `tokenUsage.last` → SessionTokens. Codex input includes cached input; ours excludes it. */
export function codexTokens(last: Record<string, unknown> | undefined): SessionTokens | undefined {
  const input = count(last?.inputTokens), output = count(last?.outputTokens);
  if (input === undefined || output === undefined) return undefined;
  const cached = count(last?.cachedInputTokens), reasoning = count(last?.reasoningOutputTokens);
  return { input: input - Math.min(cached ?? 0, input), output, ...(cached !== undefined ? { cacheRead: cached } : {}),
    ...(reasoning !== undefined ? { thinking: reasoning } : {}), providerUsage: { ...last } };
}

function failureReason(error: Record<string, unknown> | undefined): "rate-limited" | "auth" | "native-failed" {
  const info = error?.codexErrorInfo;
  if (info === "usageLimitExceeded" || info === "rateLimitExceeded") return "rate-limited";
  if (info === "unauthorized") return "auth";
  return /rate.?limit|usage.?limit|too many requests|\b429\b/i.test(String(error?.message ?? "")) ? "rate-limited" : "native-failed";
}

export class CodexPrimedSessions implements PrimedSessions {
  readonly runtime = "codex" as const;
  private readonly _config: Required<Pick<CodexPrimedConfig, "bin" | "maxConcurrent" | "maxSessions" | "idleMs" | "timeoutMs" | "requireSubscription" | "sweepOrphans" | "clientName" | "baseInstructions">> & CodexPrimedConfig;
  private _conn?: JsonRpcConnection;
  private _starting?: Promise<JsonRpcConnection>;
  private _generation = 0;
  private _sessions = new Map<string, Primed>();
  private _keys = new Map<string, KeyState>();
  private _branches = new Map<string, Branch>();
  private _slots: Slots;
  private _primeSlots: Slots;
  private _limits?: LimitSnapshot;
  private _lastPoll = 0;
  private _closed = false;
  private _failures: number[] = [];
  private _idleTimer?: ReturnType<typeof setInterval>;

  constructor(config: CodexPrimedConfig) {
    const bin = config.bin ?? "codex";
    if (!/^[a-zA-Z0-9_.\/\\-]+$/.test(bin)) throw Error(`Invalid codex CLI binary path: "${bin}"`);
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}$/.test(config.model)) throw Error("Invalid decision model");
    if (config.effort !== undefined && !VALID_EFFORTS.includes(config.effort)) throw Error(`Invalid codex effort "${config.effort}"`);
    if (!config.cwd?.startsWith("/")) throw Error("Primed Codex sessions require an absolute private working directory");
    this._config = { ...config, bin, maxConcurrent: config.maxConcurrent ?? 8, maxSessions: config.maxSessions ?? 256,
      idleMs: config.idleMs ?? 30 * 60_000, timeoutMs: config.timeoutMs ?? 30_000, requireSubscription: config.requireSubscription ?? true,
      sweepOrphans: config.sweepOrphans ?? true, clientName: config.clientName ?? "agent-session-primed",
      baseInstructions: config.baseInstructions ?? DEFAULT_BASE };
    for (const [name, value] of [["maxSessions", this._config.maxSessions], ["idleMs", this._config.idleMs], ["timeoutMs", this._config.timeoutMs]] as const)
      if (!Number.isSafeInteger(value) || value < 1) throw Error(`${name} must be a positive integer`);
    this._slots = new Slots(this._config.maxConcurrent);
    this._primeSlots = new Slots(config.maxBackgroundPrimes ?? 2);
  }

  /** Start the process ahead of the first decision (optional). */
  async start(): Promise<void> { await this._process(); }

  limits(): LimitSnapshot | undefined { return this._limits; }

  snapshot(): PrimedSnapshot {
    return { runtime: "codex", closed: this._closed, generation: this._generation, processAlive: !!this._conn && !this._conn.closed,
      sessions: this._sessions.size, active: this._slots.active, waiting: this._slots.waiting, ...(this._limits ? { limits: this._limits } : {}) };
  }

  /** Poll account limits without a model turn. */
  async readLimits(opts?: { timeoutMs?: number }): Promise<LimitSnapshot | undefined> {
    const conn = await this._process();
    const snapshot = codexLimitSnapshot(await conn.request("account/rateLimits/read", { excludeResetCreditDetails: true }, opts?.timeoutMs ?? 15_000), "poll");
    this._lastPoll = Date.now();
    if (snapshot) this._observeLimits(snapshot);
    return this._limits;
  }

  decide(spec: PrimeSpec, request: DecisionRequest): Promise<DecisionResult> {
    if (this._closed) return Promise.reject(new DecisionError("Primed sessions closed", "closed", "not-dispatched", true));
    if (!spec.key || typeof spec.instructions !== "string" || typeof request.input !== "string")
      return Promise.reject(new DecisionError("Invalid decision request", "admission", "not-dispatched", true));
    const started = Date.now(), deadline = started + (request.timeoutMs ?? this._config.timeoutMs);
    return (async () => {
      const release = await this._slots.acquire(deadline, request.signal);
      try { return await this._decide(spec, request, started, deadline); }
      finally { release(); }
    })();
  }

  /**
   * Prime a key ahead of its first decision (e.g. when a thread starts). Resolves
   * when the primed session is installed; a failure leaves the key unprimed.
   */
  async prime(spec: PrimeSpec): Promise<void> {
    if (this._closed || !spec.context) return;
    const conn = await this._process();
    const hash = primeHash(spec), state = this._keyState(spec.key);
    state.lastHash = hash;
    const current = this._sessions.get(spec.key);
    if (current && current.hash === hash && current.generation === this._generation) return;
    await this._primeInBackground(conn, spec, hash, state, true);
  }

  async evict(key: string): Promise<void> {
    this._keys.delete(key);
    const s = this._sessions.get(key);
    if (s) await this._drop(s, "requested");
  }

  async close(): Promise<void> {
    if (this._closed) return;
    this._closed = true;
    clearInterval(this._idleTimer);
    const closed = new DecisionError("Primed sessions closed", "closed", "not-dispatched", true);
    this._slots.drain(closed);
    this._primeSlots.drain(closed);
    const conn = this._conn;
    await Promise.race([Promise.all([...this._sessions.values()].map(s => this._drop(s, "close"))), Bun.sleep(2_000)]);
    this._conn = undefined;
    if (conn) { conn.kill(); await Promise.race([conn.exited.catch(() => 0), Bun.sleep(2_000)]); }
  }

  // -------------------------------------------------------------------------

  private _emit(event: PrimedEvent): void { try { this._config.onEvent?.(event); } catch { /* observers cannot change decisions */ } }

  private _observeLimits(snapshot: LimitSnapshot): void {
    this._limits = mergeLimits(this._limits, snapshot);
    this._emit({ type: "limits", limits: this._limits });
  }

  /** Refuse before dispatch while the account reports ordinary usage blocked. */
  private async _checkLimits(): Promise<void> {
    if (!this._limits?.blocked) return;
    const now = Date.now();
    const resets = this._limits.windows.filter(w => w.usedPercent >= 100 && w.resetsAt).map(w => w.resetsAt!);
    if (resets.length && now >= Math.max(...resets)) { this._limits = { ...this._limits, blocked: false }; return; }
    if (now - this._lastPoll >= 60_000) { try { await this.readLimits({ timeoutMs: 5_000 }); } catch { /* keep the blocked view */ } }
    if (this._limits?.blocked) throw new DecisionError("Codex subscription usage limit reached; no fallback", "rate-limited", "not-dispatched", true);
  }

  private _env(): Record<string, string | undefined> {
    const env: Record<string, string | undefined> = { ...process.env, ...this._config.env, DISABLE_AUTOUPDATER: "1" };
    delete env.OPENAI_API_KEY; delete env.CODEX_API_KEY;
    for (const key of Object.keys(env)) if (env[key] === undefined) delete env[key];
    return env;
  }

  private _process(): Promise<JsonRpcConnection> {
    if (this._closed) return Promise.reject(new DecisionError("Primed sessions closed", "closed", "not-dispatched", true));
    if (this._conn && !this._conn.closed) return Promise.resolve(this._conn);
    if (this._starting) return this._starting;
    const now = Date.now();
    this._failures = this._failures.filter(t => now - t < 60_000);
    if (this._failures.length >= 3)
      return Promise.reject(new DecisionError("Codex app-server failed repeatedly; paused for up to 60 s", "transport", "not-dispatched", true));
    const generation = ++this._generation, t0 = performance.now();
    this._starting = (async () => {
      await null; // settle only after `_starting` is assigned, so failures never stay cached
      const argv = [this._config.bin, ...codexDecisionLaunchArgs()];
      const options = { cwd: this._config.cwd, env: this._env() };
      let proc: PipedSubprocess;
      try {
        proc = this._config.spawn ? await this._config.spawn(argv, options)
          : Bun.spawn(argv, { ...options, stdin: "pipe", stdout: "pipe", stderr: "pipe" }) as unknown as PipedSubprocess;
      } catch (error) {
        this._failures.push(Date.now());
        this._starting = undefined;
        throw new DecisionError(`Codex app-server launch refused: ${(error as Error).message}`, "transport", "not-dispatched", true, undefined, { cause: error });
      }
      const conn = new JsonRpcConnection(proc, {
        onNotification: (method, params) => this._notification(conn, method, params),
        onRequest: (_id, _method, params) => { this._serverRequest(conn, params); return false; },
        onClose: () => this._lost(conn, generation),
      });
      try {
        await conn.request("initialize", { clientInfo: { name: this._config.clientName, version: "0.2.0" }, capabilities: {} }, 15_000);
        conn.notify("initialized");
        if (this._config.requireSubscription) {
          const account = object(object(await conn.request("account/read", {}, 15_000))?.account);
          if (account?.type !== "chatgpt")
            throw new DecisionError("Codex decisions require a ChatGPT subscription login; API-key login refused", "auth", "not-dispatched", true);
        }
        try {
          const limits = codexLimitSnapshot(await conn.request("account/rateLimits/read", { excludeResetCreditDetails: true }, 15_000), "poll");
          this._lastPoll = Date.now();
          if (limits) this._observeLimits(limits);
        } catch { /* limits are advisory at start */ }
        if (this._config.sweepOrphans) await this._sweep(conn);
        if (this._closed) throw new DecisionError("Primed sessions closed", "closed", "not-dispatched", true);
        this._conn = conn;
        this._idleTimer ??= setInterval(() => void this._evictIdle(), Math.min(this._config.idleMs, 60_000));
        (this._idleTimer as { unref?: () => void }).unref?.();
        this._emit({ type: "process-started", generation, ms: Math.round(performance.now() - t0) });
        return conn;
      } catch (error) {
        conn.kill();
        this._failures.push(Date.now());
        if (error instanceof DecisionError) throw error;
        throw new DecisionError(`Codex app-server start failed: ${(error as Error).message}`, "transport", "not-dispatched", true, undefined, { cause: error });
      } finally { this._starting = undefined; }
    })();
    return this._starting;
  }

  /** Delete persisted primed threads a crashed host left in this private directory. */
  private async _sweep(conn: JsonRpcConnection): Promise<void> {
    let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      const listed = object(await conn.request("thread/list", { cwd: this._config.cwd, sourceKinds: ["appServer"],
        originators: [this._config.clientName], limit: 100, ...(cursor ? { cursor } : {}) }, 15_000).catch(() => undefined));
      const data = Array.isArray(listed?.data) ? listed.data : [];
      for (const entry of data) {
        const id = object(entry)?.id;
        if (typeof id === "string" && id && object(entry)?.cwd === this._config.cwd)
          await conn.request("thread/delete", { threadId: id }, 10_000).catch(() => undefined);
      }
      const next = listed?.nextCursor;
      if (typeof next !== "string" || !next || next === cursor) return;
      cursor = next;
    }
  }

  /** A process ended (or its stdout closed): its threads and primed sessions are gone, whatever generation is current. */
  private _lost(conn: JsonRpcConnection, generation: number): void {
    if (this._conn === conn) this._conn = undefined;
    for (const session of [...this._sessions.values()]) {
      if (session.generation !== generation) continue;
      this._sessions.delete(session.key);
      this._emit({ type: "evicted", key: session.key, reason: "process-lost" });
    }
    this._wakeBranches(conn, "Native process lost");
  }

  private _wakeBranches(conn: JsonRpcConnection, error: string): void {
    for (const branch of this._branches.values()) {
      if (branch.conn !== conn || branch.terminal) continue;
      branch.error ??= error; branch.lost = true; branch.wake();
    }
  }

  /** Kill the process; true once its exit is observed (bounded wait). Every branch on it fails now, not at its deadline. */
  private _recycle(conn: JsonRpcConnection, reason: string): Promise<boolean> {
    if (this._conn === conn) { this._conn = undefined; this._emit({ type: "process-recycled", generation: this._generation, reason }); }
    this._wakeBranches(conn, `Native process recycled (${reason})`);
    conn.kill();
    return Promise.race([conn.exited.then(() => true, () => false), Bun.sleep(2_000).then(() => false)]);
  }

  private _violation(conn: JsonRpcConnection, threadId: string, branch: Branch, detail: string): void {
    if (branch.violation) return;
    branch.violation = detail;
    this._emit({ type: "violation", key: branch.key, detail });
    if (branch.turnId) void conn.request("turn/interrupt", { threadId, turnId: branch.turnId }, 2_000).catch(() => undefined);
    branch.wake();
  }

  private _serverRequest(conn: JsonRpcConnection, params: Record<string, unknown> | undefined): void {
    const threadId = typeof params?.threadId === "string" ? params.threadId : undefined;
    const branch = threadId ? this._branches.get(threadId) : undefined;
    if (branch && threadId && branch.conn === conn) this._violation(conn, threadId, branch, "server request");
  }

  private _notification(conn: JsonRpcConnection, method: string, params: Record<string, unknown> | undefined): void {
    if (method === "account/rateLimits/updated") {
      const limits = codexLimitSnapshot(params, "stream");
      if (limits) this._observeLimits(limits);
      return;
    }
    const threadId = typeof params?.threadId === "string" ? params.threadId : undefined;
    const branch = threadId ? this._branches.get(threadId) : undefined;
    if (!branch || !threadId || branch.conn !== conn) return;
    const turn = object(params?.turn), item = object(params?.item);
    switch (method) {
      case "turn/started": if (typeof turn?.id === "string") branch.turnId ??= turn.id; break;
      case "item/started": case "item/completed": {
        const type = typeof item?.type === "string" ? item.type : "unknown";
        if (!TEXT_ITEMS.has(type)) { this._violation(conn, threadId, branch, `item ${type}`); break; }
        if (method === "item/completed" && type === "agentMessage" && typeof item?.text === "string") {
          branch.text = item.text;
          if (item.phase === "final_answer") branch.finalText = item.text;
        }
        break;
      }
      case "item/agentMessage/delta": if (typeof params?.delta === "string") branch.partial += params.delta; break;
      case "thread/tokenUsage/updated": branch.usage = object(object(params?.tokenUsage)?.last); break;
      case "mcpServer/startupStatus/updated": this._violation(conn, threadId, branch, "mcp server started"); break;
      case "error": branch.error ??= typeof object(params?.error)?.message === "string" ? String(object(params?.error)?.message) : "native error"; break;
      case "turn/completed":
        if (turn && (!branch.turnId || turn.id === branch.turnId)) {
          branch.turnId ??= typeof turn.id === "string" ? turn.id : undefined;
          branch.terminal = { status: String(turn.status), ...(object(turn.error) ? { error: object(turn.error) } : {}) };
          branch.finish(); branch.wake();
        }
        break;
    }
  }

  private _branch(conn: JsonRpcConnection, threadId: string, key: string): Branch {
    let finish!: () => void, wake!: () => void;
    const done = new Promise<void>(resolve => { finish = resolve; });
    const attention = new Promise<void>(resolve => { wake = resolve; });
    const branch: Branch = { key, conn, partial: "", done, finish, attention, wake };
    this._branches.set(threadId, branch);
    return branch;
  }

  private async _startTurn(conn: JsonRpcConnection, threadId: string, branch: Branch, input: string, deadline: number, extra: Record<string, unknown>): Promise<void> {
    const response = object(await conn.request("turn/start", { threadId, input: [{ type: "text", text: input }],
      ...(this._config.effort ? { effort: this._config.effort } : {}), ...extra }, Math.max(1, deadline - Date.now())));
    const turnId = object(response?.turn)?.id;
    if (typeof turnId === "string") branch.turnId ??= turnId;
  }

  /** Interrupt a losing hedge branch and release it, off the result path. Never recycles the shared process. */
  private async _settleLoser(conn: JsonRpcConnection, threadId: string, branch: Branch, key: string): Promise<void> {
    if (!branch.terminal && !branch.lost && branch.turnId)
      await conn.request("turn/interrupt", { threadId, turnId: branch.turnId }, 2_000).catch(() => undefined);
    await Promise.race([branch.done, Bun.sleep(5_000)]);
    this._branches.delete(threadId);
    if (this._conn === conn) void conn.request("thread/unsubscribe", { threadId }, 10_000).catch(() => undefined);
    this._emit({ type: "hedge-settled", key, settled: !!branch.terminal || !!branch.lost });
  }

  /**
   * Run one turn on a thread and wait for its terminal. With a hedge, a second branch
   * starts once `hedge.afterMs` passes without an answer; the first to finish wins.
   * On deadline, interrupt and wait briefly for acknowledgment; without it, recycle
   * the process. A violation always recycles: the launch policy did not hold.
   */
  private async _turn(conn: JsonRpcConnection, threadId: string, branch: Branch, input: string, deadline: number,
    extra: Record<string, unknown>, signal?: AbortSignal,
    hedge?: { afterMs: number; open(): Promise<{ threadId: string; branch: Branch }>; key: string },
  ): Promise<{ timedOut: boolean; aborted: boolean; settled: boolean; threadId: string; branch: Branch; hedged: boolean }> {
    const remaining = () => Math.max(1, deadline - Date.now());
    await this._startTurn(conn, threadId, branch, input, deadline, extra);
    let winner = { threadId, branch }, hedged = false, second: { threadId: string; branch: Branch } | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined, hedgeTimer: ReturnType<typeof setTimeout> | undefined, onAbort: (() => void) | undefined;
    const abort = new Promise<"aborted">(resolve => { onAbort = () => resolve("aborted"); if (signal?.aborted) onAbort(); else signal?.addEventListener("abort", onAbort, { once: true }); });
    const expiry = new Promise<"timeout">(resolve => { timer = setTimeout(() => resolve("timeout"), remaining()); });
    let stop = await Promise.race([branch.attention.then(() => "attention" as const), expiry, abort,
      ...(hedge && hedge.afterMs < remaining() ? [new Promise<"hedge">(resolve => { hedgeTimer = setTimeout(() => resolve("hedge"), hedge.afterMs); })] : [])]);
    clearTimeout(hedgeTimer);
    if (stop === "hedge") {
      try {
        second = await hedge!.open();
        await this._startTurn(conn, second.threadId, second.branch, input, deadline, extra);
        hedged = true;
        this._emit({ type: "hedged", key: hedge!.key, afterMs: hedge!.afterMs });
      } catch {
        // The hedge is an optimization: if it cannot start, keep waiting on the original.
        if (second) { this._branches.delete(second.threadId); second = undefined; }
      }
      const raced = await Promise.race([branch.attention.then(() => "first" as const),
        ...(second ? [second.branch.attention.then(() => "second" as const)] : []), expiry, abort]);
      if (raced === "second") winner = second!;
      stop = raced === "first" || raced === "second" ? "attention" : raced;
    }
    clearTimeout(timer);
    if (onAbort) signal?.removeEventListener("abort", onAbort);
    const timedOut = stop === "timeout", aborted = stop === "aborted";
    const loser = second && (winner === second ? { threadId, branch } : second);
    // A violation on either branch fails the decision; both run on the process being recycled.
    if (loser && !loser.branch.violation) void this._settleLoser(conn, loser.threadId, loser.branch, hedge!.key);
    if (loser?.branch.violation) {
      winner.branch.violation ??= loser.branch.violation;
      this._branches.delete(loser.threadId); // the recycle below ends it with the process
    }
    branch = winner.branch; threadId = winner.threadId;
    let settled = !!branch.terminal;
    if (!branch.terminal && !branch.lost && branch.turnId) {
      await conn.request("turn/interrupt", { threadId, turnId: branch.turnId }, 2_000).catch(() => undefined);
      await Promise.race([branch.done, Bun.sleep(2_000)]);
      settled = !!branch.terminal;
    }
    if (branch.violation || !settled) {
      const exited = await this._recycle(conn, branch.violation ? `violation: ${branch.violation}` : "unacknowledged interrupt");
      settled ||= exited;
    }
    return { timedOut, aborted, settled, threadId, branch, hedged };
  }

  private _threadParams(instructions: string): Record<string, unknown> {
    return { model: this._config.model, cwd: this._config.cwd, approvalPolicy: "never", sandbox: "read-only",
      baseInstructions: this._config.baseInstructions, developerInstructions: instructions, config: { ...CODEX_DECISION_THREAD_CONFIG },
      ...(this._config.serviceTier ? { serviceTier: this._config.serviceTier } : {}) };
  }

  /** Run the primer on a new persisted thread. The caller decides whether to install it. */
  private async _prime(conn: JsonRpcConnection, spec: PrimeSpec, hash: string, deadline: number, signal?: AbortSignal): Promise<Primed> {
    const generation = this._generation, t0 = performance.now();
    const started = object(await conn.request("thread/start", { ...this._threadParams(spec.instructions), ephemeral: false },
      Math.max(1, deadline - Date.now())));
    const baseId = object(started?.thread)?.id;
    if (typeof baseId !== "string" || !baseId) throw new DecisionError("Codex thread/start returned no thread", "prime-failed", "not-dispatched", true);
    const branch = this._branch(conn, baseId, spec.key);
    let ok = false;
    try {
      let outcome: { timedOut: boolean; aborted: boolean; settled: boolean };
      try { outcome = await this._turn(conn, baseId, branch, `${spec.context}${PRIMER_SUFFIX}`, deadline, {}, signal); }
      catch (error) {
        // A primer turn/start without the runtime's own answer may still run: recycle before reporting.
        const settled = error instanceof JsonRpcError || await this._recycle(conn, "primer turn/start unsettled");
        throw new DecisionError(`Priming ${spec.key} failed: ${(error as Error).message}`, "prime-failed", "not-dispatched", settled, undefined, { cause: error });
      }
      ok = !outcome.timedOut && !outcome.aborted && !branch.violation && branch.terminal?.status === "completed" && !!branch.turnId;
      if (!ok) {
        const reason = branch.violation ? "violation" : outcome.aborted ? "aborted" : outcome.timedOut ? "timeout"
          : branch.terminal?.status === "failed" ? failureReason(branch.terminal.error) : branch.lost ? "transport" : "prime-failed";
        throw new DecisionError(`Priming ${spec.key} failed (${branch.violation ?? branch.terminal?.status ?? branch.error ?? "no terminal"})`,
          reason === "native-failed" ? "prime-failed" : reason, "not-dispatched", outcome.settled);
      }
    } finally {
      this._branches.delete(baseId);
      if (!ok) void conn.request("thread/delete", { threadId: baseId }, 10_000).catch(() => undefined);
    }
    const primed: Primed = { key: spec.key, hash, generation, baseThreadId: baseId, primedTurnId: branch.turnId,
      model: typeof started?.model === "string" ? started.model : undefined, lastUsed: Date.now(), inUse: 0, servedWarm: false };
    this._emit({ type: "primed", key: spec.key, hash, ms: Math.round(performance.now() - t0) });
    return primed;
  }

  private _keyState(key: string): KeyState {
    let state = this._keys.get(key);
    if (!state) { state = { volatile: false }; this._keys.set(key, state); }
    return state;
  }

  /**
   * Prime `hash` for a key off the decision path and install it if it is still the
   * key's current context. A volatile key primes only when its context repeats.
   */
  private _primeInBackground(conn: JsonRpcConnection, spec: PrimeSpec, hash: string, state: KeyState, force = false): Promise<void> {
    if (state.priming?.hash === hash) return state.priming.done;
    if (!force && state.volatile && state.lastHash !== hash) return Promise.resolve();
    let done!: Promise<void>;
    done = (async () => {
      await null; // `done` is assigned before this body runs
      let release: (() => void) | undefined;
      try {
        release = await this._primeSlots.acquire(Date.now() + this._config.timeoutMs);
        if (this._closed || this._conn !== conn || state.lastHash !== hash) return;
        await this._makeRoom(spec.key);
        const primed = await this._prime(conn, spec, hash, Date.now() + this._config.timeoutMs);
        const current = this._sessions.get(spec.key);
        // A newer context arrived, or the process changed, while priming: this one is already stale.
        if (this._closed || state.lastHash !== hash || primed.generation !== this._generation) {
          void conn.request("thread/delete", { threadId: primed.baseThreadId }, 10_000).catch(() => undefined);
          return;
        }
        if (current) this._retire(current, "reprime", state);
        this._sessions.set(spec.key, primed);
      } catch { /* priming is best-effort: decisions keep running inline */ }
      finally { release?.(); if (state.priming?.done === done) state.priming = undefined; }
    })();
    state.priming = { hash, done };
    return done;
  }

  /** Remove a session from service; delete it now, or when its last decision finishes. */
  private _retire(session: Primed, reason: NonNullable<Primed["stale"]>, state?: KeyState): void {
    if (this._sessions.get(session.key) === session) this._sessions.delete(session.key);
    // Replaced before it ever served a decision: this key's context changes faster than priming pays off.
    if (reason === "reprime" && state && !session.servedWarm) state.volatile = true;
    session.stale = reason;
    if (session.inUse === 0) void this._drop(session, reason);
  }

  private async _drop(session: Primed, reason: NonNullable<Primed["stale"]>): Promise<void> {
    if (this._sessions.get(session.key) === session) this._sessions.delete(session.key);
    this._emit({ type: "evicted", key: session.key, reason });
    const conn = this._conn;
    if (conn && session.generation === this._generation)
      await conn.request("thread/delete", { threadId: session.baseThreadId }, 10_000).catch(() => undefined);
  }

  private async _evictIdle(): Promise<void> {
    const cutoff = Date.now() - this._config.idleMs;
    for (const session of [...this._sessions.values()])
      if (session.inUse === 0 && session.lastUsed < cutoff) this._retire(session, "idle");
  }

  private async _makeRoom(except: string): Promise<void> {
    while (this._sessions.size >= this._config.maxSessions) {
      const idle = [...this._sessions.values()].filter(s => s.inUse === 0 && s.key !== except).sort((a, b) => a.lastUsed - b.lastUsed)[0];
      if (!idle) return;
      this._retire(idle, "capacity");
    }
  }

  private async _decide(spec: PrimeSpec, request: DecisionRequest, started: number, deadline: number): Promise<DecisionResult> {
    const waitMs = Date.now() - started;
    const signal = request.signal;
    const expired = () => signal?.aborted ? new DecisionError("Decision aborted before dispatch", "aborted", "not-dispatched", true)
      : new DecisionError("Decision deadline passed before dispatch", "timeout", "not-dispatched", true);
    if (Date.now() >= deadline || signal?.aborted) throw expired();
    const conn = await this._process();
    await this._checkLimits();
    const hash = primeHash(spec), state = this._keyState(spec.key);
    let session = this._sessions.get(spec.key);
    if (session && (session.hash !== hash || session.generation !== this._generation)) {
      // The context changed: the old primed session no longer matches. Retire it; prime the new one off-path.
      if (session.generation === this._generation) this._retire(session, "reprime", state);
      else this._sessions.delete(spec.key);
      session = undefined;
    }
    const prime: "warm" | "cold" = session ? "warm" : "cold", primeMs = 0;
    if (!session && spec.context) void this._primeInBackground(conn, spec, hash, state);
    state.lastHash = hash;
    if (session) { session.inUse++; session.lastUsed = Date.now(); }
    let threadId: string | undefined, admissionId: string | undefined, dispatched = false;
    // A miss runs inline: the stable context travels with this decision's input on a fresh thread.
    const input = session || !spec.context ? request.input : `${spec.context}\n\n${request.input}`;
    const params = this._threadParams(spec.instructions);
    let model = session?.model;
    /** A fresh branch for this decision: a fork of the primed state, or an inline thread. */
    const openBranch = async (): Promise<{ threadId: string; branch: Branch }> => {
      const response = object(await (session
        ? conn.request("thread/fork", { threadId: session.baseThreadId, lastTurnId: session.primedTurnId, ephemeral: true, excludeTurns: true, ...params }, Math.max(1, deadline - Date.now()))
        : conn.request("thread/start", { ...params, ephemeral: true }, Math.max(1, deadline - Date.now()))));
      const id = object(response?.thread)?.id;
      if (typeof id !== "string" || !id) throw Error("Codex returned no decision thread");
      model ??= typeof response?.model === "string" ? response.model : undefined;
      return { threadId: id, branch: this._branch(conn, id, spec.key) };
    };
    try {
      if (Date.now() >= deadline || signal?.aborted) throw expired();
      const t1 = performance.now();
      const opened = await openBranch().catch(error => {
        // A lost primed thread is recoverable: retire it and prime again off-path.
        if (session) this._retire(session, "reprime");
        throw new DecisionError(`Branching ${spec.key} failed: ${(error as Error).message}`, "transport", "not-dispatched", true, undefined, { cause: error });
      });
      threadId = opened.threadId;
      if (session) session.model ??= model;
      const branchMs = Math.round(performance.now() - t1);
      let branch = opened.branch;
      admissionId = crypto.randomUUID();
      try { await request.onAdmission?.({ admissionId, key: spec.key, runtime: "codex", threadId }); }
      catch (cause) { throw new DecisionError("Decision admission refused before dispatch", "admission", "not-dispatched", true, admissionId, { cause }); }
      if (Date.now() >= deadline || signal?.aborted) throw expired();
      if (this._conn !== conn || this._closed) throw new DecisionError("Codex process lost before dispatch", "transport", "not-dispatched", true, admissionId);
      const t2 = performance.now();
      dispatched = true;
      let outcome: Awaited<ReturnType<CodexPrimedSessions["_turn"]>>;
      const hedgeAfterMs = this._config.hedgeAfterMs;
      try {
        outcome = await this._turn(conn, threadId, branch, input, deadline, request.outputSchema ? { outputSchema: request.outputSchema } : {}, signal,
          hedgeAfterMs !== undefined ? { afterMs: hedgeAfterMs, open: openBranch, key: spec.key } : undefined);
      }
      catch (error) {
        // A JSON-RPC error is the runtime's own refusal. Anything else (timeout, loss) leaves the turn unknown until the process is gone.
        const settled = error instanceof JsonRpcError || await this._recycle(conn, "turn/start unsettled");
        throw new DecisionError(`Codex turn/start failed: ${(error as Error).message}`, "transport", "attempted", settled, admissionId, { cause: error });
      }
      const turnMs = Math.round(performance.now() - t2);
      if (outcome.threadId !== threadId) threadId = outcome.threadId; // the losing branch is settled by _settleLoser
      branch = outcome.branch;
      if (branch.violation) throw new DecisionError(`Decision violated the text-only policy (${branch.violation})`, "violation", "attempted", outcome.settled, admissionId);
      if (outcome.aborted && !branch.terminal) throw new DecisionError("Decision aborted; turn interrupted", "aborted", "attempted", outcome.settled, admissionId);
      if (outcome.timedOut && !branch.terminal) throw new DecisionError("Decision deadline passed; turn interrupted", "timeout", "attempted", outcome.settled, admissionId);
      if ((outcome.aborted || outcome.timedOut) && branch.terminal?.status === "interrupted")
        throw new DecisionError(`Decision ${outcome.aborted ? "aborted" : "deadline passed"}; turn interrupted`, outcome.aborted ? "aborted" : "timeout", "attempted", true, admissionId);
      const terminal = branch.terminal;
      const content = branch.finalText ?? branch.text;
      if (terminal?.status !== "completed" || content === undefined) {
        const reason = terminal?.status === "failed" ? failureReason(terminal.error) : branch.error && !terminal ? "transport" : "native-failed";
        if (reason === "rate-limited") this._observeLimits({ runtime: "codex", source: "stream", observedAt: Date.now(), windows: [], blocked: true, reachedType: "turn-failed" });
        throw new DecisionError(`Codex decision ${terminal?.status ?? `ended without a terminal (${branch.error ?? "unknown"})`}${terminal?.error?.message ? `: ${String(terminal.error.message).slice(0, 300)}` : ""}`,
          reason, "attempted", !!terminal || outcome.settled, admissionId);
      }
      const tokens = codexTokens(branch.usage);
      this._emit({ type: "decision", key: spec.key, prime, ms: Date.now() - started, ...(tokens?.cacheRead !== undefined ? { cacheRead: tokens.cacheRead } : {}),
        ...(count(branch.usage?.inputTokens) !== undefined ? { input: count(branch.usage?.inputTokens) } : {}) });
      if (session) { session.servedWarm = true; state.volatile = false; }
      return { key: spec.key, admissionId, content, ...(tokens ? { tokens } : {}), ...(model ? { model } : {}),
        threadId, ...(branch.turnId ? { turnId: branch.turnId } : {}), prime, ...(outcome.hedged ? { hedged: true } : {}), timing: { waitMs, primeMs, branchMs, turnMs } };
    } catch (error) {
      if (error instanceof DecisionError) throw error;
      throw new DecisionError((error as Error).message, "transport", dispatched ? "attempted" : "not-dispatched", !dispatched, admissionId, { cause: error });
    } finally {
      if (session) {
        session.inUse--; session.lastUsed = Date.now();
        if (session.stale && session.inUse === 0) void this._drop(session, session.stale);
      }
      if (threadId) {
        this._branches.delete(threadId);
        if (this._conn === conn) void conn.request("thread/unsubscribe", { threadId }, 10_000).catch(() => undefined);
      }
    }
  }
}
