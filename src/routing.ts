// ---------------------------------------------------------------------------
// Deterministic subscription routing
// ---------------------------------------------------------------------------
//
// Ported from Foundry's draft account-routing policy (foundry-jev-routing
// a60c664, `docs/signet-routing-strategy.md`). Pure functions: invoked only
// after the caller resolves which instances it is authorized to use. Routing
// does not mint authority, read credentials or call a model, and a routing
// preference never widens a grant (organization, runtime, model, billing).
//
// Strategies:
//   quartile-balanced (default)  lowest usage quartile first; the preferred
//                                (owning) instance wins within its quartile.
//   owner-first                  the preferred instance while eligible, then
//                                spillover by utilization.
//   pinned                       the preferred instance only; otherwise none.
//
// Unknown, stale, future or reset-crossing limit observations exclude an
// instance: routing never guesses capacity.
// ---------------------------------------------------------------------------

export type RoutingMode = "quartile-balanced" | "owner-first" | "pinned";

export interface RepositoryRoute {
  repository: string;
  organizationId: string;
  preferredAccountId: string;
}

export interface SubscriptionCandidate {
  id: string;
  organizationIds: readonly string[];
  runtime: "codex" | "claude";
  authentication: "subscription" | "api-key";
  enabled: boolean;
  /** model → supported efforts. */
  models: Readonly<Record<string, readonly string[]>>;
  activeRuns: number;
  concurrencyLimit: number;
  /** All provider enforcement windows, plus locally retained reservations. `resetsAt: Infinity` means none reported. */
  windows: readonly {
    usedPercent: number | null;
    reservedPercent: number;
    observedAt: number;
    resetsAt: number;
  }[];
  /** The provider reports ordinary usage blocked now. */
  blocked?: boolean;
  /** Excluded until this time after local failures (epoch ms). */
  unavailableUntil?: number;
}

export interface RoutingRequest {
  repository: string;
  organizationId?: string;
  runtime: "codex" | "claude";
  model: string;
  effort: string;
  now: number;
  maximumObservationAgeMs: number;
  mode?: RoutingMode;
}

/** Repository resolution already done by the caller (or not needed). */
export interface CandidateRequest {
  organizationId?: string;
  preferredId?: string;
  runtime: "codex" | "claude";
  model: string;
  effort: string;
  now: number;
  maximumObservationAgeMs: number;
  mode?: RoutingMode;
}

export interface RankedCandidate {
  accountId: string;
  utilizationPercent: number;
  quartile: number;
  preferred: boolean;
}

export type ExclusionReason = "disabled" | "not-subscription" | "organization" | "runtime" | "model" | "occupied"
  | "invalid" | "no-observation" | "stale-observation" | "exhausted" | "blocked" | "unavailable" | "not-pinned";

/** Only repository identities, never local paths or URL credentials. GitHub's
 * scp-style git user is transport syntax, not a credential or organization grant. */
export function repositoryIdentity(remote: string): string {
  const scp = /^git@([a-zA-Z0-9.-]+):([^?#\s]+)$/.exec(remote);
  let url: URL;
  try { url = new URL(scp ? `ssh://git@${scp[1]}/${scp[2]}` : remote); }
  catch { throw Error("Repository must be an HTTPS or SSH remote"); }
  if (!["https:", "ssh:"].includes(url.protocol) || url.password || url.search || url.hash || url.port
    || (url.username && !(url.protocol === "ssh:" && url.username === "git")))
    throw Error("Unsupported repository remote");
  if (/%|\\|\s/.test(url.pathname)) throw Error("Ambiguous repository path");
  const path = url.pathname.replace(/^\//, "").replace(/\/$/, "").replace(/\.git$/, "");
  if (!path || path.split("/").length < 2 || path.split("/").some(p => !p || p === "." || p === ".."))
    throw Error("Repository must include its namespace");
  const normalized = url.hostname === "github.com" ? path.toLowerCase() : path;
  return `${url.hostname.toLowerCase()}/${normalized}`;
}

/** Why one candidate is ineligible, or undefined with its utilization when eligible. */
export function assessCandidate(request: CandidateRequest, account: SubscriptionCandidate):
  { excluded: ExclusionReason } | { utilizationPercent: number } {
  if (!account.id || !Number.isSafeInteger(account.activeRuns) || account.activeRuns < 0
    || !Number.isSafeInteger(account.concurrencyLimit) || account.concurrencyLimit < 1) return { excluded: "invalid" };
  if (!account.enabled) return { excluded: "disabled" };
  if (account.authentication !== "subscription") return { excluded: "not-subscription" };
  if (request.organizationId !== undefined && !account.organizationIds.includes(request.organizationId)) return { excluded: "organization" };
  if (account.runtime !== request.runtime) return { excluded: "runtime" };
  if (!account.models[request.model]?.includes(request.effort)) return { excluded: "model" };
  if (request.mode === "pinned" && account.id !== request.preferredId) return { excluded: "not-pinned" };
  if (account.unavailableUntil !== undefined && account.unavailableUntil > request.now) return { excluded: "unavailable" };
  if (account.activeRuns >= account.concurrencyLimit) return { excluded: "occupied" };
  if (account.blocked) return { excluded: "blocked" };
  if (account.windows.length === 0) return { excluded: "no-observation" };
  const fractions: number[] = [];
  for (const window of account.windows) {
    if (window.usedPercent === null || !Number.isFinite(window.usedPercent) || window.usedPercent < 0 || window.usedPercent > 100
      || !Number.isFinite(window.reservedPercent) || window.reservedPercent < 0) return { excluded: "invalid" };
    // resetsAt === Infinity: the provider reported no reset for this window, so no reset can have crossed the observation.
    if (!Number.isFinite(window.observedAt) || window.observedAt > request.now
      || request.now - window.observedAt > request.maximumObservationAgeMs
      || (window.resetsAt !== Number.POSITIVE_INFINITY && (!Number.isFinite(window.resetsAt) || window.resetsAt <= request.now))) return { excluded: "stale-observation" };
    fractions.push(window.usedPercent + window.reservedPercent);
  }
  if (fractions.some(p => p >= 100)) return { excluded: "exhausted" };
  return { utilizationPercent: Math.max(...fractions) };
}

/** Rank eligible candidates deterministically (ties broken by id). */
export function rankCandidates(request: CandidateRequest, accounts: readonly SubscriptionCandidate[]):
  { candidates: RankedCandidate[]; excluded: Record<string, ExclusionReason> } {
  if (!Number.isFinite(request.now) || !Number.isFinite(request.maximumObservationAgeMs)
    || request.maximumObservationAgeMs <= 0) throw Error("Invalid observation policy");
  if (request.mode === "pinned" && !request.preferredId) throw Error("Pinned routing requires a preferred instance");
  if (new Set(accounts.map(a => a.id)).size !== accounts.length) throw Error("Duplicate account identity");
  const excluded: Record<string, ExclusionReason> = {};
  const ranked = accounts.flatMap(account => {
    const assessed = assessCandidate(request, account);
    if ("excluded" in assessed) { excluded[account.id] = assessed.excluded; return []; }
    const { utilizationPercent } = assessed;
    return [{ accountId: account.id, utilizationPercent, quartile: Math.floor(utilizationPercent / 25), preferred: account.id === request.preferredId }];
  });
  ranked.sort((a, b) => request.mode === "owner-first" || request.mode === "pinned"
    ? Number(b.preferred) - Number(a.preferred) || a.utilizationPercent - b.utilizationPercent || a.accountId.localeCompare(b.accountId)
    : a.quartile - b.quartile || Number(b.preferred) - Number(a.preferred)
      || a.utilizationPercent - b.utilizationPercent || a.accountId.localeCompare(b.accountId));
  return { candidates: ranked, excluded };
}

/** The draft's repository-scoped entry point: resolve ownership, then rank. */
export function rankSubscriptionAccounts(
  request: RoutingRequest,
  routes: readonly RepositoryRoute[],
  accounts: readonly SubscriptionCandidate[],
) {
  if (!Number.isFinite(request.now) || !Number.isFinite(request.maximumObservationAgeMs)
    || request.maximumObservationAgeMs <= 0) throw Error("Invalid observation policy");
  const repository = repositoryIdentity(request.repository);
  const matches = routes.filter(r => repositoryIdentity(r.repository) === repository);
  if (matches.length !== 1) throw Error("Repository ownership is missing or ambiguous");
  const route = matches[0]!;
  if (!route.organizationId || !route.preferredAccountId) throw Error("Incomplete repository routing rule");
  if (request.organizationId && request.organizationId !== route.organizationId)
    throw Error("Explicit organization conflicts with repository ownership");
  const { candidates } = rankCandidates({ organizationId: route.organizationId, preferredId: route.preferredAccountId,
    runtime: request.runtime, model: request.model, effort: request.effort, now: request.now,
    maximumObservationAgeMs: request.maximumObservationAgeMs, mode: request.mode }, accounts);
  return { repository, organizationId: route.organizationId, model: request.model, effort: request.effort,
    mode: request.mode ?? "quartile-balanced", candidates };
}
