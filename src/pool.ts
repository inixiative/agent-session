// ---------------------------------------------------------------------------
// SubscriptionPool — accounts as instances of a transport
// ---------------------------------------------------------------------------
//
// An instance is one way of reaching a model with one login: a transport kind
// plus a profile (CODEX_HOME / CLAUDE_CONFIG_DIR). The pool routes work across
// instances deterministically using observed limits and local health, leases
// capacity, and hands threads between instances only where their continuation
// identity says the native history is shared.
//
// The session is the work; an instance supplies capacity. Pool membership
// grants nothing by itself: callers (Kastle, Foundry) supply the instances and
// the organization/preference policy they are allowed to use.
// ---------------------------------------------------------------------------

import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { HarnessSession } from "./harness-session";
import { mergeLimits, type LimitSnapshot } from "./limits";
import { probeClaudeLimits, probeCodexLimits } from "./limits-probe";
import { rankCandidates, type ExclusionReason, type RankedCandidate, type RoutingMode, type SubscriptionCandidate } from "./routing";
import { TRANSPORTS, type TransportKind } from "./transport";
import { createSession } from "./transports";

export type PooledTransport = "claude-cli" | "codex-mcp" | "codex-app-server" | "claude-agent-sdk";

export interface InstanceConfig {
  readonly id: string;
  readonly transport: PooledTransport;
  /** CODEX_HOME / CLAUDE_CONFIG_DIR for this login. Undefined: the runtime's default login. */
  readonly profileDirectory?: string;
  /** Extra environment for sessions on this instance. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /**
   * Instances with equal keys can continue each other's threads. Default: the
   * native history home (`codex:home:<dir>` / `claude:home:<dir>`), so distinct
   * logins only share continuity when the caller has arranged shared history.
   */
  readonly continuationKey?: string;
  readonly organizationIds?: readonly string[];
  /** model → efforts this instance may serve. Undefined: unrestricted. */
  readonly models?: Readonly<Record<string, readonly string[]>>;
  /** Concurrent leases. Default 1. */
  readonly concurrencyLimit?: number;
  readonly enabled?: boolean;
  readonly authentication?: "subscription" | "api-key";
  /** Session config merged into every session opened on this instance (bin, spawn, SDK query…). */
  readonly session?: Readonly<Record<string, unknown>>;
}

export interface PoolRequest {
  readonly runtime: "claude" | "codex";
  readonly model: string;
  readonly effort?: string;
  readonly organizationId?: string;
  readonly preferredInstanceId?: string;
  readonly mode?: RoutingMode;
  /** Restrict to these transports (e.g. only resumable ones). */
  readonly transports?: readonly TransportKind[];
  readonly excludeInstanceIds?: readonly string[];
}

/** Common session options; transport-specific fields ride along untyped and are passed through. */
export interface PooledSessionConfig {
  readonly cwd?: string;
  readonly baseContext?: string;
  readonly timeout?: number;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly [option: string]: unknown;
}

export interface Lease {
  readonly leaseId: string;
  readonly instanceId: string;
  readonly transport: PooledTransport;
  readonly continuationKey: string;
  readonly released: boolean;
  release(): void;
}

export type PoolEvent =
  | { readonly type: "allocated"; readonly leaseId: string; readonly instanceId: string; readonly transport: PooledTransport; readonly mode: RoutingMode; readonly utilizationPercent: number; readonly rank: number }
  | { readonly type: "released"; readonly leaseId: string; readonly instanceId: string }
  | { readonly type: "limits"; readonly instanceId: string; readonly limits: LimitSnapshot }
  | { readonly type: "failure"; readonly instanceId: string; readonly kind: FailureKind; readonly unavailableUntil: number }
  | { readonly type: "exhausted"; readonly runtime: string; readonly model: string; readonly excluded: Readonly<Record<string, ExclusionReason>> }
  | { readonly type: "handoff"; readonly from: string; readonly to: string; readonly continuationKey: string; readonly externalSessionId: string }
  | { readonly type: "handoff-refused"; readonly from: string; readonly reason: ContinuityRefusal };

export type FailureKind = "rate-limited" | "auth" | "transport" | "probe";
export type ContinuityRefusal = "unknown-instance" | "resume-unsupported" | "unresolved-native-work" | "no-shared-history" | "targets-unavailable";

export class PoolExhaustedError extends Error {
  constructor(message: string, readonly excluded: Readonly<Record<string, ExclusionReason>>) { super(message); this.name = "PoolExhaustedError"; }
}
export class ContinuityError extends Error {
  constructor(message: string, readonly reason: ContinuityRefusal, readonly excluded?: Readonly<Record<string, ExclusionReason>>) { super(message); this.name = "ContinuityError"; }
}

export interface InstanceStatus {
  readonly id: string;
  readonly transport: PooledTransport;
  readonly runtime: "claude" | "codex";
  readonly continuationKey: string;
  readonly enabled: boolean;
  readonly active: number;
  readonly concurrencyLimit: number;
  readonly limits?: LimitSnapshot;
  readonly unavailableUntil?: number;
  readonly consecutiveFailures: number;
}

interface InstanceState {
  readonly config: InstanceConfig;
  readonly runtime: "claude" | "codex";
  readonly continuationKey: string;
  readonly env: Record<string, string | undefined>;
  readonly leases: Set<string>;
  limits?: LimitSnapshot;
  unavailableUntil?: number;
  failures: number;
  /** Last poll that failed or returned nothing; not repeated within the probe cooldown. */
  emptyProbeAt?: number;
}

export interface SubscriptionPoolOptions {
  readonly instances: readonly InstanceConfig[];
  /** Older limit observations exclude an instance until refreshed. Default 15 min. */
  readonly maximumObservationAgeMs?: number;
  /** First cooldown after a failure; doubles per consecutive failure up to 10 min. Default 60 s. */
  readonly failureCooldownMs?: number;
  /** Utilization reserved per active lease when ranking. Default 0. */
  readonly reservationPercent?: number;
  /** A poll that failed or returned no limits is not repeated for this long. Default 60 s. */
  readonly probeCooldownMs?: number;
  /** Limit poll for one instance. Default: probeCodexLimits / probeClaudeLimits with the instance profile. */
  readonly probe?: (instance: InstanceStatus & { readonly env: Readonly<Record<string, string | undefined>> }) => Promise<LimitSnapshot | undefined>;
  readonly now?: () => number;
  readonly onEvent?: (event: PoolEvent) => void;
}

const PROFILE_VARIABLE = { codex: "CODEX_HOME", claude: "CLAUDE_CONFIG_DIR" } as const;

export class SubscriptionPool {
  private readonly _instances = new Map<string, InstanceState>();
  private readonly _options: SubscriptionPoolOptions;
  private readonly _maxAge: number;
  private readonly _cooldown: number;
  private readonly _listeners = new Set<(event: PoolEvent) => void>();

  constructor(options: SubscriptionPoolOptions) {
    this._options = options;
    this._maxAge = options.maximumObservationAgeMs ?? 15 * 60_000;
    this._cooldown = options.failureCooldownMs ?? 60_000;
    if (options.onEvent) this._listeners.add(options.onEvent);
    for (const config of options.instances) {
      if (!config.id || this._instances.has(config.id)) throw Error(`Duplicate or empty instance id "${config.id}"`);
      const descriptor = TRANSPORTS[config.transport];
      if (!descriptor || descriptor.status !== "implemented" || descriptor.runtime === "external")
        throw Error(`Instance ${config.id}: transport "${config.transport}" cannot be pooled`);
      const runtime = descriptor.runtime;
      const variable = PROFILE_VARIABLE[runtime];
      // The profile variable is always pinned: a directory selects it, undefined selects the default login.
      // Caller env can never move a leased session to a different login.
      const env: Record<string, string | undefined> = { ...config.env, [variable]: config.profileDirectory ?? config.env?.[variable] };
      const home = resolve(env[variable] ?? join(homedir(), runtime === "codex" ? ".codex" : ".claude"));
      const limit = config.concurrencyLimit ?? 1;
      if (!Number.isSafeInteger(limit) || limit < 1) throw Error(`Instance ${config.id}: concurrencyLimit must be a positive integer`);
      this._instances.set(config.id, { config, runtime, env, leases: new Set(), failures: 0,
        continuationKey: config.continuationKey ?? `${runtime}:home:${home}` });
    }
  }

  onEvent(listener: (event: PoolEvent) => void): () => void {
    this._listeners.add(listener);
    return () => { this._listeners.delete(listener); };
  }

  instances(): InstanceStatus[] { return [...this._instances.values()].map(state => this._status(state)); }

  /** Record limits observed elsewhere (a session's rate_limit event, a primed host). */
  observeLimits(instanceId: string, limits: LimitSnapshot): void {
    const state = this._state(instanceId);
    state.limits = mergeLimits(state.limits, limits);
    this._emit({ type: "limits", instanceId, limits: state.limits });
  }

  /** Poll limits for the given (default: all enabled) instances. A failed poll is a probe failure, not a limit. */
  async refreshLimits(ids?: readonly string[]): Promise<void> {
    const targets = (ids ?? [...this._instances.keys()]).map(id => this._state(id)).filter(s => s.config.enabled !== false);
    await Promise.all(targets.map(async state => {
      try {
        const env = state.env;
        const limits = this._options.probe ? await this._options.probe({ ...this._status(state), env })
          : state.runtime === "codex" ? await probeCodexLimits({ env, bin: state.config.session?.bin as string | undefined })
          : await probeClaudeLimits({ env, bin: state.config.session?.bin as string | undefined });
        if (limits) { state.emptyProbeAt = undefined; this.observeLimits(state.config.id, limits); }
        else state.emptyProbeAt = this._now();
      } catch { state.emptyProbeAt = this._now(); this.reportFailure(state.config.id, "probe"); }
    }));
  }

  /** Deterministic ranking of eligible instances, with the reason each other instance is excluded. */
  rank(request: PoolRequest): { candidates: RankedCandidate[]; excluded: Record<string, ExclusionReason> } {
    const now = this._now();
    const effort = request.effort ?? "default";
    const states = [...this._instances.values()].filter(s => this._eligibleShape(s, request));
    const candidates: SubscriptionCandidate[] = states.map(state => {
      const reserved = state.leases.size * (this._options.reservationPercent ?? 0);
      const limits = state.limits;
      return {
        id: state.config.id, runtime: state.runtime, organizationIds: state.config.organizationIds ?? [],
        authentication: state.config.authentication ?? "subscription", enabled: state.config.enabled !== false,
        models: state.config.models ?? { [request.model]: [effort] },
        activeRuns: state.leases.size, concurrencyLimit: state.config.concurrencyLimit ?? 1,
        windows: (limits?.windows ?? []).map(w => ({ usedPercent: w.usedPercent, reservedPercent: reserved,
          observedAt: limits!.observedAt, resetsAt: w.resetsAt ?? Number.POSITIVE_INFINITY })),
        blocked: this._blocked(state, now),
        ...(state.unavailableUntil !== undefined ? { unavailableUntil: state.unavailableUntil } : {}),
      };
    });
    return rankCandidates({ runtime: request.runtime, model: request.model, effort, now, maximumObservationAgeMs: this._maxAge,
      mode: request.mode, organizationId: request.organizationId, preferredId: request.preferredInstanceId }, candidates);
  }

  /** Lease the best instance now, or throw PoolExhaustedError with every exclusion reason. */
  acquire(request: PoolRequest): Lease {
    const { candidates, excluded } = this.rank(request);
    const best = candidates[0];
    if (!best) {
      this._emit({ type: "exhausted", runtime: request.runtime, model: request.model, excluded });
      throw new PoolExhaustedError(`No eligible ${request.runtime} instance for ${request.model}: ${Object.entries(excluded).map(([id, why]) => `${id}=${why}`).join(", ") || "none configured"}`, excluded);
    }
    return this._lease(this._state(best.accountId), request.mode ?? "quartile-balanced", best.utilizationPercent, 0);
  }

  /** Refresh stale limits, lease an instance and open a session on it. The lease ends with the session. */
  async open(request: PoolRequest, config: PooledSessionConfig = {}): Promise<{ session: HarnessSession; lease: Lease }> {
    await this._refreshStale(request);
    const lease = this.acquire(request);
    try { return { session: this._session(lease, { model: request.model, ...(request.effort ? { effort: request.effort } : {}), ...config }), lease }; }
    catch (error) { lease.release(); throw error; }
  }

  /**
   * Continue a thread on another instance (AS-003). Allowed only when both
   * transports resume natively, the instances share a continuation key and the
   * old session has no native work of unknown outcome. The old session is killed.
   */
  async continueOn(binding: { readonly instanceId: string; readonly externalSessionId: string; readonly session?: HarnessSession; readonly lease?: Lease },
    request: PoolRequest, config: PooledSessionConfig = {}): Promise<{ session: HarnessSession; lease: Lease }> {
    const refuse = (reason: ContinuityRefusal, message: string, excluded?: Record<string, ExclusionReason>): never => {
      this._emit({ type: "handoff-refused", from: binding.instanceId, reason });
      throw new ContinuityError(message, reason, excluded);
    };
    const unresolved = () => binding.session?.attempts?.some(a => a.dispatch === "attempted" && a.nativeOutcome === "unknown");
    const from = this._instances.get(binding.instanceId);
    if (!from) return refuse("unknown-instance", `Unknown instance ${binding.instanceId}`);
    if (TRANSPORTS[from.config.transport].capabilities.resume !== "native")
      return refuse("resume-unsupported", `${from.config.transport} cannot resume a thread in another process`);
    if (unresolved())
      return refuse("unresolved-native-work", "The session has native work of unknown outcome; continuing elsewhere could repeat or fork it");
    const shared = [...this._instances.values()].filter(s => s !== from && s.continuationKey === from.continuationKey
      && s.runtime === from.runtime && TRANSPORTS[s.config.transport].capabilities.resume === "native");
    if (!shared.length) return refuse("no-shared-history",
      `No other instance shares continuation key ${from.continuationKey}; its native history is not visible elsewhere`);
    const allowed = new Set(shared.map(s => s.config.id));
    await this._refreshStale(request, allowed);
    const { candidates, excluded } = this.rank({ ...request, excludeInstanceIds: [...(request.excludeInstanceIds ?? []), ...[...this._instances.keys()].filter(id => !allowed.has(id))] });
    const best = candidates[0];
    if (!best) return refuse("targets-unavailable", "Instances sharing this history are unavailable", excluded);
    // Re-check after the refresh await, then stop the old session in the same synchronous step: no send can slip in between.
    if (unresolved())
      return refuse("unresolved-native-work", "The session has native work of unknown outcome; continuing elsewhere could repeat or fork it");
    binding.session?.kill();
    binding.lease?.release();
    const lease = this._lease(this._state(best.accountId), request.mode ?? "quartile-balanced", best.utilizationPercent, 0);
    try {
      const session = this._session(lease, { model: request.model, ...(request.effort ? { effort: request.effort } : {}), ...config },
        { externalSessionId: binding.externalSessionId });
      this._emit({ type: "handoff", from: from.config.id, to: best.accountId, continuationKey: from.continuationKey, externalSessionId: binding.externalSessionId });
      return { session, lease };
    } catch (error) { lease.release(); throw error; }
  }

  /** Mark an instance unavailable for a cooldown that doubles per consecutive failure (max 10 min). */
  reportFailure(instanceId: string, kind: FailureKind): void {
    const state = this._state(instanceId);
    state.failures++;
    state.unavailableUntil = this._now() + Math.min(this._cooldown * 2 ** (state.failures - 1), 10 * 60_000);
    if (kind === "rate-limited") state.limits = mergeLimits(state.limits, { runtime: state.runtime, source: "stream", observedAt: this._now(), windows: [], blocked: true, reachedType: "reported" });
    this._emit({ type: "failure", instanceId, kind, unavailableUntil: state.unavailableUntil });
  }

  reportSuccess(instanceId: string): void {
    const state = this._state(instanceId);
    state.failures = 0; state.unavailableUntil = undefined;
  }

  // -------------------------------------------------------------------------

  private _now() { return this._options.now?.() ?? Date.now(); }
  private _emit(event: PoolEvent) { for (const listener of this._listeners) { try { listener(event); } catch { /* observers only */ } } }
  private _state(id: string): InstanceState {
    const state = this._instances.get(id);
    if (!state) throw Error(`Unknown instance ${id}`);
    return state;
  }
  private _status(state: InstanceState): InstanceStatus {
    return { id: state.config.id, transport: state.config.transport, runtime: state.runtime, continuationKey: state.continuationKey,
      enabled: state.config.enabled !== false, active: state.leases.size, concurrencyLimit: state.config.concurrencyLimit ?? 1,
      consecutiveFailures: state.failures, ...(state.limits ? { limits: state.limits } : {}),
      ...(state.unavailableUntil !== undefined ? { unavailableUntil: state.unavailableUntil } : {}) };
  }
  private _eligibleShape(state: InstanceState, request: PoolRequest): boolean {
    return state.runtime === request.runtime && (!request.transports || request.transports.includes(state.config.transport))
      && !request.excludeInstanceIds?.includes(state.config.id);
  }
  /** Blocked unless every window that reached 100% has since reset. */
  private _blocked(state: InstanceState, now: number): boolean {
    if (!state.limits?.blocked) return false;
    const exhausted = state.limits.windows.filter(w => w.usedPercent >= 100);
    return !exhausted.length || exhausted.some(w => w.resetsAt === undefined || w.resetsAt > now);
  }
  private async _refreshStale(request: PoolRequest, only?: Set<string>): Promise<void> {
    const now = this._now();
    const cooldown = this._options.probeCooldownMs ?? 60_000;
    const stale = [...this._instances.values()].filter(s => this._eligibleShape(s, request) && s.config.enabled !== false
      && (!only || only.has(s.config.id))
      && (s.emptyProbeAt === undefined || now - s.emptyProbeAt >= cooldown)
      && (!s.limits || now - s.limits.observedAt > this._maxAge
        || s.limits.windows.some(w => w.resetsAt !== undefined && w.resetsAt <= now)
        || (this._blocked(s, now) && (s.unavailableUntil === undefined || s.unavailableUntil <= now))));
    if (stale.length) await this.refreshLimits(stale.map(s => s.config.id));
  }
  private _lease(state: InstanceState, mode: RoutingMode, utilizationPercent: number, rank: number): Lease {
    const leaseId = crypto.randomUUID();
    state.leases.add(leaseId);
    let released = false;
    const lease: Lease = {
      leaseId, instanceId: state.config.id, transport: state.config.transport, continuationKey: state.continuationKey,
      get released() { return released; },
      release: () => {
        if (released) return; released = true;
        state.leases.delete(leaseId);
        this._emit({ type: "released", leaseId, instanceId: state.config.id });
      },
    };
    this._emit({ type: "allocated", leaseId, instanceId: state.config.id, transport: state.config.transport, mode, utilizationPercent, rank });
    return lease;
  }
  /**
   * Create a session bound to its lease: the lease ends when the session ends,
   * is killed (even before start) or fails to start, and a session whose lease
   * ended cannot start again (e.g. an automatic --resume restart) outside the pool.
   */
  private _session(lease: Lease, config: PooledSessionConfig, forced: Record<string, unknown> = {}): HarnessSession {
    const state = this._state(lease.instanceId);
    const merged = { ...config, ...state.config.session, env: { ...(config.env as Record<string, string | undefined> | undefined), ...state.env }, ...forced };
    const session = createSession(state.config.transport, merged as never);
    session.onEvent(event => {
      if (event.kind === "rate_limit" && event.limits) this.observeLimits(state.config.id, event.limits);
      else if (event.kind === "result" && event.nativeOutcome === "completed") this.reportSuccess(state.config.id);
      else if (event.kind === "result" && event.terminal?.apiErrorStatus === 429) this.reportFailure(state.config.id, "rate-limited");
      else if (event.kind === "session_end") lease.release();
    });
    const start = session.start.bind(session), kill = session.kill.bind(session);
    // Own properties shadow the prototype, so the session's internal restart path goes through them too.
    Object.assign(session, {
      start: async () => {
        if (lease.released) throw Error("Pool lease released; open a new session through the pool");
        try { await start(); } catch (error) { lease.release(); throw error; }
      },
      kill: () => { try { kill(); } finally { lease.release(); } },
    });
    return session;
  }
}
