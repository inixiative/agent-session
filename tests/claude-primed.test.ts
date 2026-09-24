import { afterEach, describe, expect, test } from "bun:test";
import { CLAUDE_TEXT_ONLY_ARGS, ClaudePrimedSessions, type PrimedEvent } from "../src";
import { fakeProcess, tick } from "./helpers/fake-process";

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const fn of cleanup.splice(0)) await fn(); });

/** Claude CLI double: each process is one conversation; forks get new session ids. */
function claudeCli(opts: { behavior?: (input: string) => "answer" | "tool" | "hold" | "limited" } = {}) {
  const spawns: string[][] = [];
  const processes: ReturnType<typeof fakeProcess>[] = [];
  let forks = 0;
  const spawn = (argv: string[]) => {
    spawns.push(argv);
    const resumeAt = argv.indexOf("--resume");
    const sid = resumeAt >= 0 && argv.includes("--fork-session") ? `fork-${++forks}` : resumeAt >= 0 ? argv[resumeAt + 1]! : "base-sid";
    const fake = fakeProcess((m, io) => {
      if (m.type === "control_request") {
        if (m.request.subtype === "interrupt") {
          io.emit({ type: "control_response", response: { subtype: "success", request_id: m.request_id, response: {} } });
          io.emit({ type: "result", subtype: "error_during_execution", is_error: true, uuid: `int-${sid}`, session_id: sid, result: "" });
        }
        return;
      }
      if (m.type !== "user") return;
      const input = m.message.content[0].text as string;
      io.emit({ type: "system", subtype: "init", session_id: sid, model: "claude-test" });
      const behavior = input.includes("standing context") ? "answer" : opts.behavior?.(input) ?? "answer";
      if (behavior === "hold") return;
      if (behavior === "tool") io.emit({ type: "assistant", session_id: sid, message: { id: "t", model: "claude-test", role: "assistant", content: [{ type: "tool_use", id: "tu", name: "Bash", input: {} }] } });
      if (behavior === "limited") {
        io.emit({ type: "rate_limit_event", session_id: sid, rate_limit_info: { status: "rejected", rateLimitType: "five_hour", utilization: 1, resetsAt: 4_000_000_000 } });
        io.emit({ type: "result", subtype: "error_during_execution", is_error: true, api_error_status: 429, uuid: `r-${sid}`, session_id: sid, result: "rate limit" });
        return;
      }
      const text = input.includes("standing context") ? "OK" : `decided: ${input}`;
      io.emit({ type: "assistant", session_id: sid, message: { id: `m-${sid}`, model: "claude-test", role: "assistant", content: [{ type: "text", text }],
        usage: { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 8000 } } });
      io.emit({ type: "result", subtype: "success", uuid: `r-${sid}`, session_id: sid, result: text,
        usage: { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 8000, cache_creation_input_tokens: 0 } });
    });
    processes.push(fake);
    return fake.proc;
  };
  return { spawn, spawns, processes };
}

function host(cli: ReturnType<typeof claudeCli>, extra: Partial<ConstructorParameters<typeof ClaudePrimedSessions>[0]> = {}) {
  const events: PrimedEvent[] = [];
  const h = new ClaudePrimedSessions({ model: "haiku", cwd: "/private/claude-decisions", spawn: cli.spawn, baseInstructions: "BASE",
    onEvent: e => events.push(e), timeoutMs: 2_000, ...extra });
  cleanup.push(() => h.close());
  return { h, events };
}

const spec = { key: "t1:aux:domain:api", instructions: "ROLE", context: "DOMAIN CACHE" };

describe("ClaudePrimedSessions", () => {
  test("primes a persisted text-only session, then forks it per decision without persistence", async () => {
    const cli = claudeCli(); const { h } = host(cli);
    const first = await h.decide(spec, { input: "q1" });
    expect(first).toMatchObject({ content: "decided: q1", prime: "cold", model: "claude-test", tokens: { cacheRead: 8000 } });
    const base = cli.spawns[0]!;
    for (const flag of CLAUDE_TEXT_ONLY_ARGS) expect(base).toContain(flag);
    expect(base).not.toContain("--no-session-persistence");
    expect(base[base.indexOf("--append-system-prompt") + 1]).toBe("BASE\n\nROLE");
    expect(base).toEqual(expect.arrayContaining(["--max-turns", "1"]));
    const fork = cli.spawns[1]!;
    expect(fork).toEqual(expect.arrayContaining(["--resume", "base-sid", "--fork-session", "--no-session-persistence"]));
    expect(fork[fork.indexOf("--append-system-prompt") + 1]).toBe("BASE\n\nROLE");
    expect(cli.processes[0]!.lines[0].message.content[0].text).toStartWith("DOMAIN CACHE");
  });

  test("a warm spare is spawned after each decision, so the next decision pays no start", async () => {
    const cli = claudeCli(); const { h } = host(cli);
    await h.decide(spec, { input: "q1" });
    await tick(10);
    expect(cli.spawns).toHaveLength(3); // base, first fork, spare
    const second = await h.decide(spec, { input: "q2" });
    expect(second).toMatchObject({ prime: "warm", content: "decided: q2" });
    expect(cli.processes[2]!.lines[0].message.content[0].text).toBe("q2");
    expect(cli.processes[1]!.killed).toBe(true);
  });

  test("a changed hash re-primes; empty context uses fresh non-persisted sessions", async () => {
    const cli = claudeCli(); const { h, events } = host(cli, { spare: false });
    await h.decide(spec, { input: "q1" });
    expect((await h.decide({ ...spec, context: "NEW" }, { input: "q2" })).prime).toBe("cold");
    expect(events.some(e => e.type === "evicted" && e.reason === "reprime")).toBe(true);
    const plain = await h.decide({ key: "t1:aux:agent:router", instructions: "ROUTE" }, { input: "hi" });
    expect(plain.content).toBe("decided: hi");
    const argv = cli.spawns.at(-1)!;
    expect(argv).toContain("--no-session-persistence");
    expect(argv).not.toContain("--resume");
  });

  test("admission refusal dispatches nothing; tool activity is a violation", async () => {
    const cli = claudeCli({ behavior: input => input === "bad" ? "tool" : "answer" }); const { h } = host(cli, { spare: false });
    const refused = await h.decide(spec, { input: "q1", onAdmission: () => { throw Error("no"); } }).catch(e => e);
    expect(refused).toMatchObject({ reason: "admission", dispatch: "not-dispatched" });
    expect(cli.processes.slice(1).flatMap(p => p.lines).some(l => l.type === "user")).toBe(false);
    await expect(h.decide(spec, { input: "bad" })).rejects.toMatchObject({ reason: "violation", dispatch: "attempted" });
  });

  test("deadline interrupts through the control protocol and reports settlement", async () => {
    const cli = claudeCli({ behavior: input => input === "slow" ? "hold" : "answer" }); const { h } = host(cli, { spare: false });
    await h.decide(spec, { input: "q1" });
    const error = await h.decide(spec, { input: "slow", timeoutMs: 150 }).catch(e => e);
    expect(error).toMatchObject({ reason: "timeout", dispatch: "attempted", settled: true });
  });

  test("a rejected rate limit fails the decision and blocks the next one before dispatch", async () => {
    const cli = claudeCli({ behavior: input => input === "limited" ? "limited" : "answer" }); const { h } = host(cli, { spare: false });
    await h.decide(spec, { input: "q1" });
    await expect(h.decide(spec, { input: "limited" })).rejects.toMatchObject({ reason: "rate-limited", dispatch: "attempted" });
    expect(h.limits()?.blocked).toBe(true);
    await expect(h.decide(spec, { input: "q2" })).rejects.toMatchObject({ reason: "rate-limited", dispatch: "not-dispatched" });
  });

  test("close kills spares and refuses further decisions", async () => {
    const cli = claudeCli(); const { h } = host(cli);
    await h.decide(spec, { input: "q1" }); await tick(10);
    await h.close();
    expect(cli.processes.at(-1)!.killed).toBe(true);
    await expect(h.decide(spec, { input: "q2" })).rejects.toMatchObject({ reason: "closed" });
  });
});
