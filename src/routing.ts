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
// Ordering is an ordered list of terms over the fields projected onto each
// eligible candidate, in `@inixiative/json-rules`' `OrderBy` vocabulary.
// Named strategies are presets over that list; a caller may pass its own terms
// instead. `id` is always the final term, so ranking is total and deterministic.
//
// Eligibility is separate from ordering: `pinned` restricts which instances may
// serve at all, and unknown, stale, future or reset-crossing limit observations
// mean routing has no capacity reading for an instance. By default that excludes
// it — routing never guesses capacity.
// ---------------------------------------------------------------------------

import type { OrderBy, SortDir } from '@inixiative/json-rules';

export type { OrderBy, SortDir };

export type RoutingField = 'priority' | 'utilization' | 'quartile' | 'headroom' | 'preferred';

export interface OrderingTerm {
  readonly field: RoutingField;
  readonly dir?: SortDir;
}

export type RoutingStrategy =
  | 'quartile-balanced'
  | 'owner-first'
  | 'priority-balanced'
  | 'priority-strict'
  | 'least-used';

export type OrderingSpec = RoutingStrategy | readonly OrderingTerm[];

/** Every term carries a direction. Assignable to json-rules' `OrderBy`. */
export type ResolvedOrdering = { field: RoutingField; dir: SortDir }[];

/** The direction that puts the better candidate first when a term omits one. */
const NATURAL_DIRECTION: Record<RoutingField, SortDir> = {
  priority: 'asc',
  utilization: 'asc',
  quartile: 'asc',
  headroom: 'desc',
  preferred: 'desc',
};

export const ROUTING_STRATEGIES: Record<RoutingStrategy, readonly OrderingTerm[]> = {
  'quartile-balanced': [{ field: 'quartile' }, { field: 'preferred' }, { field: 'utilization' }],
  'owner-first': [{ field: 'preferred' }, { field: 'utilization' }],
  // Load decides between tiers that differ by a quartile; priority decides within one.
  'priority-balanced': [
    { field: 'quartile' },
    { field: 'priority' },
    { field: 'preferred' },
    { field: 'utilization' },
  ],
  // Priority dominates: a lower tier serves only once every higher one is excluded.
  'priority-strict': [{ field: 'priority' }, { field: 'utilization' }],
  'least-used': [{ field: 'utilization' }],
};

export const DEFAULT_STRATEGY: RoutingStrategy = 'quartile-balanced';

const ROUTING_FIELDS = Object.keys(NATURAL_DIRECTION) as RoutingField[];

/** Resolve a strategy name or explicit term list into terms, each with a direction. */
export const resolveOrdering = (spec: OrderingSpec = DEFAULT_STRATEGY): ResolvedOrdering => {
  if (typeof spec === 'string') {
    const preset = ROUTING_STRATEGIES[spec];
    if (!preset) throw Error(`Unknown routing strategy "${spec}"`);
    return resolveOrdering(preset);
  }
  if (!spec.length) throw Error('Ordering requires at least one term');
  return spec.map((term) => {
    if (!ROUTING_FIELDS.includes(term.field)) throw Error(`Unknown ordering field "${term.field}"`);
    if (term.dir !== undefined && term.dir !== 'asc' && term.dir !== 'desc')
      throw Error(`Unknown sort direction "${term.dir}"`);
    return { field: term.field, dir: term.dir ?? NATURAL_DIRECTION[term.field] };
  });
};

export interface RepositoryRoute {
  repository: string;
  organizationId: string;
  preferredAccountId: string;
}

export interface SubscriptionCandidate {
  id: string;
  organizationIds: readonly string[];
  runtime: 'codex' | 'claude';
  authentication: 'subscription' | 'api-key';
  enabled: boolean;
  /** model → supported efforts. */
  models: Readonly<Record<string, readonly string[]>>;
  activeRuns: number;
  concurrencyLimit: number;
  /** Lower serves first. Absent is 0, so prioritized and unprioritized instances order together. */
  priority?: number;
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

/**
 * What to do with an instance routing has no usable capacity reading for.
 *
 * `exclude` (default) suits provider-enforced subscription windows, where an
 * unread login may already be exhausted and sending work there fails the turn.
 * `rank-last` suits capacity whose spend is bounded elsewhere (Kingdom gates on
 * allocation policies), where a never-observed instance must stay usable.
 */
export type UnknownUtilizationPolicy = 'exclude' | 'rank-last';

export interface RoutingRequest {
  repository: string;
  organizationId?: string;
  runtime: 'codex' | 'claude';
  model: string;
  effort: string;
  now: number;
  maximumObservationAgeMs: number;
  ordering?: OrderingSpec;
  pinned?: boolean;
  unknownUtilization?: UnknownUtilizationPolicy;
}

/** Repository resolution already done by the caller (or not needed). */
export interface CandidateRequest {
  organizationId?: string;
  preferredId?: string;
  runtime: 'codex' | 'claude';
  model: string;
  effort: string;
  now: number;
  maximumObservationAgeMs: number;
  ordering?: OrderingSpec;
  /** Only the preferred instance may serve; others are excluded as `not-pinned`. */
  pinned?: boolean;
  unknownUtilization?: UnknownUtilizationPolicy;
}

export interface RankedCandidate {
  accountId: string;
  /** Null when no usable observation exists and the policy is `rank-last`. */
  utilizationPercent: number | null;
  quartile: number | null;
  priority: number;
  headroom: number;
  preferred: boolean;
}

export type ExclusionReason =
  | 'disabled'
  | 'not-subscription'
  | 'organization'
  | 'runtime'
  | 'model'
  | 'occupied'
  | 'invalid'
  | 'no-observation'
  | 'stale-observation'
  | 'exhausted'
  | 'blocked'
  | 'unavailable'
  | 'not-pinned';

/** Only repository identities, never local paths or URL credentials. GitHub's
 * scp-style git user is transport syntax, not a credential or organization grant. */
export function repositoryIdentity(remote: string): string {
  const scp = /^git@([a-zA-Z0-9.-]+):([^?#\s]+)$/.exec(remote);
  let url: URL;
  try {
    url = new URL(scp ? `ssh://git@${scp[1]}/${scp[2]}` : remote);
  } catch {
    throw Error('Repository must be an HTTPS or SSH remote');
  }
  if (
    !['https:', 'ssh:'].includes(url.protocol) ||
    url.password ||
    url.search ||
    url.hash ||
    url.port ||
    (url.username && !(url.protocol === 'ssh:' && url.username === 'git'))
  )
    throw Error('Unsupported repository remote');
  if (/%|\\|\s/.test(url.pathname)) throw Error('Ambiguous repository path');
  const path = url.pathname
    .replace(/^\//, '')
    .replace(/\/$/, '')
    .replace(/\.git$/, '');
  if (
    !path ||
    path.split('/').length < 2 ||
    path.split('/').some((p) => !p || p === '.' || p === '..')
  )
    throw Error('Repository must include its namespace');
  const normalized = url.hostname === 'github.com' ? path.toLowerCase() : path;
  return `${url.hostname.toLowerCase()}/${normalized}`;
}

/** Why one candidate is ineligible, or undefined with its utilization when eligible. */
export function assessCandidate(
  request: CandidateRequest,
  account: SubscriptionCandidate,
): { excluded: ExclusionReason } | { utilizationPercent: number | null } {
  if (
    !account.id ||
    !Number.isSafeInteger(account.activeRuns) ||
    account.activeRuns < 0 ||
    !Number.isSafeInteger(account.concurrencyLimit) ||
    account.concurrencyLimit < 1 ||
    (account.priority !== undefined && !Number.isFinite(account.priority))
  )
    return { excluded: 'invalid' };
  if (!account.enabled) return { excluded: 'disabled' };
  if (account.authentication !== 'subscription') return { excluded: 'not-subscription' };
  if (
    request.organizationId !== undefined &&
    !account.organizationIds.includes(request.organizationId)
  )
    return { excluded: 'organization' };
  if (account.runtime !== request.runtime) return { excluded: 'runtime' };
  if (!account.models[request.model]?.includes(request.effort)) return { excluded: 'model' };
  if (request.pinned && account.id !== request.preferredId) return { excluded: 'not-pinned' };
  if (account.unavailableUntil !== undefined && account.unavailableUntil > request.now)
    return { excluded: 'unavailable' };
  if (account.activeRuns >= account.concurrencyLimit) return { excluded: 'occupied' };
  if (account.blocked) return { excluded: 'blocked' };
  const unreadable = request.unknownUtilization === 'rank-last' ? null : undefined;
  if (account.windows.length === 0) {
    if (unreadable === undefined) return { excluded: 'no-observation' };
    return { utilizationPercent: null };
  }
  const fractions: number[] = [];
  for (const window of account.windows) {
    if (
      window.usedPercent === null ||
      !Number.isFinite(window.usedPercent) ||
      window.usedPercent < 0 ||
      window.usedPercent > 100 ||
      !Number.isFinite(window.reservedPercent) ||
      window.reservedPercent < 0
    )
      return unreadable === undefined ? { excluded: 'invalid' } : { utilizationPercent: null };
    // resetsAt === Infinity: the provider reported no reset for this window, so no reset can have crossed the observation.
    if (
      !Number.isFinite(window.observedAt) ||
      window.observedAt > request.now ||
      request.now - window.observedAt > request.maximumObservationAgeMs ||
      (window.resetsAt !== Number.POSITIVE_INFINITY &&
        (!Number.isFinite(window.resetsAt) || window.resetsAt <= request.now))
    )
      return unreadable === undefined
        ? { excluded: 'stale-observation' }
        : { utilizationPercent: null };
    fractions.push(window.usedPercent + window.reservedPercent);
  }
  if (fractions.some((p) => p >= 100)) return { excluded: 'exhausted' };
  return { utilizationPercent: Math.max(...fractions) };
}

const FIELD_VALUE: Record<RoutingField, (candidate: RankedCandidate) => number | null> = {
  priority: (c) => c.priority,
  utilization: (c) => c.utilizationPercent,
  quartile: (c) => c.quartile,
  headroom: (c) => c.headroom,
  preferred: (c) => Number(c.preferred),
};

/** Nulls last in either direction: an unknown reading never outranks a known one. */
const compare = (a: number | null, b: number | null, dir: SortDir): number => {
  if (a === null) return b === null ? 0 : 1;
  if (b === null) return -1;
  return dir === 'desc' ? b - a : a - b;
};

/** Rank eligible candidates deterministically (ties broken by id). */
export function rankCandidates(
  request: CandidateRequest,
  accounts: readonly SubscriptionCandidate[],
): {
  candidates: RankedCandidate[];
  excluded: Record<string, ExclusionReason>;
  ordering: ResolvedOrdering;
} {
  if (
    !Number.isFinite(request.now) ||
    !Number.isFinite(request.maximumObservationAgeMs) ||
    request.maximumObservationAgeMs <= 0
  )
    throw Error('Invalid observation policy');
  if (request.pinned && !request.preferredId)
    throw Error('Pinned routing requires a preferred instance');
  if (new Set(accounts.map((a) => a.id)).size !== accounts.length)
    throw Error('Duplicate account identity');
  const ordering = resolveOrdering(request.ordering);
  const excluded: Record<string, ExclusionReason> = {};
  const ranked = accounts.flatMap((account) => {
    const assessed = assessCandidate(request, account);
    if ('excluded' in assessed) {
      excluded[account.id] = assessed.excluded;
      return [];
    }
    const { utilizationPercent } = assessed;
    return [
      {
        accountId: account.id,
        utilizationPercent,
        quartile: utilizationPercent === null ? null : Math.floor(utilizationPercent / 25),
        priority: account.priority ?? 0,
        headroom: account.concurrencyLimit - account.activeRuns,
        preferred: account.id === request.preferredId,
      },
    ];
  });
  ranked.sort((a, b) => {
    for (const { field, dir } of ordering) {
      const order = compare(FIELD_VALUE[field](a), FIELD_VALUE[field](b), dir);
      if (order !== 0) return order;
    }
    return a.accountId.localeCompare(b.accountId);
  });
  return { candidates: ranked, excluded, ordering };
}

/** The draft's repository-scoped entry point: resolve ownership, then rank. */
export function rankSubscriptionAccounts(
  request: RoutingRequest,
  routes: readonly RepositoryRoute[],
  accounts: readonly SubscriptionCandidate[],
) {
  if (
    !Number.isFinite(request.now) ||
    !Number.isFinite(request.maximumObservationAgeMs) ||
    request.maximumObservationAgeMs <= 0
  )
    throw Error('Invalid observation policy');
  const repository = repositoryIdentity(request.repository);
  const matches = routes.filter((r) => repositoryIdentity(r.repository) === repository);
  if (matches.length !== 1) throw Error('Repository ownership is missing or ambiguous');
  const route = matches[0]!;
  if (!route.organizationId || !route.preferredAccountId)
    throw Error('Incomplete repository routing rule');
  if (request.organizationId && request.organizationId !== route.organizationId)
    throw Error('Explicit organization conflicts with repository ownership');
  const { candidates, ordering } = rankCandidates(
    {
      organizationId: route.organizationId,
      preferredId: route.preferredAccountId,
      runtime: request.runtime,
      model: request.model,
      effort: request.effort,
      now: request.now,
      maximumObservationAgeMs: request.maximumObservationAgeMs,
      ordering: request.ordering,
      ...(request.pinned !== undefined ? { pinned: request.pinned } : {}),
      ...(request.unknownUtilization !== undefined
        ? { unknownUtilization: request.unknownUtilization }
        : {}),
    },
    accounts,
  );
  return {
    repository,
    organizationId: route.organizationId,
    model: request.model,
    effort: request.effort,
    ordering,
    candidates,
  };
}
