import { expect, test } from "bun:test";
import { ContinuationCapture } from "../scripts/s0/continuation";
import { CONTINUATION_TASKS, PINNED_BUN_VERSION, continuationPlan } from "../scripts/s0/continuation-plan";

// Controlled MCP transport through the production CodexMcpSession and the recorder.
// Native terminal timing relative to RPC settlement is the variable under test.
// No CLI, credentials, model or workspace content is involved.
type Scenario = {
  terminalDelay: number | null;          // ms after RPC for task_complete; null = never
  foreignTerminal?: boolean;             // emit a terminal for another turn instead of ours
  duplicateFirstTerminal?: boolean;      // on task two, re-emit task one's terminal
  exitAfterRpc?: number;                 // ms after RPC to close the transport without a terminal
  rpcDelay?: number;                     // ms after tool events before the RPC result
  eventFaultOnSecond?: boolean;          // observer throws while task two evidence lands
  deadline?: number;
  settle?: number;
};

function fixture(s: Scenario) {
  let output!: ReadableStreamDefaultController<Uint8Array>;
  let finish!: (code: number) => void;
  let closed = false, sends = 0, kills = 0;
  const timers: Array<ReturnType<typeof setTimeout>> = [];
  const later = (ms: number, fn: () => void) => { timers.push(setTimeout(fn, ms)); };
  const emit = (value: unknown) => { if (!closed) output.enqueue(new TextEncoder().encode(JSON.stringify(value) + "\n")); };
  const event = (msg: Record<string, unknown>) => emit({ jsonrpc: "2.0", method: "codex/event", params: { id: msg.turn_id, msg } });
  const exit = () => { if (closed) return; closed = true; for (const t of timers) clearTimeout(t); output.close(); finish(0); };
  const lateTerminal = (index: number) => event({ type: "task_complete", turn_id: `controlled-turn-${index}` });
  const proc = {
    stdin: { write(data: string) {
      const request = JSON.parse(data);
      if (["initialize", "tools/list"].includes(request.method)) { queueMicrotask(() => emit({ jsonrpc: "2.0", id: request.id, result: {} })); return; }
      if (request.method !== "tools/call") return;
      const index = sends++;
      const task = CONTINUATION_TASKS[index];
      const turn_id = `controlled-turn-${index}`;
      queueMicrotask(() => {
        event({ type: "session_configured", thread_id: "controlled-binding", model: "gpt-6-astra" });
        event({ type: "task_started", turn_id });
        event({ type: "exec_command_begin", turn_id, call_id: `controlled-call-${index}`, command: ["/bin/zsh", "-lc", `bun --version && cat ${task.file}`] });
        event({ type: "exec_command_end", turn_id, call_id: `controlled-call-${index}`, exit_code: 0, stdout: `${PINNED_BUN_VERSION}\n${task.content}` });
        const rpc = () => emit({ jsonrpc: "2.0", id: request.id, result: { structuredContent: { threadId: "controlled-binding", content: task.marker } } });
        if (s.rpcDelay) later(s.rpcDelay, rpc); else rpc();
        if (s.exitAfterRpc !== undefined) later(s.exitAfterRpc, exit);
        if (s.terminalDelay !== null) later(s.terminalDelay, () => {
          if (s.duplicateFirstTerminal && index === 1) return lateTerminal(0);
          event({ type: "task_complete", turn_id: s.foreignTerminal ? "controlled-foreign-turn" : turn_id });
        });
      });
    }, flush() {}, end() {} },
    stdout: new ReadableStream<Uint8Array>({ start(c) { output = c; } }),
    stderr: new ReadableStream<Uint8Array>({ start(c) { c.close(); } }),
    exited: new Promise<number>(resolve => { finish = resolve; }),
    kill() { kills++; exit(); },
  };
  const capture = new ContinuationCapture("codex-mcp", {
    cwd: "controlled-sample", spawn: () => proc, startDeadlineMs: 100, sendDeadlineMs: s.deadline ?? 300, settleMs: s.settle ?? 20,
    observationFault: boundary => { if (s.eventFaultOnSecond && boundary === "event" && sends === 2) throw Error("CONTROLLED_OBSERVER_FAULT"); },
  });
  return { capture, exit, lateTerminal, get sends() { return sends; }, get kills() { return kills; } };
}

test("terminal after RPC inside the admission deadline: exactly two verified admissions, each waited for its own outcome", async () => {
  const f = fixture({ terminalDelay: 60 });
  try {
    const report = await f.capture.run();
    expect(report.stop).toBe("complete");
    expect(report.admittedSends).toBe(2);
    expect(report.turns.map(turn => turn.nativeWait)).toEqual(["known", "known"]);
    expect(report.turns.every(turn => turn.verified)).toBe(true);
  } finally { f.exit(); await f.capture.closeOwned(); }
});

test("RPC-only: waits out one monotonic deadline, stops as native-deadline with unknown outcome, no second send, no kill", async () => {
  const f = fixture({ terminalDelay: null, deadline: 120, rpcDelay: 40 });
  const started = performance.now();
  try {
    const report = await f.capture.run();
    const elapsed = performance.now() - started;
    // One deadline from admission, not RPC delay plus a fresh deadline.
    expect(elapsed).toBeGreaterThanOrEqual(100);
    expect(elapsed).toBeLessThan(230);
    expect(report.stop).toBe("native-deadline");
    expect(report.nativeOutcome).toBe("unknown");
    expect(report.turns[0].nativeWait).toBe("deadline");
    expect(f.sends).toBe(1);
    expect(f.capture.cleanupAllowed()).toBe(false);
    expect(await f.capture.closeOwned()).toBe(false);
    expect(f.kills).toBe(0);
  } finally { f.exit(); await f.capture.closeOwned(); }
});

test("a late matching terminal after the deadline reconciles the original admission and permits cleanup only; run() is not resumed and nothing is re-sent", async () => {
  const f = fixture({ terminalDelay: null, deadline: 80 });
  try {
    const report = await f.capture.run();
    expect(report.stop).toBe("native-deadline");
    expect(f.capture.cleanupAllowed()).toBe(false);
    f.lateTerminal(0);
    await f.capture.waitForCleanup();
    const after = f.capture.snapshot();
    expect(after.stop).toBe("native-deadline");
    expect(after.nativeOutcome).toBe("completed");
    expect(after.admittedSends).toBe(1);
    expect(f.sends).toBe(1);
    expect(after.turns[0].result).toBeDefined();
    await expect(f.capture.run()).rejects.toThrow(/only once/);
    expect(await f.capture.closeOwned()).toBe(true);
    expect(f.kills).toBe(1);
  } finally { f.exit(); await f.capture.closeOwned(); }
});

test("a matching terminal landing between deadline observation and verification cannot reopen admission; the stop reason stays native-deadline after the outcome becomes known", async () => {
  const f = fixture({ terminalDelay: null, deadline: 40 });
  const boundary = f.capture as unknown as { awaitOwnedOutcome(turn: unknown): Promise<string> };
  const wait = boundary.awaitOwnedOutcome.bind(f.capture);
  boundary.awaitOwnedOutcome = async turn => { const outcome = await wait(turn); if (outcome === "deadline") f.lateTerminal(0); return outcome; };
  try {
    const report = await f.capture.run();
    expect(f.sends).toBe(1);
    expect(report.stop).toBe("native-deadline");
    expect(report.admissionClosed).toMatchObject({ reason: "deadline" });
    expect(report.turns[0].nativeWait).toBe("deadline");
    await f.capture.waitForCleanup();
    const after = f.capture.snapshot();
    expect(after.stop).toBe("native-deadline");
    expect(after.nativeOutcome).toBe("completed");
    expect(after.lifecycle.some(e => e.kind === "admission-closed")).toBe(true);
    expect(await f.capture.closeOwned()).toBe(true);
  } finally { f.exit(); await f.capture.closeOwned(); }
});

test("a foreign terminal inside the deadline never satisfies the owned admission", async () => {
  const f = fixture({ terminalDelay: 20, foreignTerminal: true, deadline: 100 });
  try {
    const report = await f.capture.run();
    expect(report.stop).toBe("native-deadline");
    expect(report.nativeOutcome).toBe("unknown");
    expect(f.sends).toBe(1);
  } finally { f.exit(); await f.capture.closeOwned(); }
});

test("a duplicate first terminal during task two cannot complete admission two", async () => {
  const f = fixture({ terminalDelay: 20, duplicateFirstTerminal: true, deadline: 100 });
  try {
    const report = await f.capture.run();
    expect(report.stop).toBe("native-deadline");
    expect(report.admittedSends).toBe(2);
    expect(report.turns[0].verified).toBe(true);
    expect(report.turns[1].verified).toBe(false);
    expect(f.sends).toBe(2);
  } finally { f.exit(); await f.capture.closeOwned(); }
});

test("transport exit before the terminal ends the wait as process-exited, blocks task two and allows cleanup without a kill", async () => {
  const f = fixture({ terminalDelay: null, exitAfterRpc: 20, deadline: 300 });
  const started = performance.now();
  try {
    const report = await f.capture.run();
    expect(performance.now() - started).toBeLessThan(250);
    expect(report.turns[0].nativeWait).toBe("process-exited");
    expect(report.stop).toBe("evidence-incomplete");
    expect(report.nativeOutcome).toBe("unknown");
    expect(f.sends).toBe(1);
    expect(f.capture.cleanupAllowed()).toBe(true);
    expect(await f.capture.closeOwned()).toBe(true);
  } finally { f.exit(); await f.capture.closeOwned(); }
});

test("an observer failure while task two evidence lands is evidence-incomplete, not completion", async () => {
  const f = fixture({ terminalDelay: 10, eventFaultOnSecond: true, deadline: 150 });
  try {
    const report = await f.capture.run();
    expect(report.stop).toBe("evidence-incomplete");
    expect(report.observerErrors.length).toBeGreaterThan(0);
    expect(report.turns[1]?.verified).toBe(false);
  } finally { f.exit(); await f.capture.closeOwned(); }
});

test("the plan states the pinned runtime contract and the single-deadline semantics without launching anything", () => {
  const plan = continuationPlan("codex-mcp", "s1-continuation-20260907T050000Z");
  expect(plan.preflight).toEqual({ pinnedBunVersion: PINNED_BUN_VERSION, pinned: true, portability: expect.stringContaining(PINNED_BUN_VERSION) });
  expect(plan.limits.admissionDeadline).toContain("one monotonic deadline");
  expect(plan.limits.afterDeadline).toContain("Never resume");
});
