import { afterEach, expect, test } from "bun:test";
import { CodexAppServerSession, type SessionEvent } from "../src";

// Synthetic installed-0.153.4 schema cases, never a recorded native success.
const closes: Array<() => void> = [];
afterEach(() => { for (const close of closes.splice(0)) close(); });
const tick = () => Bun.sleep(0);
type Request = { id?: number; method: string; params?: any };
function fixture(opts: { binding?: string; threadError?: string; returnedThread?: string; holdThread?: boolean; writeError?: Error; threadStatus?: string; threadState?: unknown; nativeSessionId?: string } = {}) {
  let out!: ReadableStreamDefaultController<Uint8Array>, exit!: (code: number) => void, closed = false;
  const requests: Request[] = [], commands: string[][] = [];
  const threadId = opts.returnedThread ?? opts.binding ?? "thread-owned";
  const emit = (value: unknown) => { if (!closed) out.enqueue(new TextEncoder().encode(JSON.stringify(value) + "\n")); };
  const replyThread = () => {
    const req = requests.find(r => ["thread/start", "thread/resume"].includes(r.method))!;
    emit({ id: req.id, ...(opts.threadError ? { error: { code: -1, message: opts.threadError } } : {
      result: { thread: { id: threadId, turns: [], status: Object.hasOwn(opts, "threadState") ? opts.threadState : { type: opts.threadStatus ?? "idle" },
        ...(opts.nativeSessionId ? { sessionId: opts.nativeSessionId } : {}) }, model: "observed-model", reasoningEffort: "high" },
    }) });
  };
  const proc = { stdout: new ReadableStream<Uint8Array>({ start(c) { out = c; } }),
    stderr: new ReadableStream<Uint8Array>({ start(c) { c.close(); } }),
    exited: new Promise<number>(r => { exit = r; }),
    kill() { if (!closed) { closed = true; out.close(); exit(143); } },
    stdin: { write(line: string) {
      const r: Request = JSON.parse(line); requests.push(r);
      if (r.method === "initialize") queueMicrotask(() => emit({ id: r.id, result: {} }));
      if (["thread/start", "thread/resume"].includes(r.method) && !opts.holdThread) queueMicrotask(replyThread);
      if (r.method === "turn/start" && opts.writeError) throw opts.writeError;
    }, flush() {}, end() {} },
  };
  const session = new CodexAppServerSession({ externalSessionId: opts.binding, cwd: "/controlled", model: "requested-model", effort: "xhigh", timeout: 250,
    spawn: cmd => { commands.push([...cmd]); return proc; } });
  // A failed assertion still tears down owned work without an unhandled waiter.
  const send = session.send.bind(session);
  session.send = (...args) => { const pending = send(...args); void pending.catch(() => {}); return pending; };
  closes.push(() => session.kill());
  const calls = () => requests.filter(r => r.method === "turn/start");
  const turn = (id: string, status = "inProgress", error: unknown = null) => ({ id, status, items: [], error });
  const notify = (method: string, params: Record<string, unknown>) => emit({ method, params: { threadId, ...params } });
  return { session, requests, commands, calls, emit, notify, replyThread, threadId,
    emitBatch(values: unknown[]) { out.enqueue(new TextEncoder().encode(values.map(value => JSON.stringify(value) + "\n").join(""))); },
    rpc(id = "turn-one", error?: string) { emit({ id: calls().at(-1)!.id, ...(error ? { error: { code: -1, message: error } } : { result: { turn: turn(id) } }) }); },
    begin(id = "turn-one") { notify("turn/started", { turn: turn(id) }); },
    terminal(id = "turn-one", status = "completed", error: unknown = null) { notify("turn/completed", { turn: turn(id, status, error) }); },
    text(text = "public output", turnId = "turn-one") { notify("item/completed", { turnId, completedAtMs: 1, item: { id: "message-one", type: "agentMessage", text } }); },
    eof() { if (!closed) { closed = true; out.close(); exit(1); } },
  };
}

test("app-server uses stdio, prewrite registration, typed input, supported effort and own configuration", async () => {
  const f = fixture({ binding: "retained-thread" }); await f.session.start();
  let registered = "", allow!: () => void;
  const wait = new Promise<void>(resolve => { allow = resolve; });
  const pending = f.session.send("sentinel", { onAdmission: async a => { registered = a.admissionId!; expect(a.dispatch).toBe("not-dispatched"); await wait; } });
  await tick(); expect(f.calls()).toHaveLength(0); allow(); await tick();
  expect(f.commands[0]).toEqual(["codex", "app-server", "--listen", "stdio://"]);
  expect(f.requests.find(r => r.method === "thread/resume")?.params).toMatchObject({ threadId: "retained-thread", model: "requested-model", cwd: "/controlled" });
  expect(f.calls()[0].params).toEqual({ threadId: "retained-thread", input: [{ type: "text", text: "sentinel" }], effort: "xhigh" });
  f.rpc(); f.begin(); f.text(); f.terminal();
  const result = await pending;
  expect(result).toMatchObject({ admissionId: registered, threadId: "retained-thread", turnId: "turn-one", nativeOutcome: "completed", rpcOutcome: "resolved", content: "public output" });
  expect(result.tokens).toBeUndefined();
  expect(f.session.events.find(e => e.unattributedReason === "session-configuration")?.raw).toMatchObject({ model: "observed-model", reasoningEffort: "high" });
  expect(f.session.externalSessionId).toBe("retained-thread");
});

for (const mode of ["error", "foreign", "timeout"] as const) test(`app-server ${mode} during cold resume preserves binding and never sends a turn`, async () => {
  const f = fixture({ binding: "original", ...(mode === "error" ? { threadError: "RESUME_FAILURE" } : mode === "foreign" ? { returnedThread: "foreign" } : { holdThread: true }) });
  await f.session.start();
  const pending = f.session.send("one", { timeout: 10 }).catch(e => e);
  const error = await pending;
  if (mode === "timeout") { f.replyThread(); await tick(); }
  expect(error).toBeInstanceOf(Error); expect(f.calls()).toHaveLength(0);
  expect(f.requests.filter(r => r.method === "thread/start")).toHaveLength(0);
  expect(f.session.externalSessionId).toBe("original");
  if (mode === "error") expect(error.message).toContain("RESUME_FAILURE");
});

test("app-server registration rejection never initializes a thread or sends a turn", async () => {
  const f = fixture(); await f.session.start(); const original = Error("JOURNAL_DENIED");
  const error = await f.session.send("one", { onAdmission: () => { throw original; } }).catch(e => e);
  expect(error.cause).toBe(original); expect(error.attempt.dispatch).toBe("not-dispatched");
  expect(f.requests.some(r => ["thread/start", "turn/start"].includes(r.method))).toBe(false);
});

test("app-server resume of an explicitly active thread cannot steer pre-existing native work", async () => {
  const f = fixture({ binding: "original", threadStatus: "active" }); await f.session.start();
  const error = await f.session.send("do not steer", { timeout: 10 }).catch(e => e);
  expect(error.message).toContain("idle"); expect(f.calls()).toHaveLength(0); expect(f.session.externalSessionId).toBe("original");
});

for (const state of [undefined, null, {}, { type: "unknown" }, { type: "active", activeFlags: [] }, { type: "notLoaded" }, { type: "systemError" }]) {
  test(`app-server requires explicit idle before cold admission: ${JSON.stringify(state)}`, async () => {
    const f = fixture({ binding: "original", threadState: state }); await f.session.start();
    const error = await f.session.send("do not infer capacity", { timeout: 10 }).catch(e => e);
    expect(error.message).toContain("idle");
    expect(f.calls()).toHaveLength(0); expect(f.session.externalSessionId).toBe("original");
    expect(error.attempt.nativeOutcome).toBe("unknown"); expect(error.attempt.localOutcome).toBe("rejected");
    await expect(f.session.send("no automatic retry")).rejects.toThrow();
    expect(f.requests.filter(r => r.method === "thread/resume")).toHaveLength(1);
    expect(f.requests.filter(r => r.method === "thread/start")).toHaveLength(0);
  });
}

test("app-server preserves observed session-tree identity separately and omits unowned/private payloads", async () => {
  const f = fixture({ nativeSessionId: "native-tree", threadStatus: "idle" }); await f.session.start();
  const pending = f.session.send("one"); await tick(); f.rpc(); f.begin();
  f.notify("PRIVATE_UNKNOWN_METHOD", { turnId: "turn-one", credentials: "PRIVATE", reasoning: "PRIVATE" });
  f.notify("item/completed", { turnId: "turn-one", item: { id: "private", type: "PRIVATE_UNKNOWN_TYPE", text: "PRIVATE" } });
  f.notify("item/completed", { turnId: "turn-one", item: { id: "analysis", type: "agentMessage", phase: "analysis", text: "PRIVATE" } });
  f.text(); f.terminal(); const result = await pending;
  expect(result).toMatchObject({ nativeSessionId: "native-tree", threadId: "thread-owned" });
  expect(JSON.stringify(f.session.events)).not.toContain("PRIVATE");
});

for (const status of ["completed", "failed", "interrupted"] as const) test(`app-server ${status} terminal retains exact outcome, separate from RPC resolution`, async () => {
  const f = fixture(); await f.session.start(); const pending = f.session.send("one"); await tick();
  f.begin(); f.text(); f.terminal("turn-one", status, status === "failed" ? { message: "NATIVE_FAILURE" } : null); await tick();
  expect(f.session.attempts[0]).toMatchObject({ nativeOutcome: status === "completed" ? "completed" : "failed", localOutcome: "pending", rpcOutcome: "pending", terminal: { subtype: status } });
  f.rpc(); const result = await pending;
  expect(result.content).toBe("public output"); expect(result.terminal?.subtype).toBe(status);
});

test("app-server wrong/malformed/unmatched/duplicate terminals cannot release or relabel another admission", async () => {
  const f = fixture(); await f.session.start(); const first = f.session.send("one"); await tick();
  f.terminal(); f.notify("turn/started", { threadId: "foreign", turn: { id: "foreign", items: [], status: "inProgress" } }); await tick();
  expect(f.session.attempts[0].nativeOutcome).toBe("unknown");
  f.rpc(); f.begin(); f.terminal("foreign"); f.terminal("turn-one", "inProgress"); await tick();
  expect(f.session.attempts[0].nativeOutcome).toBe("unknown");
  f.terminal(); const historical = await first;
  const second = f.session.send("two"); await tick(); f.terminal(); f.rpc("turn-two"); f.begin("turn-two"); await tick();
  expect(f.session.attempts[1].nativeOutcome).toBe("unknown");
  f.terminal("turn-two"); expect((await second).nativeOutcome).toBe("completed");
  expect(f.requests.filter(r => r.method === "thread/start")).toHaveLength(1);
  expect(historical.turnId).toBe("turn-one");
  expect(f.session.events.some(e => e.unattributedReason === "foreign-turn")).toBe(true);
});

test("app-server permissive terminal without a valid start is unknown, not native success", async () => {
  const f = fixture(); await f.session.start(); const pending = f.session.send("one", { timeout: 10 }).catch(e => e); await tick();
  f.emit({ id: f.calls()[0].id, result: {} });
  f.notify("turn/started", { turn: { id: "turn-one", status: "inProgress" } });
  f.terminal(); const error = await pending;
  expect(error).toBeInstanceOf(Error); expect(error.attempt.nativeOutcome).toBe("unknown");
  await expect(f.session.send("two")).rejects.toThrow(); expect(f.calls()).toHaveLength(1);
});

test("app-server matching RPC turn identity applies before the next buffered terminal without turn/started", async () => {
  const f = fixture(); await f.session.start(); const pending = f.session.send("one", { timeout: 20 }).catch(e => e); await tick();
  f.emitBatch([
    { id: f.calls()[0].id, result: { turn: { id: "turn-one", items: [], status: "inProgress" } } },
    { method: "item/completed", params: { threadId: f.threadId, turnId: "turn-one", completedAtMs: 1, item: { id: "message-one", type: "agentMessage", text: "public output" } } },
    { method: "turn/completed", params: { threadId: f.threadId, turn: { id: "turn-one", items: [], status: "completed", error: null } } },
  ]);
  const result = await pending;
  expect(result).toMatchObject({ turnId: "turn-one", nativeOutcome: "completed", content: "public output", rpcOutcome: "resolved" });
});

test("app-server explicit terminal error overrides completed status without overwriting returned evidence", async () => {
  const f = fixture(); await f.session.start(); const pending = f.session.send("one"); await tick();
  f.rpc(); f.begin(); f.terminal("turn-one", "completed", { message: "EXPLICIT_NATIVE_ERROR" });
  const result = await pending;
  expect(result).toMatchObject({ nativeOutcome: "failed", terminal: { subtype: "completed", reason: "EXPLICIT_NATIVE_ERROR" } });
  const historical = result.events;
  f.session.onEvent(event => { try { (event as any).terminal.reason = "forged"; } catch {} });
  f.terminal(); await tick(); expect(result.events).toBe(historical); expect(result.terminal?.reason).toBe("EXPLICIT_NATIVE_ERROR");
});

test("app-server late terminal after timeout belongs to original admission; queued/new work never replays", async () => {
  const f = fixture(); await f.session.start(); const pending = f.session.send("one", { timeout: 10 }).catch(e => e); await tick(); f.begin();
  const queued = f.session.send("queued").catch(e => e); const error = await pending, historical = error.attempt;
  expect((await queued).attempt.dispatch).toBe("not-dispatched"); await expect(f.session.send("new")).rejects.toThrow();
  f.text(); f.terminal(); await tick();
  expect(error.attempt).toMatchObject({ nativeOutcome: "completed", localFailure: "timeout", rpcOutcome: "pending" });
  await expect(f.session.send("still occupied")).rejects.toThrow(); f.rpc(); await tick();
  expect(historical.nativeOutcome).toBe("unknown"); expect(f.calls()).toHaveLength(1);
  const next = f.session.send("explicit next"); await tick(); f.rpc("turn-two"); f.begin("turn-two"); f.terminal("turn-two"); await next;
  expect(f.commands).toHaveLength(1); expect(f.calls()).toHaveLength(2);
});

for (const failure of ["rpc", "write", "eof"] as const) test(`app-server native success and ${failure} failure retain independent evidence and original output`, async () => {
  const original = Error("WRITE_AFTER_FORWARD"); const f = fixture(failure === "write" ? { writeError: original } : {});
  await f.session.start(); f.session.onEvent(async () => { throw Error("OBSERVER_FAILURE"); });
  const pending = f.session.send("one").catch(e => e); await tick(); f.begin(); f.text(); f.terminal();
  if (failure === "rpc") f.rpc("turn-one", "RPC_AFTER_SUCCESS");
  if (failure === "eof") f.eof();
  const error = await pending; await tick();
  expect(error.attempt).toMatchObject({ nativeOutcome: "completed", content: "public output", localOutcome: "rejected" });
  if (failure === "write") {
    expect(error.cause).toBe(original); await expect(f.session.send("no ambiguous replacement")).rejects.toThrow();
  }
  if (failure === "rpc") expect(error.message).toBe("RPC_AFTER_SUCCESS");
  expect(f.session.diagnostics.observerFailures.asynchronous).toBeGreaterThan(0);
});

test("app-server unconfirmed EOF blocks automatic restart and preserves original binding", async () => {
  const f = fixture({ binding: "original" }); await f.session.start(); const pending = f.session.send("one").catch(e => e); await tick(); f.begin(); f.text(); await tick(); f.eof();
  const error = await pending;
  expect(error.attempt).toMatchObject({ nativeOutcome: "unknown", transportOutcome: "failed", content: "public output" });
  f.session.kill(); await expect(f.session.start()).rejects.toThrow();
  expect(f.commands).toHaveLength(1); expect(f.session.externalSessionId).toBe("original");
});

test("app-server owned shell items stream once with IDs; repeated usage snapshots do not double count", async () => {
  const f = fixture(); await f.session.start(); const pending = f.session.send("one"); await tick(); f.rpc(); f.begin();
  const item = { id: "item-shell", type: "commandExecution", command: "bun --version", cwd: "/controlled", commandActions: [], status: "inProgress" };
  f.notify("item/started", { turnId: "turn-one", item, startedAtMs: 1 });
  f.notify("item/completed", { turnId: "foreign", item: { ...item, status: "completed", aggregatedOutput: "FOREIGN" }, completedAtMs: 2 });
  const completed = { ...item, status: "completed", aggregatedOutput: "1.3.14", exitCode: 0 };
  f.notify("item/completed", { turnId: "turn-one", item: completed, completedAtMs: 2 });
  f.notify("item/completed", { turnId: "turn-one", item: completed, completedAtMs: 2 });
  for (let i = 0; i < 2; i++) f.notify("thread/tokenUsage/updated", { turnId: "turn-one", tokenUsage: { last: { inputTokens: 10, outputTokens: 2 }, total: { inputTokens: 100, outputTokens: 20 } } });
  f.text(); f.terminal(); const result = await pending;
  expect(result.events.filter(e => e.kind === "tool_use")).toHaveLength(1);
  expect(result.events.filter(e => e.kind === "tool_result")).toMatchObject([{ itemId: "item-shell", toolOutput: "1.3.14", toolError: false }]);
  expect(result.events.find(e => e.kind === "tool_use")?.callId).toBeUndefined(); // item ID is not an observed call ID
  expect(result.tokens).toEqual({ input: 10, output: 2 }); expect(f.session.totalTokens).toEqual({ input: 10, output: 2 });
});
