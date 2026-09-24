import { afterEach, describe, expect, test } from "bun:test";
import {
  AcpSession, ApiSession, ClaudeAgentSdkSession, ClaudeCodeSession, CLAUDE_TEXT_ONLY_ARGS, CodexAppServerSession, CodexMcpSession,
  TRANSPORTS, TransportUnavailableError, createSession, describeTransport, sdkOptionsFromArgv, type HarnessSession, type SessionEvent,
} from "../src";
import { fakeProcess, tick } from "./helpers/fake-process";

const cleanup: Array<() => void> = [];
afterEach(() => { for (const fn of cleanup.splice(0)) fn(); });

/** A Claude CLI double that answers turns, get_usage and interrupt over stream-json. */
function claudeDouble(opts: { hold?: boolean; sessionId?: string } = {}) {
  const sid = opts.sessionId ?? "claude-session";
  const commands: string[][] = [], envs: Record<string, string | undefined>[] = [];
  let turn = 0;
  const fake = fakeProcess((m, io) => {
    if (m.type === "user") {
      turn++;
      io.emit({ type: "system", subtype: "init", session_id: sid, model: "claude-test" });
      io.emit({ type: "rate_limit_event", session_id: sid, uuid: `rl-${turn}`, rate_limit_info: { status: "allowed", rateLimitType: "five_hour",
        unifiedWindows: { five_hour: { utilization: 0.25, resetsAt: 4_000_000_000 } } } });
      io.emit({ type: "assistant", session_id: sid, message: { id: `m${turn}`, role: "assistant", content: [{ type: "text", text: "partial" }] } });
      if (!opts.hold) io.emit({ type: "result", subtype: "success", uuid: `r${turn}`, session_id: sid, result: `answer ${turn}`, usage: { input_tokens: 3, output_tokens: 2 } });
    }
    if (m.type === "control_request") {
      const id = m.request_id;
      if (m.request.subtype === "get_usage") io.emit({ type: "control_response", response: { subtype: "success", request_id: id, response: {
        rate_limits_available: true, rate_limits: { five_hour: { utilization: 40, resets_at: "2099-01-01T00:00:00Z" } } } } });
      if (m.request.subtype === "interrupt") {
        io.emit({ type: "control_response", response: { subtype: "success", request_id: id, response: {} } });
        io.emit({ type: "result", subtype: "error_during_execution", is_error: true, uuid: `ri${turn}`, session_id: sid, result: "" });
      }
    }
  });
  const spawn = (cmd: string[], options: { env: Record<string, string | undefined> }) => { commands.push(cmd); envs.push(options.env); return fake.proc; };
  return { fake, spawn, commands, envs };
}

describe("transport matrix", () => {
  test("every implemented session reports its own descriptor; stubs are declared as stubs", () => {
    const spawn = () => fakeProcess().proc;
    expect(new ClaudeCodeSession({ spawn }).transport).toBe(TRANSPORTS["claude-cli"]);
    expect(new CodexMcpSession({ spawn }).transport).toBe(TRANSPORTS["codex-mcp"]);
    expect(new CodexAppServerSession({ spawn }).transport).toBe(TRANSPORTS["codex-app-server"]);
    expect(new ClaudeAgentSdkSession({ query: () => ({ interrupt: async () => {}, async *[Symbol.asyncIterator]() {} }) }).transport).toBe(TRANSPORTS["claude-agent-sdk"]);
    expect(Object.values(TRANSPORTS).filter(t => t.status === "stub").map(t => t.kind).sort()).toEqual(["acp", "api"]);
    for (const [kind, d] of Object.entries(TRANSPORTS)) expect(d.kind).toBe(kind as never);
  });

  test("capability flags match the methods each implementation exposes", () => {
    const spawn = () => fakeProcess().proc;
    const sessions: Record<"claude-cli" | "codex-mcp" | "codex-app-server", HarnessSession> = { "claude-cli": new ClaudeCodeSession({ spawn }),
      "codex-mcp": new CodexMcpSession({ spawn }), "codex-app-server": new CodexAppServerSession({ spawn }) };
    for (const [kind, session] of Object.entries(sessions)) {
      const caps = TRANSPORTS[kind as keyof typeof sessions].capabilities;
      expect(typeof session.interruptNative === "function").toBe(caps.interrupt === "acknowledged");
      expect(typeof session.readLimits === "function").toBe(caps.limits.poll);
    }
  });

  test("createSession switches transport by kind; stubs throw a typed error and never fall back", () => {
    const spawn = () => fakeProcess().proc;
    expect(createSession("claude-cli", { spawn })).toBeInstanceOf(ClaudeCodeSession);
    expect(createSession("codex-app-server", { spawn })).toBeInstanceOf(CodexAppServerSession);
    expect(createSession("codex-mcp", { spawn })).toBeInstanceOf(CodexMcpSession);
    expect(() => createSession("acp", { command: ["agent"] })).toThrow(TransportUnavailableError);
    expect(() => new AcpSession({ command: ["agent"] })).toThrow("acp");
    expect(() => new ApiSession({ provider: "anthropic", model: "m", apiKey: "k", allowApiBilling: true })).toThrow("not implemented");
    expect(() => new ApiSession({ provider: "anthropic", model: "m", apiKey: "k" } as never)).toThrow("allowApiBilling");
    expect(describeTransport("api").capabilities.billing).toBe("api");
    expect(() => describeTransport("nope" as never)).toThrow();
  });
});

describe("Claude CLI transport additions", () => {
  test("rate_limit_event becomes an account-level rate_limit event, never admission output", async () => {
    const d = claudeDouble(); const s = new ClaudeCodeSession({ spawn: d.spawn }); cleanup.push(() => s.kill());
    const events: SessionEvent[] = []; s.onEvent(e => events.push(e));
    await s.start(); const result = await s.send("hi");
    const limit = events.find(e => e.kind === "rate_limit")!;
    expect(limit).toMatchObject({ unattributedReason: "account-status", limits: { runtime: "claude", windows: [{ id: "five_hour", usedPercent: 25 }] } });
    expect(limit.admissionId).toBeUndefined();
    expect(result.events.some(e => e.kind === "rate_limit")).toBe(false);
    expect(result.content).toBe("answer 1");
    expect(s.limits?.windows[0]?.usedPercent).toBe(25);
  });

  test("readLimits uses get_usage without a model turn", async () => {
    const d = claudeDouble(); const s = new ClaudeCodeSession({ spawn: d.spawn }); cleanup.push(() => s.kill());
    await s.start();
    const limits = await s.readLimits();
    expect(limits).toMatchObject({ source: "poll", windows: [{ id: "five_hour", usedPercent: 40 }] });
    expect(d.fake.lines.some(l => l.type === "user")).toBe(false);
    await expect(new ClaudeCodeSession({ spawn: d.spawn }).readLimits()).rejects.toThrow("not running");
  });

  test("interruptNative is acknowledged through the control protocol and settles the turn natively", async () => {
    const d = claudeDouble({ hold: true }); const s = new ClaudeCodeSession({ spawn: d.spawn }); cleanup.push(() => s.kill());
    await s.start();
    expect(await s.interruptNative()).toBe("no-turn");
    const pending = s.send("long");
    await tick(5);
    expect(await s.interruptNative({ timeoutMs: 1_000 })).toBe("acknowledged");
    const result = await pending;
    expect(result).toMatchObject({ nativeOutcome: "failed", terminal: { subtype: "error_during_execution" } });
    expect(d.fake.lines.find(l => l.type === "control_request")?.request).toEqual({ subtype: "interrupt" });
  });

  test("text-only, no-persistence and profile env reach the launch; API keys never do", async () => {
    const d = claudeDouble(); const prior = process.env.ANTHROPIC_API_KEY; process.env.ANTHROPIC_API_KEY = "sk-PRIVATE";
    try {
      const s = new ClaudeCodeSession({ spawn: d.spawn, textOnly: true, persistSession: false, env: { CLAUDE_CONFIG_DIR: "/profiles/b", ANTHROPIC_AUTH_TOKEN: "PRIVATE" } });
      cleanup.push(() => s.kill());
      await s.start();
      const argv = d.commands[0]!;
      for (const flag of CLAUDE_TEXT_ONLY_ARGS) expect(argv).toContain(flag);
      expect(argv).toContain("--no-session-persistence");
      expect(d.envs[0]!.CLAUDE_CONFIG_DIR).toBe("/profiles/b");
      expect(d.envs[0]!.ANTHROPIC_API_KEY).toBeUndefined();
      expect(d.envs[0]!.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    } finally { if (prior === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = prior; }
  });

  test("fork keeps text-only, env and a spawn override", async () => {
    const d = claudeDouble(); const s = new ClaudeCodeSession({ spawn: d.spawn, textOnly: true, env: { CLAUDE_CONFIG_DIR: "/p" } });
    cleanup.push(() => s.kill());
    await s.start(); await s.send("hi"); s.kill();
    const other = claudeDouble();
    const f = s.fork({ persistSession: false, spawn: other.spawn }); cleanup.push(() => f.kill());
    await f.start();
    expect(other.commands[0]).toEqual(expect.arrayContaining(["--resume", "claude-session", "--fork-session", "--no-session-persistence", "--safe-mode"]));
    expect(other.envs[0]!.CLAUDE_CONFIG_DIR).toBe("/p");
  });

  test("CLI control requests are refused explicitly, never left hanging", async () => {
    const d = claudeDouble(); const s = new ClaudeCodeSession({ spawn: d.spawn }); cleanup.push(() => s.kill());
    await s.start();
    d.fake.io.emit({ type: "control_request", request_id: "cli-1", request: { subtype: "can_use_tool", tool_name: "Bash" } });
    await tick(5);
    expect(d.fake.lines.find(l => l.type === "control_response")?.response).toMatchObject({ subtype: "error", request_id: "cli-1" });
  });
});

/** Codex app-server double for the session transport. */
function appServerDouble() {
  let turns = 0;
  const fake = fakeProcess((m, io) => {
    const reply = (result: unknown) => io.emit({ id: m.id, result });
    const turnId = turns <= 1 ? "turn-1" : `turn-${turns}`;
    if (m.method === "initialize") reply({});
    if (m.method === "thread/start") reply({ thread: { id: "thread-1", status: { type: "idle" }, turns: [] }, model: "gpt-test" });
    if (m.method === "turn/start") {
      turns++;
      const id = turns === 1 ? "turn-1" : `turn-${turns}`;
      reply({ turn: { id, status: "inProgress", items: [] } });
      io.emit({ method: "turn/started", params: { threadId: "thread-1", turn: { id, status: "inProgress", items: [] } } });
      io.emit({ method: "account/rateLimits/updated", params: { rateLimits: { limitId: "codex", primary: { usedPercent: 12, resetsAt: 4_000_000_000 } } } });
    }
    if (m.method === "account/rateLimits/read") reply({ rateLimits: { limitId: "codex", primary: { usedPercent: 33, resetsAt: 4_000_000_000 } }, ordinaryUsageAllowed: true });
    if (m.method === "turn/interrupt") {
      reply({});
      io.emit({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: turnId, status: "interrupted", items: [], error: null } } });
    }
    if (m.method === "turn/steer") {
      if (m.params.expectedTurnId === "turn-1") reply({ turnId: "turn-1" }); else io.emit({ id: m.id, error: { code: -1, message: "no active turn" } });
    }
  });
  return { fake, spawn: () => fake.proc };
}

describe("Codex app-server transport additions", () => {
  test("rate-limit notifications become account-level events and readLimits polls without a turn", async () => {
    const d = appServerDouble(); const s = new CodexAppServerSession({ spawn: d.spawn, cwd: "/x" }); cleanup.push(() => s.kill());
    const events: SessionEvent[] = []; s.onEvent(e => events.push(e));
    await s.start();
    expect(await s.readLimits()).toMatchObject({ source: "poll", windows: [{ id: "primary", usedPercent: 33 }], blocked: false });
    const pending = s.send("hi"); await tick(5);
    const limit = events.filter(e => e.kind === "rate_limit").at(-1)!;
    expect(limit).toMatchObject({ unattributedReason: "account-status", limits: { windows: [{ id: "primary", usedPercent: 12 }] } });
    expect(limit.admissionId).toBeUndefined();
    d.fake.io.emit({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed", items: [], error: null } } });
    expect((await pending).nativeOutcome).toBe("completed");
  });

  test("interruptNative sends turn/interrupt for the owned turn and settles through its terminal", async () => {
    const d = appServerDouble(); const s = new CodexAppServerSession({ spawn: d.spawn, cwd: "/x" }); cleanup.push(() => s.kill());
    await s.start();
    expect(await s.interruptNative()).toBe("no-turn");
    const pending = s.send("long"); await tick(5);
    expect(await s.interruptNative({ timeoutMs: 1_000 })).toBe("acknowledged");
    expect(d.fake.lines.find(l => l.method === "turn/interrupt")?.params).toEqual({ threadId: "thread-1", turnId: "turn-1" });
    expect(await pending).toMatchObject({ nativeOutcome: "failed", terminal: { subtype: "interrupted" } });
    // Ownership released: the next turn can be admitted.
    const next = s.send("again"); await tick(5);
    d.fake.io.emit({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-2", status: "completed", items: [], error: null } } });
    expect(d.fake.lines.filter(l => l.method === "turn/start")).toHaveLength(2);
    expect((await next).nativeOutcome).toBe("completed");
  });

  test("push steers the owned in-flight turn; without one it records push_ignored", async () => {
    const d = appServerDouble(); const s = new CodexAppServerSession({ spawn: d.spawn, cwd: "/x" }); cleanup.push(() => s.kill());
    const events: SessionEvent[] = []; s.onEvent(e => events.push(e));
    await s.start();
    await s.push({ kind: "guard", text: "early" });
    expect(events.find(e => e.kind === "error")?.text).toContain("push_ignored");
    const pending = s.send("long"); await tick(5);
    await s.push({ kind: "guard", text: "stop now" });
    expect(d.fake.lines.find(l => l.method === "turn/steer")?.params).toEqual({ threadId: "thread-1", expectedTurnId: "turn-1", input: [{ type: "text", text: "stop now" }] });
    expect(events.find(e => (e.raw as { type?: string })?.type === "push-steered")?.admissionId).toBe(s.attempts[0]!.admissionId);
    d.fake.io.emit({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed", items: [], error: null } } });
    await pending;
  });

  test("profile env reaches the Codex launch and forks", async () => {
    const envs: Record<string, string | undefined>[] = [];
    const s = new CodexMcpSession({ env: { CODEX_HOME: "/profiles/c" }, spawn: (_cmd, o) => { envs.push(o.env); return fakeProcess((m, io) => { if (m.id) io.emit({ id: m.id, result: {} }); }).proc; } });
    cleanup.push(() => s.kill());
    await s.start();
    expect(envs[0]!.CODEX_HOME).toBe("/profiles/c");
  });
});

describe("Agent SDK transport", () => {
  test("argv maps to SDK options; unmapped flags pass through extraArgs", () => {
    const options = sdkOptionsFromArgv(["--print", "--verbose", "--input-format", "stream-json", "--output-format", "stream-json",
      "--model", "sonnet", "--effort", "high", "--max-turns", "3", "--permission-mode", "bypassPermissions", "--include-hook-events",
      ...CLAUDE_TEXT_ONLY_ARGS, "--no-session-persistence", "--resume", "sid", "--fork-session", "--append-system-prompt", "base"]);
    expect(options).toEqual({ model: "sonnet", maxTurns: 3, permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true,
      tools: [], strictMcpConfig: true, mcpServers: {}, persistSession: false, resume: "sid", forkSession: true,
      systemPrompt: { type: "preset", preset: "claude_code", append: "base" },
      extraArgs: { effort: "high", "include-hook-events": null, "safe-mode": null, "disable-slash-commands": null, "no-chrome": null } });
  });

  function sdkDouble() {
    const calls: Array<{ options: Record<string, unknown> }> = [];
    let interrupts = 0;
    const query = ({ prompt, options }: { prompt: AsyncIterable<unknown>; options: Record<string, unknown> }) => {
      calls.push({ options });
      let interrupted: (() => void) | undefined;
      return {
        interrupt: async () => { interrupts++; interrupted?.(); },
        async *[Symbol.asyncIterator]() {
          let n = 0;
          for await (const message of prompt) {
            const text = (message as { message: { content: Array<{ text: string }> } }).message.content[0]!.text;
            n++;
            yield { type: "system", subtype: "init", session_id: "sdk-session" };
            if (text === "hold") {
              await new Promise<void>(resolve => { interrupted = resolve; });
              yield { type: "result", subtype: "error_during_execution", is_error: true, uuid: `x${n}`, session_id: "sdk-session", result: "" };
              continue;
            }
            yield { type: "assistant", session_id: "sdk-session", message: { id: `m${n}`, role: "assistant", content: [{ type: "text", text: `sdk ${text}` }] } };
            yield { type: "result", subtype: "success", uuid: `r${n}`, session_id: "sdk-session", result: `sdk ${text}`, usage: { input_tokens: 1, output_tokens: 1 } };
          }
        },
      };
    };
    return { query, calls, get interrupts() { return interrupts; } };
  }

  test("turns, SDK interrupt with acknowledgment, canUseTool and fork on the same transport", async () => {
    const sdk = sdkDouble();
    const canUseTool = async () => ({ behavior: "deny", message: "no" });
    const s = new ClaudeAgentSdkSession({ query: sdk.query, canUseTool, model: "haiku", permissionMode: "default", cwd: "/w", env: { CLAUDE_CONFIG_DIR: "/p" } });
    cleanup.push(() => s.kill());
    await s.start();
    expect((await s.send("one")).content).toBe("sdk one");
    expect(sdk.calls[0]!.options).toMatchObject({ model: "haiku", permissionMode: "default", cwd: "/w", canUseTool });
    expect((sdk.calls[0]!.options.env as Record<string, string>).CLAUDE_CONFIG_DIR).toBe("/p");
    const pending = s.send("hold"); await tick(5);
    expect(await s.interruptNative({ timeoutMs: 1_000 })).toBe("acknowledged");
    expect(sdk.interrupts).toBe(1);
    expect((await pending).nativeOutcome).toBe("failed");
    await expect(s.readLimits()).rejects.toThrow("not exposed");
    const f = s.fork(); cleanup.push(() => f.kill());
    expect(f.transport?.kind).toBe("claude-agent-sdk");
    await f.start(); await f.send("two");
    expect(sdk.calls[1]!.options).toMatchObject({ resume: "sdk-session", forkSession: true });
  });

  test("requires the caller's SDK query function", () => {
    expect(() => new ClaudeAgentSdkSession({} as never)).toThrow("query");
  });
});
