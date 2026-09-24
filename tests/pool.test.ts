import { afterEach, describe, expect, test } from "bun:test";
import { ContinuityError, PoolExhaustedError, SubscriptionPool, type InstanceConfig, type LimitSnapshot, type PoolEvent } from "../src";
import { fakeProcess, tick } from "./helpers/fake-process";

const cleanup: Array<() => void> = [];
afterEach(() => { for (const fn of cleanup.splice(0)) fn(); });

const NOW = 1_000_000;
const limits = (runtime: "claude" | "codex", used: number, observedAt = NOW - 1_000): LimitSnapshot =>
  ({ runtime, source: "poll", observedAt, windows: [{ id: "w", usedPercent: used, resetsAt: NOW + 3_600_000 }] });

/** A Claude CLI double that records its launch and emits a rate limit on each turn. */
function claudeSpawn(record: Array<{ argv: string[]; env: Record<string, string | undefined> }>, usedFraction = 0.5) {
  return (argv: string[], options: { env: Record<string, string | undefined> }) => {
    record.push({ argv, env: options.env });
    const resume = argv.indexOf("--resume");
    const sid = resume >= 0 ? argv[resume + 1]! : `sid-${record.length}`;
    return fakeProcess((m, io) => {
      if (m.type !== "user") return;
      io.emit({ type: "system", subtype: "init", session_id: sid });
      io.emit({ type: "rate_limit_event", session_id: sid, rate_limit_info: { status: "allowed", rateLimitType: "five_hour",
        unifiedWindows: { five_hour: { utilization: usedFraction, resetsAt: (NOW + 3_600_000) / 1000 } } } });
      io.emit({ type: "result", subtype: "success", uuid: `r-${record.length}-${Math.random()}`, session_id: sid, result: "ok" });
    }).proc;
  };
}

function pool(instances: InstanceConfig[], extra: Partial<ConstructorParameters<typeof SubscriptionPool>[0]> = {}) {
  const events: PoolEvent[] = [];
  const probes: string[] = [];
  const p = new SubscriptionPool({ instances, now: () => NOW, onEvent: e => events.push(e),
    probe: async instance => { probes.push(instance.id); return undefined; }, ...extra });
  return { p, events, probes };
}

describe("SubscriptionPool", () => {
  test("instances derive continuation identity from their history home and inject the profile variable", () => {
    const { p } = pool([
      { id: "a", transport: "claude-cli", profileDirectory: "/profiles/a" },
      { id: "b", transport: "claude-agent-sdk", profileDirectory: "/profiles/a" },
      { id: "c", transport: "codex-app-server", profileDirectory: "/profiles/c", continuationKey: "shared-codex" },
    ]);
    expect(p.instances().map(i => [i.id, i.runtime, i.continuationKey])).toEqual([
      ["a", "claude", "claude:home:/profiles/a"], ["b", "claude", "claude:home:/profiles/a"], ["c", "codex", "shared-codex"]]);
    expect(() => pool([{ id: "x", transport: "acp" as never }])).toThrow("cannot be pooled");
    expect(() => pool([{ id: "x", transport: "claude-cli" }, { id: "x", transport: "claude-cli" }])).toThrow("Duplicate");
  });

  test("routes to the lowest-usage quartile, honors the preferred instance within it, and explains exclusions", () => {
    const { p, events } = pool([
      { id: "owner", transport: "codex-app-server", concurrencyLimit: 1 },
      { id: "spare", transport: "codex-app-server" },
      { id: "claude", transport: "claude-cli" },
      { id: "off", transport: "codex-app-server", enabled: false },
    ]);
    p.observeLimits("owner", limits("codex", 30));
    p.observeLimits("spare", limits("codex", 10));
    expect(p.rank({ runtime: "codex", model: "m" }).candidates.map(c => c.accountId)).toEqual(["spare", "owner"]);
    expect(p.rank({ runtime: "codex", model: "m", preferredInstanceId: "owner", mode: "owner-first" }).candidates[0]!.accountId).toBe("owner");
    p.observeLimits("owner", limits("codex", 12));
    expect(p.rank({ runtime: "codex", model: "m", preferredInstanceId: "owner" }).candidates[0]!.accountId).toBe("owner");
    const lease = p.acquire({ runtime: "codex", model: "m", preferredInstanceId: "owner" });
    expect(lease.instanceId).toBe("owner");
    expect(p.rank({ runtime: "codex", model: "m" }).excluded).toMatchObject({ owner: "occupied", off: "disabled" });
    lease.release(); lease.release();
    expect(events.filter(e => e.type === "released")).toHaveLength(1);
    p.observeLimits("spare", { ...limits("codex", 100), blocked: true });
    p.observeLimits("owner", limits("codex", 100));
    const error = (() => { try { p.acquire({ runtime: "codex", model: "m" }); } catch (e) { return e; } })() as PoolExhaustedError;
    expect(error).toBeInstanceOf(PoolExhaustedError);
    expect(error.excluded).toMatchObject({ owner: "exhausted", spare: "blocked", off: "disabled" });
    expect(events.some(e => e.type === "exhausted")).toBe(true);
  });

  test("model restrictions and organization boundaries are never widened by spillover", () => {
    const { p } = pool([
      { id: "work", transport: "codex-app-server", organizationIds: ["org-work"], models: { "gpt-a": ["low"] } },
      { id: "personal", transport: "codex-app-server", organizationIds: ["org-personal"] },
    ]);
    for (const id of ["work", "personal"]) p.observeLimits(id, limits("codex", 0));
    expect(p.rank({ runtime: "codex", model: "gpt-a", effort: "low", organizationId: "org-work" }).candidates.map(c => c.accountId)).toEqual(["work"]);
    expect(p.rank({ runtime: "codex", model: "gpt-b", organizationId: "org-work" }).excluded).toMatchObject({ work: "model", personal: "organization" });
  });

  test("failures cool an instance down with doubling backoff; success clears it", () => {
    const { p } = pool([{ id: "a", transport: "claude-cli" }], { failureCooldownMs: 1_000 });
    p.observeLimits("a", limits("claude", 0));
    p.reportFailure("a", "transport");
    expect(p.instances()[0]!.unavailableUntil).toBe(NOW + 1_000);
    p.reportFailure("a", "transport");
    expect(p.instances()[0]!.unavailableUntil).toBe(NOW + 2_000);
    expect(p.rank({ runtime: "claude", model: "m" }).excluded.a).toBe("unavailable");
    p.reportSuccess("a");
    expect(p.rank({ runtime: "claude", model: "m" }).candidates).toHaveLength(1);
  });

  test("open refreshes stale limits, launches on the instance profile, learns limits from the session and releases on end", async () => {
    const launches: Array<{ argv: string[]; env: Record<string, string | undefined> }> = [];
    const probed: string[] = [];
    const { p, events } = pool([
      { id: "a", transport: "claude-cli", profileDirectory: "/profiles/a", session: { spawn: claudeSpawn(launches, 0.4) } },
      { id: "b", transport: "claude-cli", profileDirectory: "/profiles/b", session: { spawn: claudeSpawn(launches) } },
    ], { probe: async instance => { probed.push(instance.id); expect(instance.env.CLAUDE_CONFIG_DIR).toBe(`/profiles/${instance.id}`);
      return limits("claude", instance.id === "a" ? 5 : 60); } });
    const { session, lease } = await p.open({ runtime: "claude", model: "sonnet" }, { cwd: "/w" });
    cleanup.push(() => session.kill());
    expect(probed.sort()).toEqual(["a", "b"]);
    expect(lease.instanceId).toBe("a");
    await session.start();
    expect(launches[0]!.env.CLAUDE_CONFIG_DIR).toBe("/profiles/a");
    expect(launches[0]!.argv).toEqual(expect.arrayContaining(["--model", "sonnet"]));
    await session.send("hi");
    expect(p.instances().find(i => i.id === "a")!.limits!.windows.find(w => w.id === "five_hour")!.usedPercent).toBe(40);
    session.kill(); await tick();
    expect(lease.released).toBe(true);
    expect(events.map(e => e.type)).toEqual(expect.arrayContaining(["limits", "allocated", "released"]));
  });

  test("continuity hands a thread only to an instance that shares its native history", async () => {
    const launches: Array<{ argv: string[]; env: Record<string, string | undefined> }> = [];
    const spawn = claudeSpawn(launches);
    const { p, events } = pool([
      { id: "a", transport: "claude-cli", continuationKey: "shared", session: { spawn } },
      { id: "b", transport: "claude-agent-sdk", continuationKey: "other", session: { query: () => { throw Error("unused"); } } },
      { id: "c", transport: "claude-cli", continuationKey: "shared", profileDirectory: "/profiles/c", session: { spawn } },
    ]);
    for (const id of ["a", "b", "c"]) p.observeLimits(id, limits("claude", 10));
    const opened = await p.open({ runtime: "claude", model: "m", preferredInstanceId: "a", mode: "pinned" });
    await opened.session.start();
    const done = await opened.session.send("work");
    const moved = await p.continueOn({ instanceId: "a", externalSessionId: done.externalSessionId!, session: opened.session, lease: opened.lease },
      { runtime: "claude", model: "m" });
    cleanup.push(() => moved.session.kill());
    expect(moved.lease.instanceId).toBe("c");
    expect(opened.session.alive).toBe(false);
    expect(opened.lease.released).toBe(true);
    await moved.session.start();
    expect(launches.at(-1)!.argv).toEqual(expect.arrayContaining(["--resume", done.externalSessionId!]));
    expect(launches.at(-1)!.env.CLAUDE_CONFIG_DIR).toBe("/profiles/c");
    expect(events.find(e => e.type === "handoff")).toMatchObject({ from: "a", to: "c", continuationKey: "shared" });
  });

  test("continuity refusals are explicit: no shared history, no native resume, unresolved native work", async () => {
    const { p, events } = pool([
      { id: "solo", transport: "claude-cli" },
      { id: "mcp-1", transport: "codex-mcp", continuationKey: "k" },
      { id: "mcp-2", transport: "codex-mcp", continuationKey: "k" },
      { id: "app-1", transport: "codex-app-server", continuationKey: "shared" },
      { id: "app-2", transport: "codex-app-server", continuationKey: "shared" },
    ]);
    const reason = async (binding: Parameters<SubscriptionPool["continueOn"]>[0], runtime: "claude" | "codex") => {
      try { await p.continueOn(binding, { runtime, model: "m" }); return "continued"; }
      catch (e) { expect(e).toBeInstanceOf(ContinuityError); return (e as ContinuityError).reason; }
    };
    expect(await reason({ instanceId: "solo", externalSessionId: "s" }, "claude")).toBe("no-shared-history");
    expect(await reason({ instanceId: "mcp-1", externalSessionId: "t" }, "codex")).toBe("resume-unsupported");
    const unresolved = { attempts: [{ dispatch: "attempted", nativeOutcome: "unknown" }], kill() { throw Error("must not kill"); } } as never;
    expect(await reason({ instanceId: "app-1", externalSessionId: "t", session: unresolved }, "codex")).toBe("unresolved-native-work");
    expect(await reason({ instanceId: "app-1", externalSessionId: "t" }, "codex")).toBe("targets-unavailable");
    expect(events.filter(e => e.type === "handoff-refused")).toHaveLength(4);
  });
});
