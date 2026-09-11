import { test, expect } from "bun:test";
import { ClaudeCodeSession, CodexMcpSession, type SessionEvent } from "../src";
const tick = () => new Promise(r => setTimeout(r, 5));
function setup(engine: "claude" | "mcp", resume = "native-session") {
  let out!: ReadableStreamDefaultController<Uint8Array>, exit!: (code: number) => void;
  const writes: any[] = [], spawns: string[][] = [];
  let writeFailure: Error | undefined;
  const emit = (v: unknown) => out.enqueue(new TextEncoder().encode(JSON.stringify(v) + "\n"));
  const proc = { stdin: { write(data: string) {
    const v = JSON.parse(data); writes.push(v);
    if (["initialize", "tools/list"].includes(v.method)) queueMicrotask(() => emit({ jsonrpc: "2.0", id: v.id, result: {} }));
    else if (writeFailure) throw writeFailure;
  }, flush() {}, end() {} }, stdout: new ReadableStream<Uint8Array>({ start(c) { out = c; } }),
  stderr: new ReadableStream<Uint8Array>({ start(c) { c.close(); } }),
  exited: new Promise<number>(r => { exit = r; }), kill() { try { out.close(); } catch {} exit(143); } };
  const session = engine === "claude" ? new ClaudeCodeSession({ externalSessionId: resume, timeout: 1000, spawn: cmd => { spawns.push(cmd); return proc; } })
    : new CodexMcpSession({ externalSessionId: resume, timeout: 1000, spawn: cmd => { spawns.push(cmd); return proc; } });
  const calls = () => writes.filter(v => engine === "claude" ? v.type === "user" : v.method === "tools/call");
  const native = (msg: any) => emit({ jsonrpc: "2.0", method: "codex/event", params: { id: msg.turn_id, msg } });
  const begin = (id = "turn-1") => engine === "mcp" && native({ type: "task_started", turn_id: id });
  const text = (value = "completed output", id = "turn-1") => engine === "claude" ? emit({ type: "assistant", session_id: resume, message: { id: "message-1", content: [{ type: "text", text: value }] } }) : native({ type: "agent_message", turn_id: id, message: value });
  const terminal = (id = "turn-1", failed = false, sessionId = resume) => engine === "claude"
    ? emit({ type: "result", uuid: id, session_id: sessionId, subtype: failed ? "error_during_execution" : "success", is_error: failed, result: "completed output" })
    : native({ type: "task_complete", turn_id: id });
  const rpc = (error?: string) => emit({ jsonrpc: "2.0", id: calls().at(-1).id, ...(error ? { error: { code: -1, message: error } } : { result: { structuredContent: { threadId: resume, content: "completed output" } } }) });
  return { session, calls, spawns, emit, begin, text, terminal, rpc,
    failWrite(e: Error) { writeFailure = e; }, failTransport() { out.error(new Error("transport broke")); },
    exit() { out.close(); exit(1); } };
}
// Synthetic ownership/lifecycle cases. No native process or extra recording.
for (const engine of ["claude", "mcp"] as const) {
  test(`${engine}: required admission registration precedes write and rejection never delivers`, async () => {
    const f = setup(engine); await f.session.start();
    try {
      let release!: () => void;
      let registered: string | undefined;
      const gate = new Promise<void>(resolve => { release = resolve; });
      const first = f.session.send("one", { onAdmission: async attempt => {
        registered = attempt.admissionId; expect(attempt.dispatch).toBe("not-dispatched");
        expect(Object.isFrozen(attempt)).toBe(true); await gate;
      } });
      await tick(); expect(f.calls()).toHaveLength(0); release(); await tick();
      expect(f.calls()).toHaveLength(1); f.begin(); f.terminal(); if (engine === "mcp") f.rpc();
      expect((await first).admissionId).toBe(registered);
      const original = Error("journal registration failed");
      const refused = await f.session.send("two", { onAdmission: () => { throw original; } }).catch(e => e);
      expect(refused.cause).toBe(original); expect(refused.attempt.localFailure).toBe("registration");
      expect(refused.attempt.dispatch).toBe("not-dispatched"); expect(f.calls()).toHaveLength(1);
      const next = f.session.send("three"); f.begin("turn-3"); f.terminal("turn-3"); if (engine === "mcp") f.rpc();
      expect((await next).nativeOutcome).toBe("completed"); expect(f.calls()).toHaveLength(2);
    } finally { f.session.kill(); }
  });
  test(`${engine}: interruption while registration waits cannot write after the gate resolves`, async () => {
    const f = setup(engine); await f.session.start();
    try {
      let release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      const pending = f.session.send("one", { onAdmission: () => gate }).catch(e => e);
      await tick(); f.session.interrupt(); const error = await pending; release(); await tick();
      expect(error.attempt.dispatch).toBe("not-dispatched"); expect(f.calls()).toHaveLength(0);
    } finally { f.session.kill(); }
  });
  for (const bufferedTerminal of [false, true]) test(`${engine}: second admission EOF preserves first transport, buffered terminal=${bufferedTerminal}`, async () => {
    const f = setup(engine); await f.session.start();
    try {
      const one = f.session.send("one"); f.begin(); f.terminal(); if (engine === "mcp") f.rpc();
      const first = await one;
      const two = f.session.send("two").catch(error => error); f.begin("turn-2"); f.text("second output", "turn-2");
      if (bufferedTerminal) f.terminal("turn-2");
      f.exit(); const second = await two; await tick();
      const after = f.session.attempts;
      expect(first.transportOutcome).toBe("open");
      expect(after[0].transportOutcome).toBe("open");
      expect(after[0].nativeOutcome).toBe("completed");
      expect(after[1].nativeOutcome).toBe(bufferedTerminal ? "completed" : "unknown");
      // Claude's terminal settles its stream send. MCP still owns an unanswered RPC.
      const settled = bufferedTerminal && engine === "claude";
      expect(after[1].transportOutcome).toBe(settled ? "open" : "failed");
      expect(after[1].localOutcome).toBe(settled ? "resolved" : "rejected");
      if (!settled) expect(second.attempt.localFailure).toBe("transport");
      expect(f.calls()).toHaveLength(2); expect(f.spawns).toHaveLength(1);
      expect(f.session.events.find(e => e.kind === "session_end")?.transportOutcome).toBe("failed");
    } finally { f.session.kill(); }
  });
  test(`${engine}: unresolved timeout retains later transport failure without rewriting the timeout snapshot`, async () => {
    const f = setup(engine); await f.session.start();
    try {
      const pending = f.session.send("one", { timeout: 10 }).catch(error => error); f.begin();
      const error = await pending, before = error.attempt;
      f.exit(); await tick();
      expect(error.attempt.transportOutcome).toBe("failed");
      expect(error.attempt.localFailure).toBe("timeout");
      expect(error.attempt.nativeOutcome).toBe("unknown");
      expect(before.transportOutcome).toBe("open"); expect(f.calls()).toHaveLength(1);
    } finally { f.session.kill(); }
  });
  test(`${engine}: startup, late, foreign and unknown evidence stays in history without adopting identity`, async () => {
    const f = setup(engine); await f.session.start();
    const lifecycle = (sessionId: string) => engine === "claude"
      ? f.emit({ type: "system", subtype: "init", session_id: sessionId, model: "controlled-model" })
      : f.emit({ method: "codex/event", params: { msg: { type: "session_configured", thread_id: sessionId } } });
    try {
      lifecycle("native-session"); await tick();
      // A Claude init is session configuration evidence; a Codex session_configured before any admission is no-admission history.
      const startup = f.session.events.find(e => e.unattributedReason === (engine === "claude" ? "session-configuration" : "no-admission"));
      expect(startup).toBeDefined(); expect(startup?.admissionId).toBeUndefined();
      expect(f.session.events.filter(e => e.kind === "session_compact")).toHaveLength(0);
      const first = f.session.send("one"); f.begin(); f.terminal(); if (engine === "mcp") f.rpc(); await first;
      f.text("late text"); await tick();
      const late = f.session.events.find(e => engine === "claude"
        ? (e.raw as any)?.message?.content?.[0]?.text === "late text"
        : (e.raw as any)?.params?.msg?.message === "late text");
      expect(late).toBeDefined(); expect(late?.admissionId).toBeUndefined();
      expect(late?.unattributedReason).toBe(engine === "claude" ? "no-admission" : "after-terminal");
      const second = f.session.send("two"); f.begin("turn-2");
      lifecycle("foreign-session");
      if (engine === "claude") {
        f.terminal("foreign-result", false, "foreign-session");
        f.emit({ type: "unknown-native-event", session_id: "native-session", nested: { evidence: ["controlled"] } });
      } else {
        f.terminal("foreign-turn");
        f.emit({ method: "codex/event", params: { msg: { type: "unknown-native-event", nested: { evidence: ["controlled"] } } } });
      }
      await tick();
      expect(f.session.attempts[1].nativeOutcome).toBe("unknown");
      expect(f.session.attempts[1].content).toBe("");
      expect(f.session.externalSessionId).toBe("native-session");
      const diagnostics = f.session.events.filter(e => e.unattributedReason);
      expect(diagnostics.some(e => e.unattributedReason === "foreign-session")).toBe(true);
      expect(diagnostics.some(e => e.unattributedReason === "unrecognized-event")).toBe(true);
      expect(diagnostics.every(e => !e.admissionId && e.correlation === "unknown")).toBe(true);
      const unknown = diagnostics.find(e => e.unattributedReason === "unrecognized-event")!;
      expect(Object.isFrozen(unknown.raw)).toBe(true);
      f.terminal("turn-2"); if (engine === "mcp") f.rpc();
      const result = await second;
      expect(result.events.some(e => e.unattributedReason)).toBe(false);
      expect(f.session.artifact().events).toContain(startup!);
      expect(f.calls()).toHaveLength(2);
    } finally { f.session.kill(); }
  });
  test(`${engine}: observer failures are counted without retaining payloads or hiding the original failure`, async () => {
    const f = setup(engine); await f.session.start();
    const stopSync = f.session.onEvent(() => { throw Error("private sync payload"); });
    const stopAsync = f.session.onEvent(async () => { throw Error("private async payload"); });
    try {
      const pending = f.session.send("one").catch(error => error); f.begin(); f.text(); await tick();
      f.failTransport(); const error = await pending; await tick();
      expect(error.message).toBe("transport broke"); expect(error.attempt.nativeOutcome).toBe("unknown");
      const diagnostics = f.session.diagnostics;
      expect(diagnostics.observerFailures.synchronous).toBeGreaterThan(0);
      expect(diagnostics.observerFailures.asynchronous).toBe(diagnostics.observerFailures.synchronous);
      expect(Object.isFrozen(diagnostics.observerFailures)).toBe(true);
      expect(f.session.artifact().diagnostics).toEqual(diagnostics);
      expect(JSON.stringify(f.session.artifact())).not.toContain("private");
      stopSync(); stopAsync(); f.session.kill();
      expect(f.session.diagnostics).toEqual(diagnostics);
    } finally { stopSync(); stopAsync(); f.session.kill(); }
  });
  test(`${engine}: bounded refusal sample retains every attempt without releasing unknown work`, async () => {
    const f = setup(engine); await f.session.start();
    try {
      const error = await f.session.send("one", { timeout: 5 }).catch(error => error);
      for (let i = 0; i < 100; i++) await f.session.send("refused").catch(() => {});
      const attempts = f.session.attempts;
      expect(attempts).toHaveLength(101);
      expect(attempts[0].admissionId).toBe(error.attempt.admissionId);
      expect(attempts[0].nativeOutcome).toBe("unknown");
      expect(attempts.slice(1).every(a => a.dispatch === "not-dispatched" && a.localFailure === "blocked")).toBe(true);
      expect(f.calls()).toHaveLength(1);
      console.log(JSON.stringify({ retentionSample: engine, refusedSends: 100, retainedAttempts: attempts.length,
        serializedSnapshotBytes: new TextEncoder().encode(JSON.stringify(attempts)).byteLength,
        meaning: "Controlled snapshot size, not resident heap or native capacity" }));
    } finally { f.session.kill(); }
  });
}

test("MCP RPC-only resolution still owns later EOF, while its historical returned result stays fixed", async () => {
  const f = setup("mcp"); await f.session.start();
  try {
    const pending = f.session.send("one"); f.begin(); f.rpc(); const result = await pending;
    f.exit(); await tick();
    expect(result.transportOutcome).toBe("open"); expect(result.nativeOutcome).toBe("unknown");
    expect(f.session.attempts[0].transportOutcome).toBe("failed");
    expect(f.session.attempts[0].localOutcome).toBe("resolved");
    expect(f.session.attempts[0].nativeOutcome).toBe("unknown");
    await expect(f.session.send("two")).rejects.toThrow(); expect(f.calls()).toHaveLength(1);
  } finally { f.session.kill(); }
});
for (const engine of ["claude", "mcp"] as const) {
  test(`${engine}: timeout retains ownership; queued and new sends never execute while unknown; late terminal stays original`, async () => {
    const f = setup(engine); await f.session.start();
    const first = f.session.send("one", { timeout: 15 }).catch(e => e);
    f.begin(); f.text("partial");
    const queued = f.session.send("queued").catch(e => e);
    const error = await first; expect(error.message).toContain("timed out");
    expect((await queued).attempt.dispatch).toBe("not-dispatched");
    const newcomer = await f.session.send("new").catch(e => e);
    expect(newcomer.attempt.dispatch).toBe("not-dispatched"); expect(f.calls()).toHaveLength(1);
    const id = error.attempt.admissionId;
    expect(error.attempt.nativeOutcome).toBe("unknown");
    f.text(); f.terminal(); if (engine === "mcp") f.rpc(); await tick();
    expect(error.attempt.nativeOutcome).toBe("completed"); expect(error.attempt.content).toBe("completed output");
    expect(error.attempt.admissionId).toBe(id); expect(error.attempt.localOutcome).toBe("rejected");
    const next = f.session.send("next"); f.begin("turn-2"); f.terminal("turn-1"); await tick();
    expect(f.calls()).toHaveLength(2);
    expect(f.session.attempts.at(-1)?.nativeOutcome).toBe("unknown");
    f.terminal("turn-2"); if (engine === "mcp") f.rpc();
    const result = await next; expect(result.nativeOutcome).toBe("completed"); expect(result.admissionId).not.toBe(id);
    expect(f.spawns).toHaveLength(1); expect(f.session.externalSessionId).toBe("native-session"); f.session.kill();
  });
  test(`${engine}: wrong identity and duplicate terminal cannot resolve current work`, async () => {
    const f = setup(engine); await f.session.start(); const result = f.session.send("one"); f.begin();
    if (engine === "mcp") f.terminal("wrong-turn"); else f.terminal("wrong-result", false, "wrong-session");
    await tick(); expect(f.session.attempts[0].nativeOutcome).toBe("unknown");
    f.terminal(); if (engine === "mcp") f.rpc(); expect((await result).nativeOutcome).toBe("completed"); f.session.kill();
  });
  test(`${engine}: observer exception cannot hide completion, and exit preserves terminal evidence`, async () => {
    const f = setup(engine); f.session.onEvent(() => { throw Error("observer"); }); await f.session.start();
    const pending = f.session.send("one").catch(e => e); f.begin(); f.text(); f.terminal();
    if (engine === "mcp") f.rpc("commit-like local infrastructure error");
    const result = await pending;
    expect(engine === "mcp" ? result.attempt.nativeOutcome : result.nativeOutcome).toBe("completed");
    if (engine === "mcp") { expect(result.message).toBe("commit-like local infrastructure error"); expect(result.attempt.content).toBe("completed output"); }
    f.exit(); await tick(); expect(f.session.attempts[0].nativeOutcome).toBe("completed");
    expect(f.session.attempts[0].content).toBe("completed output");
  });
  test(`${engine}: transport failure/kill never proves cancellation or permits automatic resume`, async () => {
    const f = setup(engine); await f.session.start(); const pending = f.session.send("one").catch(e => e); f.begin(); f.text("partial");
    await tick(); // Let the production reader observe partial text before the stream discards unread bytes.
    f.failTransport(); const err = await pending; expect(err.attempt.nativeOutcome).toBe("unknown");
    expect(err.attempt.content).toBe("partial"); f.session.kill();
    await expect(f.session.send("retry")).rejects.toThrow();
    await expect(f.session.start()).rejects.toThrow(); expect(f.spawns).toHaveLength(1);
    expect(f.session.externalSessionId).toBe("native-session");
  });
  test(`${engine}: write observer failure can occur after delivery; keep original error and unknown ownership`, async () => {
    const f = setup(engine); await f.session.start(); const failure = Error("original write failure"); f.failWrite(failure);
    const error = await f.session.send("one").catch(e => e);
    expect(error.cause).toBe(failure); expect(error.attempt.nativeOutcome).toBe("unknown");
    expect((await f.session.send("two").catch(e => e)).attempt.dispatch).toBe("not-dispatched");
    expect(f.calls()).toHaveLength(1); f.session.kill();
  });
}
test("MCP RPC resolution without native terminal stays unknown and blocks new work", async () => {
  const f = setup("mcp"); await f.session.start(); const pending = f.session.send("one"); f.begin(); f.rpc();
  const result = await pending; expect(result.nativeOutcome).toBe("unknown");
  await expect(f.session.send("two")).rejects.toThrow(); expect(f.calls()).toHaveLength(1);
  f.terminal(); await tick(); expect(f.session.attempts[0].nativeOutcome).toBe("completed"); f.session.kill();
});
test("Claude error result is native failed, not successful completion; missing usage stays unavailable", async () => {
  const f = setup("claude"); await f.session.start(); const pending = f.session.send("one"); f.terminal("turn-1", true);
  const result = await pending; expect(result.nativeOutcome).toBe("failed"); expect(result.tokens).toBeUndefined(); f.session.kill();
});

for (const engine of ["claude", "mcp"] as const) {
  test(`${engine}: terminal buffered immediately before exit survives transport failure`, async () => {
    const f = setup(engine); await f.session.start();
    const pending = f.session.send("one").catch(e => e); f.begin(); f.text(); f.terminal(); f.exit();
    const value = await pending; await tick();
    expect(f.session.attempts[0].nativeOutcome).toBe("completed");
    expect(f.session.attempts[0].content).toBe("completed output");
    expect(engine === "mcp" ? value.attempt.nativeOutcome : value.nativeOutcome).toBe("completed");
  });
  test(`${engine}: interrupt keeps native work unknown and prevents queued dispatch`, async () => {
    const f = setup(engine); await f.session.start();
    const first = f.session.send("one").catch(e => e); const second = f.session.send("two").catch(e => e);
    f.session.interrupt(); const error = await first;
    expect(error.attempt.nativeOutcome).toBe("unknown"); expect(error.attempt.localFailure).toBe("interrupt-request");
    expect((await second).attempt.dispatch).toBe("not-dispatched"); expect(f.calls()).toHaveLength(1); f.session.kill();
  });
  test(`${engine}: failure after a write retains later native success and original local error`, async () => {
    const f = setup(engine); await f.session.start(); const failure = Error("observer failed after forwarding"); f.failWrite(failure);
    const error = await f.session.send("one").catch(e => e); f.begin(); f.text(); f.terminal(); await tick();
    expect(error.cause).toBe(failure); expect(error.attempt.nativeOutcome).toBe("completed");
    expect(error.attempt.content).toBe("completed output"); expect(error.attempt.localOutcome).toBe("rejected");
    expect(f.calls()).toHaveLength(1); f.session.kill();
  });
  test(`${engine}: unavailable native identity remains absent; configured resume ID is not an observed acknowledgment`, async () => {
    const f = setup(engine); await f.session.start(); const pending = f.session.send("one").catch(e => e);
    expect(f.session.attempts[0].nativeSessionId).toBeUndefined(); expect(f.session.attempts[0].turnId).toBeUndefined();
    if (engine === "claude") expect(f.spawns[0].slice(-2)).toEqual(["--resume", "native-session"]);
    else expect(f.calls()[0].params).toMatchObject({ name: "codex-reply", arguments: { threadId: "native-session" } });
    f.session.kill(); await pending;
  });
}
test("MCP wrong envelope ID without inner turn_id cannot contaminate a later admission", async () => {
  const f = setup("mcp"); await f.session.start(); const first = f.session.send("one"); f.begin(); f.terminal(); f.rpc(); await first;
  const second = f.session.send("two");
  f.emit({ jsonrpc: "2.0", method: "codex/event", params: { id: "turn-1", msg: { type: "agent_message", message: "stale" } } });
  f.begin("turn-2"); await tick(); expect(f.session.attempts[1].content).toBe("");
  f.terminal("turn-2"); f.rpc(); await second; f.session.kill();
});
test("MCP RPC failure without native terminal is unresolved, not native failed/cancelled", async () => {
  const f = setup("mcp"); await f.session.start(); const pending = f.session.send("one").catch(e => e); f.begin(); f.rpc("RPC failed");
  const error = await pending; expect(error.attempt.nativeOutcome).toBe("unknown"); expect(error.attempt.rpcOutcome).toBe("failed");
  expect(error.message).toBe("RPC failed"); await expect(f.session.send("two")).rejects.toThrow(); f.session.kill();
});
for (const engine of ["claude", "mcp"] as const) test(`${engine}: asynchronous observer rejection cannot hide native completion`, async () => {
  const f = setup(engine); f.session.onEvent(async () => { throw Error("async observer failed"); });
  await f.session.start(); const result = f.session.send("one"); f.begin(); f.terminal(); if (engine === "mcp") f.rpc();
  expect((await result).nativeOutcome).toBe("completed"); await tick(); f.session.kill();
});
for (const engine of ["claude", "mcp"] as const) test(`${engine}: transport EOF emits session_end exactly once`, async () => {
  const f = setup(engine); await f.session.start(); const result = f.session.send("one").catch(e => e); f.exit(); await result; await tick();
  expect(f.session.events.filter(e => e.kind === "session_end")).toHaveLength(1); f.session.kill();
  expect(f.session.events.filter(e => e.kind === "session_end")).toHaveLength(1);
});
test("MCP native success followed by tools/call error preserves output and distinguishes RPC settlement", async () => {
  const f = setup("mcp"); await f.session.start(); const pending = f.session.send("one").catch(e => e); f.begin(); f.text(); f.terminal();
  f.emit({ jsonrpc: "2.0", id: f.calls()[0].id, result: { isError: true, content: [{ type: "text", text: "post-success infrastructure failure" }] } });
  const error = await pending; expect(error.message).toBe("post-success infrastructure failure");
  expect(error.attempt.content).toBe("completed output"); expect(error.attempt.nativeOutcome).toBe("completed");
  expect(error.attempt.rpcOutcome).toBe("resolved"); expect(error.attempt.localOutcome).toBe("rejected"); f.session.kill();
});
test("MCP conflicting result binding cannot replace the original resume binding", async () => {
  const f = setup("mcp"); await f.session.start(); const pending = f.session.send("one").catch(e => e); f.begin(); f.text(); f.terminal();
  f.emit({ jsonrpc: "2.0", id: f.calls()[0].id, result: { structuredContent: { threadId: "foreign-session", content: "foreign" } } });
  const error = await pending; expect(error.message).toContain("resume binding"); expect(f.session.externalSessionId).toBe("native-session");
  expect(error.attempt.content).toBe("completed output"); expect(error.attempt.nativeOutcome).toBe("completed"); f.session.kill();
});

// Synthetic contradictory envelopes; these variants are not native recordings.
for (const fields of [
  { api_error_status: 429 }, { api_error_status: 429, is_error: false },
  { terminal_reason: "api_error", is_error: false }, { subtype: "error_max_turns", is_error: false },
]) test(`Claude explicit error precedence: ${JSON.stringify(fields)}`, async () => {
  const f = setup("claude"); await f.session.start();
  try {
    const pending = f.session.send("one");
    f.emit({ type: "result", subtype: "success", session_id: "native-session", uuid: "result-1", result: "error evidence", ...fields });
    const result = await pending;
    expect(result.nativeOutcome).toBe("failed");
    expect(result.terminal?.apiErrorStatus).toBe("api_error_status" in fields ? fields.api_error_status : undefined);
    expect(result.terminal?.reason).toBe("terminal_reason" in fields ? fields.terminal_reason : undefined);
    expect(result.terminal?.subtype).toBe(fields.subtype ?? "success");
  } finally { f.session.kill(); }
});

test("Claude unrecognized terminal evidence stays unknown with its reason retained", async () => {
  const f = setup("claude"); await f.session.start();
  try {
    const pending = f.session.send("one").catch(error => error);
    f.emit({ type: "result", subtype: "unrecognized", terminal_reason: "unrecognized_reason", session_id: "native-session" });
    const error = await pending;
    expect(error.attempt.nativeOutcome).toBe("unknown");
    expect(error.attempt.terminal.reason).toBe("unrecognized_reason");
    expect(error.attempt.localFailure).toBe("unrecognized-terminal");
  } finally { f.session.kill(); }
});

function attemptMutation(fn: () => void) { try { fn(); } catch {} }
function mutateEvent(event: any) {
  attemptMutation(() => { event.text = "CORRUPTED"; });
  attemptMutation(() => { event.raw.annotation.values[0] = "CORRUPTED"; });
  attemptMutation(() => { event.raw.input.annotation.values[0] = "CORRUPTED"; });
  attemptMutation(() => { event.toolInput.annotation.values.push("CORRUPTED"); });
  attemptMutation(() => { event.toolInput.command = "CORRUPTED"; });
  attemptMutation(() => { event.raw.result = "CORRUPTED"; });
  attemptMutation(() => { event.tokens.input = 999; });
  attemptMutation(() => { event.raw.usage.input_tokens = 999; });
  attemptMutation(() => { event.terminal.type = "CORRUPTED"; });
}

for (const engine of ["claude", "mcp"] as const) {
  test(`${engine}: observers, results, snapshots and artifacts cannot rewrite nested retained evidence`, async () => {
    const f = setup(engine);
    const observerValues: SessionEvent[] = [];
    f.session.onEvent(async event => { mutateEvent(event); throw Error("rejecting observer"); });
    f.session.onEvent(event => { observerValues.push(event); });
    await f.session.start();
    try {
      const pending = f.session.send("one"); f.begin();
      const annotation = { values: ["ORIGINAL"] };
      if (engine === "claude") {
        f.emit({ type: "assistant", session_id: "native-session", message: { content: [
          { type: "tool_use", id: "call-1", name: "Bash", input: { annotation } },
        ] } });
        f.emit({ type: "result", subtype: "success", is_error: false, session_id: "native-session", uuid: "result-1",
          result: "completed output", usage: { input_tokens: 12, output_tokens: 3 } });
      } else {
        f.emit({ method: "codex/event", params: { id: "turn-1", msg: { type: "exec_command_begin", turn_id: "turn-1", call_id: "call-1", command: "ORIGINAL", annotation } } });
        f.emit({ method: "codex/event", params: { id: "turn-1", msg: { type: "token_count", info: { input_tokens: 12, output_tokens: 3 } } } });
        f.text(); f.terminal(); f.rpc();
      }
      const result = await pending;
      const snapshot = f.session.attempts[0], artifact = f.session.artifact(), count = f.session.events.length;
      for (const value of [result, snapshot, artifact.attempts![0]]) {
        value.events.forEach(mutateEvent);
        attemptMutation(() => { (value.events as SessionEvent[]).length = 0; });
        attemptMutation(() => { value.tokens!.input = 999; });
        attemptMutation(() => { (value.terminal as any).type = "CORRUPTED"; });
      }
      attemptMutation(() => { (f.session.events as SessionEvent[]).length = 0; });
      artifact.events.forEach(mutateEvent);
      expect(f.session.events).toHaveLength(count);
      for (const value of [result, snapshot, f.session.attempts[0]]) {
        expect(value.content).toBe("completed output"); expect(value.tokens).toEqual({ input: 12, output: 3 });
        expect(value.terminal?.type).toBe(engine === "claude" ? "result" : "task_complete");
        const tool = value.events.find(e => e.kind === "tool_use")!;
        const raw = tool.raw as any;
        expect(engine === "claude" ? raw.input.annotation.values : raw.annotation.values).toEqual(["ORIGINAL"]);
        expect(tool.toolInput).toEqual(engine === "claude" ? { annotation: { values: ["ORIGINAL"] } } : { command: "ORIGINAL" });
      }
      expect(observerValues.find(e => e.kind === "tool_use")).toBe(snapshot.events.find(e => e.kind === "tool_use"));
      expect(result.events.find(e => e.kind === "tool_use")).toBe(snapshot.events.find(e => e.kind === "tool_use"));
      // Immutable events are safely shared; historical result arrays do not grow.
      const historicalLength = result.events.length;
      const next = f.session.send("two"); f.begin("turn-2"); f.terminal("turn-2"); if (engine === "mcp") f.rpc(); await next;
      expect(result.events).toHaveLength(historicalLength);
    } finally { f.session.kill(); }
  });

  test(`${engine}: rejecting mutation observer preserves original error and immutable pre-terminal snapshot`, async () => {
    const f = setup(engine); await f.session.start();
    f.session.onEvent(async event => { mutateEvent(event); throw Error("observer failure"); });
    try {
      const original = Error("original transport observation failure"); f.failWrite(original);
      const error = await f.session.send("one").catch(e => e);
      const before = error.attempt;
      f.begin(); f.text(); f.terminal(); await tick();
      const after = error.attempt;
      after.events.forEach(mutateEvent);
      expect(error.cause).toBe(original); expect(error.message).toBe(original.message);
      expect(before.nativeOutcome).toBe("unknown"); expect(before.events).toHaveLength(0);
      expect(after.admissionId).toBe(before.admissionId); expect(after.nativeOutcome).toBe("completed");
      expect(error.attempt.content).toBe("completed output");
    } finally { f.session.kill(); }
  });

  test(`${engine}: event ownership detaches caller data without freezing the caller's object`, async () => {
    const f = setup(engine);
    const payload = { kind: "controlled", text: "payload", nested: { values: ["ORIGINAL"] } };
    await f.session.push(payload);
    payload.nested.values[0] = "CALLER_CHANGED";
    const event = f.session.events[0];
    expect((event.raw as typeof payload).nested.values).toEqual(["ORIGINAL"]);
    expect(Object.isFrozen(payload.nested)).toBe(false);
    expect(Object.isFrozen((event.raw as typeof payload).nested.values)).toBe(true);
  });
}
