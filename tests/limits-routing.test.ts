import { describe, expect, test } from "bun:test";
import {
  claudeRateLimitSnapshot, claudeUsageSnapshot, codexLimitSnapshot, limitUtilization, mergeLimits,
  rankCandidates, rankSubscriptionAccounts, repositoryIdentity, type SubscriptionCandidate,
} from "../src";

describe("limit snapshots", () => {
  test("Codex read result keeps the main bucket, converts seconds and never reads account identity", () => {
    const s = codexLimitSnapshot({ accountId: "PRIVATE-ACCOUNT", ordinaryUsageAllowed: true,
      rateLimits: { limitId: "codex", planType: "pro", primary: { usedPercent: 81, windowDurationMins: 10080, resetsAt: 1_790_624_333 }, secondary: null },
      rateLimitsByLimitId: { codex: { limitId: "codex", planType: "pro", primary: { usedPercent: 81, windowDurationMins: 10080, resetsAt: 1_790_624_333 } },
        spark: { limitId: "spark", primary: { usedPercent: 100 } } } }, "poll", 5);
    expect(s).toEqual({ runtime: "codex", source: "poll", observedAt: 5, blocked: false, plan: "pro",
      windows: [{ id: "primary", usedPercent: 81, resetsAt: 1_790_624_333_000, windowMinutes: 10080 }] });
    expect(JSON.stringify(s)).not.toContain("PRIVATE");
  });

  test("Codex reached type or refused ordinary usage is blocked; a model-specific update is ignored", () => {
    expect(codexLimitSnapshot({ rateLimits: { primary: { usedPercent: 40 }, rateLimitReachedType: "rate_limit_reached" } }, "stream")?.blocked).toBe(true);
    expect(codexLimitSnapshot({ ordinaryUsageAllowed: false, rateLimits: { primary: { usedPercent: 40 } } }, "poll")?.blocked).toBe(true);
    expect(codexLimitSnapshot({ rateLimits: { limitId: "spark", primary: { usedPercent: 99 } } }, "stream")).toBeUndefined();
  });

  test("Claude stream event: fractions become percentages, rejection without overage blocks", () => {
    const allowed = claudeRateLimitSnapshot({ status: "allowed", resetsAt: 100, rateLimitType: "five_hour", overageStatus: "rejected",
      unifiedWindows: { five_hour: { utilization: 0.6, resetsAt: 100 }, seven_day: { utilization: 0.46, resetsAt: 200 } } }, 1);
    expect(allowed).toMatchObject({ runtime: "claude", source: "stream", blocked: false,
      windows: [{ id: "five_hour", usedPercent: 60, resetsAt: 100_000 }, { id: "seven_day", usedPercent: 46, resetsAt: 200_000 }] });
    expect(claudeRateLimitSnapshot({ status: "rejected", rateLimitType: "seven_day", utilization: 1, resetsAt: 9 })).toMatchObject({ blocked: true, reachedType: "seven_day" });
    expect(claudeRateLimitSnapshot({ status: "rejected", rateLimitType: "seven_day", utilization: 1, overageStatus: "allowed" })?.blocked).toBe(false);
  });

  test("Claude get_usage: percentages, ISO resets, model-scoped weeklies and no account fields", () => {
    const s = claudeUsageSnapshot({ subscription_type: "max", rate_limits_available: true, rate_limits: {
      five_hour: { utilization: 61, resets_at: "2026-09-24T03:59:59Z" }, seven_day: { utilization: 46, resets_at: "2026-09-29T22:59:59Z" },
      seven_day_opus: { utilization: 12, resets_at: null }, seven_day_sonnet: null, tangelo: { utilization: 99 } }, email: "PRIVATE@example.com" }, 3);
    expect(s?.windows.map(w => [w.id, w.usedPercent])).toEqual([["five_hour", 61], ["seven_day", 46], ["seven_day_opus", 12]]);
    expect(s?.plan).toBe("max");
    expect(JSON.stringify(s)).not.toContain("PRIVATE");
    expect(claudeUsageSnapshot({ rate_limits_available: false })).toBeUndefined();
  });

  test("merge upserts sparse stream windows, keeps reset times, and a poll replaces", () => {
    const base = claudeUsageSnapshot({ rate_limits_available: true, rate_limits: { five_hour: { utilization: 10, resets_at: "2026-09-24T03:00:00Z" },
      seven_day: { utilization: 20, resets_at: "2026-09-29T03:00:00Z" } } }, 1)!;
    const merged = mergeLimits(base, { runtime: "claude", source: "stream", observedAt: 2, windows: [{ id: "five_hour", usedPercent: 30 }] });
    expect(merged.windows.find(w => w.id === "five_hour")).toMatchObject({ usedPercent: 30, resetsAt: Date.parse("2026-09-24T03:00:00Z") });
    expect(merged.windows).toHaveLength(2);
    expect(merged.observedAt).toBe(2);
    const blocked = mergeLimits(merged, { runtime: "claude", source: "stream", observedAt: 3, windows: [], blocked: true, reachedType: "five_hour" });
    expect(blocked).toMatchObject({ blocked: true, reachedType: "five_hour" });
    expect(mergeLimits(blocked, { runtime: "claude", source: "stream", observedAt: 4, windows: [] }).blocked).toBe(true);
    expect(mergeLimits(blocked, { ...base, observedAt: 5 }).blocked).toBeUndefined();
    expect(limitUtilization(merged, 0)).toBe(30);
  });
});

// Draft tests from foundry-jev-routing a60c664, unchanged in substance.
const request = { repository: "git@github.com:inixiative/kingdom.git", runtime: "codex" as const,
  model: "worker", effort: "medium", now: 1000, maximumObservationAgeMs: 500 };
const routes = [{ repository: "https://github.com/inixiative/kingdom", organizationId: "org", preferredAccountId: "owner" }];
const account = (id: string, percent: number): SubscriptionCandidate => ({ id, organizationIds: ["org"],
  runtime: "codex", authentication: "subscription", enabled: true, models: { worker: ["medium"] },
  activeRuns: 0, concurrencyLimit: 1, windows: [{ usedPercent: percent, reservedPercent: 0, observedAt: 900, resetsAt: 2000 }] });
const rank = (accounts: SubscriptionCandidate[]) => rankSubscriptionAccounts(request, routes, accounts).candidates.map(a => a.accountId);

describe("repository subscription routing (ported draft)", () => {
  test("SSH and HTTPS aliases map identically without giving forks authority", () => {
    expect(repositoryIdentity("ssh://git@github.com/Inixiative/Kingdom.git")).toBe(repositoryIdentity(request.repository));
    expect(() => rankSubscriptionAccounts({ ...request, repository: "https://github.com/elsewhere/kingdom" }, routes, [])).toThrow("ownership");
    expect(() => rankSubscriptionAccounts({ ...request, organizationId: "other" }, routes, [])).toThrow("conflicts");
    expect(() => rankSubscriptionAccounts(request, [...routes, ...routes], [])).toThrow("ambiguous");
  });
  test("rejects local, credential-bearing and ambiguous paths", () => {
    for (const value of ["/tmp/repo", "file:///tmp/repo", "https://user:secret@github.com/a/b",
      "https://github.com/a/b?key=x", "https://github.com/a/%62"]) expect(() => repositoryIdentity(value)).toThrow();
  });
  test("owner fills a quartile, lower quartiles then take spillover", () => {
    expect(rank([account("owner", 24), account("spare", 0)])).toEqual(["owner", "spare"]);
    for (const boundary of [25, 50, 75]) expect(rank([account("owner", boundary), account("spare", boundary - 1)])).toEqual(["spare", "owner"]);
    expect(rank([account("owner", 100), account("spare", 75)])).toEqual(["spare"]);
    expect(rankSubscriptionAccounts({ ...request, mode: "owner-first" }, routes, [account("owner", 99), account("spare", 0)]).candidates[0]!.accountId).toBe("owner");
  });
  test("spillover cannot widen organization, runtime, model or authentication grants", () => {
    const wrongOrg = { ...account("foreign", 0), organizationIds: ["other"] };
    expect(rank([wrongOrg, { ...account("paid", 0), authentication: "api-key" }, { ...account("other-runtime", 0), runtime: "claude" },
      { ...account("wrong-model", 0), models: { other: ["medium"] } }, account("owner", 70)])).toEqual(["owner"]);
  });
  test("unknown, stale, future and reset-crossing observations are excluded", () => {
    for (const patch of [{ usedPercent: null }, { usedPercent: NaN }, { observedAt: 499 }, { observedAt: 1001 }, { resetsAt: 1000 }, { reservedPercent: -1 }]) {
      const a = account("owner", 0); a.windows = [{ ...a.windows[0]!, ...patch }]; expect(rank([a])).toEqual([]);
    }
  });
  test("limiting usage window and retained reservations count; occupied profiles are excluded", () => {
    const a = account("owner", 0); a.windows = [...a.windows, { usedPercent: 49, reservedPercent: 1, observedAt: 900, resetsAt: 3000 }];
    expect(rank([a, account("spare", 25)])).toEqual(["spare", "owner"]);
    expect(rank([{ ...a, activeRuns: 1 }, account("spare", 25)])).toEqual(["spare"]);
    a.windows = []; expect(rank([a])).toEqual([]);
  });
});

describe("candidate ranking", () => {
  const base = { runtime: "codex" as const, model: "worker", effort: "medium", now: 1000, maximumObservationAgeMs: 500 };
  test("pinned serves only the preferred instance and requires one", () => {
    expect(rankCandidates({ ...base, mode: "pinned", preferredId: "owner" }, [account("owner", 90), account("spare", 0)]).candidates.map(c => c.accountId)).toEqual(["owner"]);
    expect(rankCandidates({ ...base, mode: "pinned", preferredId: "owner" }, [account("owner", 100), account("spare", 0)]).candidates).toEqual([]);
    expect(() => rankCandidates({ ...base, mode: "pinned" }, [])).toThrow("preferred");
  });
  test("every exclusion has a stated reason, and blocked or cooling-down instances are excluded", () => {
    const { excluded, candidates } = rankCandidates(base, [
      { ...account("blocked", 10), blocked: true }, { ...account("cooling", 10), unavailableUntil: 2000 },
      { ...account("off", 10), enabled: false }, { ...account("full", 10), activeRuns: 1 }, { ...account("stale", 10), windows: [{ usedPercent: 1, reservedPercent: 0, observedAt: 1, resetsAt: 2000 }] },
      { ...account("empty", 10), windows: [] }, account("ok", 10)]);
    expect(candidates.map(c => c.accountId)).toEqual(["ok"]);
    expect(excluded).toEqual({ blocked: "blocked", cooling: "unavailable", off: "disabled", full: "occupied", stale: "stale-observation", empty: "no-observation" });
  });
  test("ranking is deterministic regardless of input order", () => {
    const accounts = [account("b", 10), account("a", 10), account("c", 60)];
    const first = rankCandidates(base, accounts).candidates.map(c => c.accountId);
    expect(first).toEqual(["a", "b", "c"]);
    expect(rankCandidates(base, [...accounts].reverse()).candidates.map(c => c.accountId)).toEqual(first);
  });
});
