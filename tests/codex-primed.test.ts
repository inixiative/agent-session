import { afterEach, describe, expect, test } from "bun:test";
import { CodexPrimedSessions, DecisionError, codexDecisionLaunchArgs, type PrimedEvent } from "../src";
import { fakeProcess, tick } from "./helpers/fake-process";

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const fn of cleanup.splice(0)) await fn(); });

type Behavior = "answer" | "slow-answer" | "hold" | "hold-ignore" | "tool" | "rate-limit" | "fail" | "server-request";
interface DoubleOptions { account?: string; blocked?: boolean; orphans?: string[]; behavior?: (input: string, occurrence: number) => Behavior; forkError?: boolean }

/** codex app-server double: persisted threads, forks, turns and account reads. */
function appServer(opts: DoubleOptions = {}) {
  const processes: ReturnType<typeof fakeProcess>[] = [];
  const argvs: string[][] = [], envs: Record<string, string | undefined>[] = [];
  let threads = 0, turns = 0;
  const seen = new Map<string, number>();
  const ignoreInterrupt = new Set<string>();
  const threadMeta = new Map<string, { ephemeral: boolean; parent?: string; lastTurnId?: string; developer?: string; base?: string }>();
  const spawn = (argv: string[], options: { env: Record<string, string | undefined> }) => {
    argvs.push(argv); envs.push(options.env);
    const fake = fakeProcess((m, io) => {
      const reply = (result: unknown) => io.emit({ id: m.id, result });
      const fail = (message: string) => io.emit({ id: m.id, error: { code: -32600, message } });
      const p = m.params ?? {};
      switch (m.method) {
        case "initialize": return reply({ userAgent: "double" });
        case "account/read": return reply({ account: opts.account === "apiKey" ? { type: "apiKey" } : { type: "chatgpt", email: "PRIVATE@example.com", planType: "pro" } });
        case "account/rateLimits/read": return reply({ ordinaryUsageAllowed: !opts.blocked, rateLimits: { limitId: "codex", primary: { usedPercent: opts.blocked ? 100 : 20, resetsAt: 4_000_000_000 } } });
        case "thread/list": return reply({ data: (opts.orphans ?? []).map(id => ({ id, cwd: p.cwd })), nextCursor: null });
        case "thread/delete": case "thread/unsubscribe": return reply({ status: "ok" });
        case "thread/start": {
          const id = `thread-${++threads}`;
          threadMeta.set(id, { ephemeral: p.ephemeral, developer: p.developerInstructions, base: p.baseInstructions });
          return reply({ thread: { id, status: { type: "idle" }, turns: [] }, model: "gpt-observed" });
        }
        case "thread/fork": {
          if (opts.forkError) return fail("no rollout found");
          const id = `fork-${++threads}`;
          threadMeta.set(id, { ephemeral: p.ephemeral, parent: p.threadId, lastTurnId: p.lastTurnId, developer: p.developerInstructions, base: p.baseInstructions });
          return reply({ thread: { id, status: { type: "idle" }, turns: [] }, model: "gpt-observed" });
        }
        case "turn/start": {
          const turnId = `turn-${++turns}`, threadId = p.threadId, raw = p.input[0].text as string;
          // An inline (unprimed) decision carries the context before its input; judge the cycle input only.
          const input = raw.includes("standing context") ? raw : raw.split("\n\n").at(-1)!;
          reply({ turn: { id: turnId, status: "inProgress", items: [] } });
          const emit = (method: string, params: Record<string, unknown>) => io.emit({ method, params: { threadId, ...params } });
          emit("turn/started", { turn: { id: turnId, status: "inProgress", items: [] } });
          emit("item/started", { item: { id: `u${turnId}`, type: "userMessage" } });
          const occurrence = (seen.get(input) ?? 0) + 1; seen.set(input, occurrence);
          const behavior = input.includes("standing context") ? "answer" : opts.behavior?.(input, occurrence) ?? "answer";
          if (behavior === "hold") return;
          if (behavior === "hold-ignore") { ignoreInterrupt.add(turnId); return; }
          if (behavior === "tool") { emit("item/started", { item: { id: "cmd", type: "commandExecution", command: "ls" } }); return; }
          if (behavior === "server-request") { io.emit({ id: "srv-1", method: "item/commandExecution/requestApproval", params: { threadId, turnId } }); return; }
          if (behavior === "rate-limit" || behavior === "fail") {
            emit("turn/completed", { turn: { id: turnId, status: "failed", items: [], error: { message: behavior === "rate-limit" ? "limit" : "boom",
              codexErrorInfo: behavior === "rate-limit" ? "usageLimitExceeded" : "internalServerError" } } });
            return;
          }
          const text = input.includes("standing context") ? "OK" : `decided: ${input}`;
          const answer = () => {
            emit("item/completed", { item: { id: `a${turnId}`, type: "agentMessage", text, phase: "final_answer" } });
            emit("thread/tokenUsage/updated", { tokenUsage: { last: { inputTokens: 100, cachedInputTokens: 80, outputTokens: 5, reasoningOutputTokens: 1 } } });
            emit("turn/completed", { turn: { id: turnId, status: "completed", items: [], error: null } });
          };
          if (behavior === "slow-answer") setTimeout(answer, 150); else answer();
          return;
        }
        case "turn/interrupt": {
          reply({});
          if (!ignoreInterrupt.has(p.turnId))
            io.emit({ method: "turn/completed", params: { threadId: p.threadId, turn: { id: p.turnId, status: "interrupted", items: [], error: null } } });
          return;
        }
      }
    });
    processes.push(fake);
    return fake.proc;
  };
  const requests = (method?: string) => processes.flatMap(p => p.lines).filter(l => !method || l.method === method);
  return { spawn, processes, argvs, envs, requests, threadMeta };
}

function host(double: ReturnType<typeof appServer>, extra: Partial<ConstructorParameters<typeof CodexPrimedSessions>[0]> = {}) {
  const events: PrimedEvent[] = [];
  const h = new CodexPrimedSessions({ model: "gpt-test", effort: "low", cwd: "/private/decisions", spawn: double.spawn,
    baseInstructions: "BASE", onEvent: e => events.push(e), timeoutMs: 2_000, ...extra });
  cleanup.push(() => h.close());
  return { h, events };
}

const spec = { key: "t1:aux:domain:api", instructions: "ROLE", context: "DOMAIN CACHE" };

describe("CodexPrimedSessions", () => {
  test("launch disables tool surfaces and strips API keys; the account must be a ChatGPT login", async () => {
    const argv = codexDecisionLaunchArgs();
    expect(argv).toEqual(expect.arrayContaining(["app-server", "--listen", "stdio://", "--disable", "shell_tool"]));
    // Only approval and web-search overrides at launch: credential launchers allowlist exactly these.
    expect(argv.filter((_, i) => argv[i - 1] === "-c")).toEqual(['approval_policy="never"', 'web_search="disabled"']);
    const prior = process.env.OPENAI_API_KEY; process.env.OPENAI_API_KEY = "sk-PRIVATE";
    try {
      const d = appServer(); const { h } = host(d, { env: { CODEX_HOME: "/profiles/c" } });
      await h.start();
      expect(d.envs[0]!.CODEX_HOME).toBe("/profiles/c");
      expect(d.envs[0]!.OPENAI_API_KEY).toBeUndefined();
      expect(h.limits()).toMatchObject({ source: "poll", windows: [{ usedPercent: 20 }] });
      expect(JSON.stringify(h.snapshot())).not.toContain("PRIVATE");
    } finally { if (prior === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = prior; }
    const refused = host(appServer({ account: "apiKey" })).h;
    await expect(refused.decide(spec, { input: "x" })).rejects.toMatchObject({ reason: "auth", dispatch: "not-dispatched" });
  });

  test("a miss decides inline at once and primes off-path; later cycles fork the primed thread", async () => {
    const d = appServer(); const { h, events } = host(d);
    const first = await h.decide(spec, { input: "q1" });
    expect(first).toMatchObject({ content: "decided: q1", prime: "cold", model: "gpt-observed", tokens: { input: 20, cacheRead: 80, output: 5, thinking: 1 } });
    // The inline decision carried the context itself, on an ephemeral thread with the role instructions.
    const inline = d.requests("thread/start").find(r => r.params.ephemeral === true)!;
    expect(inline.params).toMatchObject({ developerInstructions: "ROLE", baseInstructions: "BASE", sandbox: "read-only", approvalPolicy: "never",
      config: { "mcp_servers.node_repl.enabled": false, notify: [], include_environment_context: false } });
    expect(d.requests("turn/start").find(r => !String(r.params.input[0].text).includes("standing context"))!.params.input[0].text).toBe("DOMAIN CACHE\n\nq1");
    await h.prime(spec); // joins the background priming started by the miss
    const persisted = d.requests("thread/start").filter(r => r.params.ephemeral === false);
    expect(persisted).toHaveLength(1);
    const second = await h.decide(spec, { input: "q2" });
    const third = await h.decide(spec, { input: "q3" });
    expect([second.prime, third.prime]).toEqual(["warm", "warm"]);
    const primer = d.requests("turn/start").find(r => String(r.params.input[0].text).includes("standing context"))!.params;
    expect(primer.input[0].text).toStartWith("DOMAIN CACHE");
    const forks = d.requests("thread/fork");
    expect(forks).toHaveLength(2);
    const primerTurn = d.requests("turn/start").indexOf(d.requests("turn/start").find(r => r.params === primer)!) + 1;
    for (const fork of forks) expect(fork.params).toMatchObject({ lastTurnId: `turn-${primerTurn}`,
      ephemeral: true, developerInstructions: "ROLE", baseInstructions: "BASE", config: { "mcp_servers.node_repl.enabled": false } });
    expect(new Set(forks.map(f => f.params.threadId))).toEqual(new Set([primer.threadId]));
    // Warm decisions send only the cycle input and never run on the primed thread itself.
    const warmTurns = d.requests("turn/start").filter(r => String(r.params.threadId).startsWith("fork-"));
    expect(warmTurns.map(r => r.params.input[0].text)).toEqual(["q2", "q3"]);
    expect(d.requests("thread/unsubscribe").map(r => r.params.threadId)).toEqual([first.threadId, second.threadId, third.threadId]);
    expect(events.filter(e => e.type === "primed")).toHaveLength(1);
  });

  test("a changed context retires the old primed thread and runs inline; empty context needs no primer", async () => {
    const d = appServer(); const { h, events } = host(d);
    await h.prime(spec);
    expect((await h.decide(spec, { input: "q1" })).prime).toBe("warm");
    const again = await h.decide({ ...spec, context: "NEW CACHE" }, { input: "q2" });
    expect(again.prime).toBe("cold");
    await tick(5);
    expect(d.requests("thread/delete").map(r => r.params.threadId)).toContain("thread-1");
    expect(events.some(e => e.type === "evicted" && e.reason === "reprime")).toBe(true);
    const plain = await h.decide({ key: "t1:aux:agent:classifier", instructions: "CLASSIFY" }, { input: "hello" });
    expect(plain.content).toBe("decided: hello");
    const plainStart = d.requests("thread/start").at(-1)!.params;
    expect(plainStart).toMatchObject({ ephemeral: true, developerInstructions: "CLASSIFY" });
  });

  test("admission runs before the native write; a refusal dispatches nothing", async () => {
    const d = appServer(); const { h } = host(d);
    await h.prime(spec);
    let seen: unknown;
    await h.decide(spec, { input: "q1", onAdmission: a => { seen = a; expect(d.requests("turn/start")).toHaveLength(1); } });
    expect(seen).toMatchObject({ key: spec.key, runtime: "codex", threadId: expect.stringMatching(/^fork-/) });
    const error = await h.decide(spec, { input: "q2", onAdmission: () => { throw Error("journal refused"); } }).catch(e => e);
    expect(error).toBeInstanceOf(DecisionError);
    expect(error).toMatchObject({ reason: "admission", dispatch: "not-dispatched", settled: true });
    expect(d.requests("turn/start").filter(r => r.params.input[0].text === "q2")).toHaveLength(0);
  });

  test("tool activity is a violation: interrupted, process recycled, next decision re-primes on a fresh process", async () => {
    const d = appServer({ behavior: input => input === "bad" ? "tool" : "answer" }); const { h, events } = host(d);
    await h.prime(spec);
    const error = await h.decide(spec, { input: "bad" }).catch(e => e);
    expect(error).toMatchObject({ reason: "violation", dispatch: "attempted", settled: true });
    expect(d.requests("turn/interrupt")).toHaveLength(1);
    expect(d.processes[0]!.killed).toBe(true);
    expect(events.some(e => e.type === "process-recycled")).toBe(true);
    const next = await h.decide(spec, { input: "q3" });
    expect(next.prime).toBe("cold");
    expect(d.processes).toHaveLength(2);
  });

  test("a server request on a decision thread is refused and treated as a violation", async () => {
    const d = appServer({ behavior: () => "server-request" }); const { h } = host(d);
    const error = await h.decide(spec, { input: "q" }).catch(e => e);
    expect(error.reason).toBe("violation");
    expect(d.processes[0]!.lines.find(l => l.id === "srv-1")?.error?.code).toBe(-32601);
  });

  test("deadline interrupts the turn and reports acknowledged settlement", async () => {
    const d = appServer({ behavior: input => input === "slow" ? "hold" : "answer" }); const { h } = host(d);
    await h.prime(spec);
    const error = await h.decide(spec, { input: "slow", timeoutMs: 150 }).catch(e => e);
    expect(error).toMatchObject({ reason: "timeout", dispatch: "attempted", settled: true });
    expect(d.requests("turn/interrupt")).toHaveLength(1);
    expect(d.processes[0]!.killed).toBe(false);
  });

  test("usage limits refuse before dispatch; a rate-limited turn blocks further admissions", async () => {
    const blocked = host(appServer({ blocked: true })).h;
    await expect(blocked.decide(spec, { input: "q" })).rejects.toMatchObject({ reason: "rate-limited", dispatch: "not-dispatched" });
    const d = appServer({ behavior: input => input === "limited" ? "rate-limit" : "answer" }); const { h } = host(d);
    await h.decide(spec, { input: "q1" });
    await expect(h.decide(spec, { input: "limited" })).rejects.toMatchObject({ reason: "rate-limited", dispatch: "attempted", settled: true });
    await expect(h.decide(spec, { input: "q2" })).rejects.toMatchObject({ reason: "rate-limited", dispatch: "not-dispatched" });
  });

  test("a lost primed thread fails the branch before dispatch and is retired", async () => {
    const d = appServer({ forkError: true }); const { h } = host(d);
    await h.prime(spec);
    expect(h.snapshot().sessions).toBe(1);
    await expect(h.decide(spec, { input: "q1" })).rejects.toMatchObject({ reason: "transport", dispatch: "not-dispatched" });
    expect(h.snapshot().sessions).toBe(0);
  });

  test("decisions on one key run concurrently; priming is deduplicated per key and context", async () => {
    const d = appServer(); const { h } = host(d, { maxConcurrent: 3 });
    const results = await Promise.all([h.decide(spec, { input: "a" }), h.decide(spec, { input: "b" }),
      h.decide({ ...spec, key: "t2:aux:domain:api" }, { input: "c" })]);
    expect(results.map(r => r.content)).toEqual(["decided: a", "decided: b", "decided: c"]);
    await Promise.all([h.prime(spec), h.prime({ ...spec, key: "t2:aux:domain:api" })]);
    expect(d.requests("thread/start").filter(r => r.params.ephemeral === false)).toHaveLength(2);
    const warm = await Promise.all([h.decide(spec, { input: "d" }), h.decide(spec, { input: "e" })]);
    expect(warm.map(r => r.prime)).toEqual(["warm", "warm"]);
  });

  test("a key whose context changes every cycle stops priming until its context repeats", async () => {
    const d = appServer(); const { h } = host(d);
    const persisted = () => d.requests("thread/start").filter(r => r.params.ephemeral === false).length;
    await h.decide({ ...spec, context: "C1" }, { input: "a" }); await h.prime({ ...spec, context: "C1" });
    await h.decide({ ...spec, context: "C2" }, { input: "b" }); await tick(5); // C1 replaced unused: the key is volatile
    const afterVolatile = persisted();
    await h.decide({ ...spec, context: "C3" }, { input: "c" }); await tick(5);
    expect(persisted()).toBe(afterVolatile); // no primer spent on a context seen once
    await h.decide({ ...spec, context: "C3" }, { input: "d" }); await tick(5);
    expect(persisted()).toBe(afterVolatile + 1); // repeated context primes again
    expect((await h.decide({ ...spec, context: "C3" }, { input: "e" })).prime).toBe("warm");
  });

  test("start sweeps orphaned primed threads in its private directory only", async () => {
    const d = appServer({ orphans: ["old-1", "old-2"] }); const { h } = host(d);
    await h.start();
    expect(d.requests("thread/list")[0]!.params).toMatchObject({ cwd: "/private/decisions", sourceKinds: ["appServer"] });
    expect(d.requests("thread/list")[0]!.params.originators).toBeUndefined();
    expect(d.requests("thread/delete").map(r => r.params.threadId)).toEqual(["old-1", "old-2"]);
  });

  test("eviction and close delete primed threads; closed hosts refuse", async () => {
    const d = appServer(); const { h, events } = host(d);
    await h.prime(spec);
    await h.decide(spec, { input: "q1" });
    await h.evict(spec.key);
    expect(d.requests("thread/delete").map(r => r.params.threadId)).toEqual(["thread-1"]);
    await h.prime(spec);
    await h.decide(spec, { input: "q2" });
    await h.close();
    expect(events.filter(e => e.type === "evicted").map(e => (e as { reason: string }).reason)).toEqual(["requested", "close"]);
    await expect(h.decide(spec, { input: "q3" })).rejects.toMatchObject({ reason: "closed" });
  });

  test("process loss drops primed sessions; the next decision starts a new process and re-primes", async () => {
    const d = appServer(); const { h, events } = host(d);
    await h.prime(spec);
    await h.decide(spec, { input: "q1" });
    d.processes[0]!.io.exit(1);
    await tick(10);
    expect(events.some(e => e.type === "evicted" && e.reason === "process-lost")).toBe(true);
    expect((await h.decide(spec, { input: "q2" })).prime).toBe("cold");
    expect(d.processes).toHaveLength(2);
  });
});

describe("CodexPrimedSessions launch failures", () => {
  test("a refused or throwing launcher fails before dispatch and a later launch can succeed", async () => {
    const good = appServer();
    let attempts = 0;
    const h = new CodexPrimedSessions({ model: "gpt-test", cwd: "/private/decisions", spawn: async (argv, options) => {
      if (++attempts === 1) throw Error("lock held");
      return good.spawn(argv, options);
    } });
    cleanup.push(() => h.close());
    await expect(h.decide(spec, { input: "q" })).rejects.toMatchObject({ reason: "transport", dispatch: "not-dispatched" });
    expect((await h.decide(spec, { input: "q2" })).content).toBe("decided: q2");
  });
});

describe("CodexPrimedSessions review regressions", () => {
  test("a recycle fails every in-flight branch on that process at once, even after a new process started", async () => {
    const d = appServer({ behavior: input => input === "bad" ? "tool" : input === "slow" ? "hold" : "answer" });
    const { h } = host(d, { maxConcurrent: 4, timeoutMs: 5_000 });
    await h.prime({ ...spec, key: "b" });
    await h.prime({ ...spec, key: "a" });
    const started = Date.now();
    const slow = h.decide({ ...spec, key: "b" }, { input: "slow" }).catch(e => e);
    await tick(10);
    const bad = h.decide({ ...spec, key: "a" }, { input: "bad" }).catch(e => e);
    expect((await bad).reason).toBe("violation");
    // A new process serves new work while the old one's branches are already failed, not left to their deadline.
    const fresh = await h.decide({ ...spec, key: "c" }, { input: "fresh" });
    expect(fresh.content).toBe("decided: fresh");
    const error = await slow;
    expect(error).toMatchObject({ reason: "transport", dispatch: "attempted", settled: true });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(d.processes.length).toBe(2);
  });
});

describe("CodexPrimedSessions cancellation", () => {
  test("an abort refuses queued work before dispatch and interrupts a running turn", async () => {
    const d = appServer({ behavior: input => input === "slow" ? "hold" : "answer" }); const { h } = host(d, { maxConcurrent: 1, timeoutMs: 5_000 });
    await h.prime(spec);
    const controller = new AbortController();
    const running = h.decide(spec, { input: "slow", signal: controller.signal }).catch(e => e);
    const waiting = h.decide({ ...spec, key: "other" }, { input: "q2", signal: controller.signal }).catch(e => e);
    await tick(10);
    controller.abort();
    expect(await running).toMatchObject({ reason: "aborted", dispatch: "attempted", settled: true });
    expect(await waiting).toMatchObject({ reason: "aborted", dispatch: "not-dispatched" });
    expect(d.requests("turn/interrupt")).toHaveLength(1);
    await expect(h.decide(spec, { input: "q3", signal: AbortSignal.abort() })).rejects.toMatchObject({ reason: "aborted", dispatch: "not-dispatched" });
    expect((await h.decide(spec, { input: "q4" })).content).toBe("decided: q4");
  });
});

describe("CodexPrimedSessions hedging", () => {
  test("a slow decision is hedged on a second branch; the first to finish wins and the other is interrupted", async () => {
    const d = appServer({ behavior: (input, occurrence) => input === "slow" && occurrence === 1 ? "hold" : "answer" });
    const { h, events } = host(d, { hedgeAfterMs: 60, timeoutMs: 2_000 });
    await h.prime(spec);
    const started = Date.now();
    const result = await h.decide(spec, { input: "slow" });
    expect(result).toMatchObject({ content: "decided: slow", prime: "warm", hedged: true });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(d.requests("thread/fork")).toHaveLength(2);
    // The other branch was interrupted and settled before the decision reported.
    expect(d.requests("turn/interrupt")).toHaveLength(1);
    expect(events.filter(e => e.type === "hedged")).toHaveLength(1);
    expect(d.processes[0]!.killed).toBe(false);
  });

  test("a decision that answers before the hedge threshold is never duplicated", async () => {
    const d = appServer(); const { h, events } = host(d, { hedgeAfterMs: 500 });
    await h.prime(spec);
    const result = await h.decide(spec, { input: "fast" });
    expect(result.hedged).toBeUndefined();
    expect(d.requests("thread/fork")).toHaveLength(1);
    expect(events.some(e => e.type === "hedged")).toBe(false);
  });

  test("if both branches stall, the deadline still interrupts and settles the decision", async () => {
    const d = appServer({ behavior: input => input === "stuck" ? "hold" : "answer" });
    const { h } = host(d, { hedgeAfterMs: 40, timeoutMs: 300 });
    await h.prime(spec);
    const error = await h.decide(spec, { input: "stuck" }).catch(e => e);
    expect(error).toMatchObject({ reason: "timeout", dispatch: "attempted", settled: true });
    await tick(20);
    expect(d.requests("turn/interrupt")).toHaveLength(2);
  });
});

describe("CodexPrimedSessions hedging review regressions", () => {
  test("a hedge never exceeds maxConcurrent", async () => {
    const d = appServer({ behavior: (input, n) => input === "slow" && n === 1 ? "hold" : "answer" });
    const { h, events } = host(d, { hedgeAfterMs: 40, maxConcurrent: 1, timeoutMs: 400 });
    await h.prime(spec);
    const error = await h.decide(spec, { input: "slow" }).catch(e => e);
    expect(error.reason).toBe("timeout");
    expect(events.some(e => e.type === "hedged")).toBe(false);
    expect(d.requests("thread/fork")).toHaveLength(1);
  });

  test("a hedge that fails natively does not beat a healthy original", async () => {
    const d = appServer({ behavior: (input, n) => input === "q" ? (n === 1 ? "slow-answer" : "rate-limit") : "answer" });
    const { h } = host(d, { hedgeAfterMs: 30 });
    await h.prime(spec);
    const result = await h.decide(spec, { input: "q" });
    expect(result).toMatchObject({ content: "decided: q", hedged: true });
    expect(h.limits()?.blocked).toBeFalsy();
  });

  test("an evicted key is not brought back by a prime that was already running", async () => {
    const d = appServer(); const { h } = host(d);
    await h.decide(spec, { input: "q1" }); // miss: priming starts in the background
    await h.evict(spec.key);
    await tick(30);
    expect(h.snapshot().sessions).toBe(0);
  });

  test("an interrupt the runtime never acknowledges on the other branch makes the decision recycle before reporting settled", async () => {
    const d = appServer({ behavior: (input, n) => input === "slow" ? (n === 1 ? "hold" : "hold-ignore") : "answer" });
    const { h } = host(d, { hedgeAfterMs: 40, timeoutMs: 300 });
    await h.prime(spec);
    const error = await h.decide(spec, { input: "slow" }).catch(e => e);
    expect(error).toMatchObject({ reason: "timeout", settled: true, hedged: true });
    expect(d.processes[0]!.killed).toBe(true);
  });
});
