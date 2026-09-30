// Subscription usage limits, normalized across runtimes. Account identity
// (email, account/organization IDs) is never read into a snapshot.

export type LimitRuntime = "claude" | "codex";

export interface LimitWindow {
  /** Stable per runtime: Claude `five_hour`/`seven_day`/…, Codex `primary`/`secondary`. */
  readonly id: string;
  /** 0–100. */
  readonly usedPercent: number;
  /** Epoch ms. */
  readonly resetsAt?: number;
  readonly windowMinutes?: number;
}

export interface LimitSnapshot {
  readonly runtime: LimitRuntime;
  /** `poll`: an explicit read; `stream`: observed during a turn (may be sparse). */
  readonly source: "poll" | "stream";
  /** Epoch ms. */
  readonly observedAt: number;
  readonly windows: readonly LimitWindow[];
  /** The provider reports ordinary usage blocked now. Absent means not reported. */
  readonly blocked?: boolean;
  /** Provider's reason label (Codex `rateLimitReachedType`, Claude `rateLimitType` when rejected). */
  readonly reachedType?: string;
  readonly plan?: string;
}

const percent = (value: unknown, scale = 1): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.min(100, value * scale)) : undefined;
const epochSeconds = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? value * 1000 : undefined;
const isoTime = (value: unknown): number | undefined => {
  if (typeof value !== "string" || !value) return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
};
const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const window = (id: string, used: number | undefined, resetsAt?: number, windowMinutes?: number): LimitWindow[] =>
  used === undefined ? [] : [{ id, usedPercent: used, ...(resetsAt ? { resetsAt } : {}), ...(windowMinutes ? { windowMinutes } : {}) }];

/**
 * Codex `account/rateLimits/read` result or `account/rateLimits/updated` params.
 * Only the main `codex` bucket is read; model-specific buckets are separate allowances.
 */
export function codexLimitSnapshot(value: unknown, source: LimitSnapshot["source"], observedAt = Date.now()): LimitSnapshot | undefined {
  const outer = object(value);
  const snapshot = object(object(outer?.rateLimitsByLimitId)?.codex) ?? object(outer?.rateLimits);
  if (!snapshot || (typeof snapshot.limitId === "string" && snapshot.limitId !== "codex")) return undefined;
  const windows: LimitWindow[] = [];
  for (const id of ["primary", "secondary"] as const) {
    const w = object(snapshot[id]);
    windows.push(...window(id, percent(w?.usedPercent), epochSeconds(w?.resetsAt),
      typeof w?.windowDurationMins === "number" ? w.windowDurationMins : undefined));
  }
  const reached = typeof snapshot.rateLimitReachedType === "string" ? snapshot.rateLimitReachedType : undefined;
  const ordinary = outer?.ordinaryUsageAllowed;
  const blocked = reached !== undefined || ordinary === false || windows.some(w => w.usedPercent >= 100)
    ? true : ordinary === true ? false : undefined;
  return { runtime: "codex", source, observedAt, windows,
    ...(blocked !== undefined ? { blocked } : {}), ...(reached ? { reachedType: reached } : {}),
    ...(typeof snapshot.planType === "string" ? { plan: snapshot.planType } : {}) };
}

/** Claude CLI stream-json `rate_limit_event.rate_limit_info`. Utilization is a 0–1 fraction. */
export function claudeRateLimitSnapshot(info: unknown, observedAt = Date.now()): LimitSnapshot | undefined {
  const i = object(info);
  if (!i) return undefined;
  const windows = new Map<string, LimitWindow>();
  for (const [id, w] of Object.entries(object(i.unifiedWindows) ?? {})) {
    const entry = object(w);
    for (const item of window(id, percent(entry?.utilization, 100), epochSeconds(entry?.resetsAt))) windows.set(id, item);
  }
  const type = typeof i.rateLimitType === "string" ? i.rateLimitType : undefined;
  const overage = i.overageStatus === "allowed" || i.overageStatus === "allowed_warning" || i.isUsingOverage === true;
  const blocked = i.status === "rejected" ? !overage : i.status === "allowed" || i.status === "allowed_warning" ? false : undefined;
  // A rejection names its window; without a utilization figure it is at its limit, and its reset still applies.
  const utilization = percent(i.utilization, 100) ?? (blocked && type ? 100 : undefined);
  if (type && !windows.has(type)) for (const item of window(type, utilization, epochSeconds(i.resetsAt))) windows.set(type, item);
  if (!windows.size && blocked === undefined) return undefined;
  return { runtime: "claude", source: "stream", observedAt, windows: [...windows.values()],
    ...(blocked !== undefined ? { blocked } : {}), ...(blocked && type ? { reachedType: type } : {}) };
}

/** Claude control-protocol `get_usage` response. Utilization is 0–100 here. */
export function claudeUsageSnapshot(response: unknown, observedAt = Date.now()): LimitSnapshot | undefined {
  const r = object(response);
  if (!r || r.rate_limits_available !== true) return undefined;
  const limits = object(r.rate_limits);
  const windows: LimitWindow[] = [];
  for (const [id, minutes] of [["five_hour", 300], ["seven_day", 10_080]] as const) {
    const w = object(limits?.[id]);
    windows.push(...window(id, percent(w?.utilization), isoTime(w?.resets_at), minutes));
  }
  for (const [id, value] of Object.entries(limits ?? {})) {
    if (id === "five_hour" || id === "seven_day" || !id.startsWith("seven_day_")) continue;
    const w = object(value);
    windows.push(...window(id, percent(w?.utilization), isoTime(w?.resets_at), 10_080));
  }
  const locked = [limits?.five_hour, limits?.seven_day].some(w => typeof object(w)?.locked_reason === "string");
  return { runtime: "claude", source: "poll", observedAt, windows,
    ...(locked || windows.some(w => w.usedPercent >= 100) ? { blocked: true } : {}),
    ...(typeof r.subscription_type === "string" ? { plan: r.subscription_type } : {}) };
}

/** Fold a sparse update into the previous snapshot: windows upsert by id and keep a known reset time. */
export function mergeLimits(previous: LimitSnapshot | undefined, update: LimitSnapshot): LimitSnapshot {
  if (!previous || previous.runtime !== update.runtime || update.source === "poll") return update;
  const windows = new Map(previous.windows.map(w => [w.id, w] as const));
  for (const w of update.windows) {
    const prior = windows.get(w.id);
    windows.set(w.id, { ...prior, ...w, ...(w.resetsAt === undefined && prior?.resetsAt ? { resetsAt: prior.resetsAt } : {}) });
  }
  const { blocked: _b, reachedType: _r, ...base } = previous;
  return { ...base, ...update, windows: [...windows.values()],
    ...(update.blocked === undefined && previous.blocked !== undefined ? { blocked: previous.blocked } : {}),
    ...(update.reachedType === undefined && update.blocked !== false && previous.reachedType ? { reachedType: previous.reachedType } : {}) };
}

/** Highest used percentage across windows that have not reset by `now`; undefined when nothing is known. */
export function limitUtilization(snapshot: LimitSnapshot | undefined, now = Date.now()): number | undefined {
  const live = snapshot?.windows.filter(w => w.resetsAt === undefined || w.resetsAt > now) ?? [];
  return live.length ? Math.max(...live.map(w => w.usedPercent)) : undefined;
}
