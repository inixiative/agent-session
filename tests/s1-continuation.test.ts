import { test, expect } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { ContinuationCapture } from "../scripts/s0/continuation";
import { continuationPlan, CONTINUATION_TASKS, type ActivePath } from "../scripts/s0/continuation-plan";
import { reserveOutput, sampleManifest } from "../scripts/s0/continuation-record";
import { Sanitizer } from "../scripts/s0/sanitize";
const runId = "s1-continuation-20260907T040000Z";

// Synthetic controlled transports through BOTH production classes, never native processes.
function fixture(path: ActivePath, scenario = "success", fault?: "stdin" | "stdout" | "event" | "handshake", checkpoint?: () => void) {
  let controller!: ReadableStreamDefaultController<Uint8Array>, finish!: (code: number) => void;
  let closed = false, sends = 0, spawned = 0, kills = 0, stdinObservations = 0;
  const writes: any[] = [], argv: string[][] = [];
  const bytes = (text: string) => { const data = new TextEncoder().encode(text); for (let i = 0; i < data.length; i += 7) controller.enqueue(data.slice(i, i + 7)); };
  const emit = (value: unknown) => bytes(JSON.stringify(value) + "\n");
  const exit = (code = 1) => { if (!closed) { closed = true; controller.close(); finish(code); } };
  const native = (msg: Record<string, unknown>) => emit({ jsonrpc: "2.0", method: "codex/event", params: { id: msg.turn_id, msg } });
  const nativeSession = "PRIVATE_NATIVE_SESSION";
  const terminal = (index: number, wrong = false, failed = false) => path === "claude"
    ? emit({ type: "result", subtype: failed ? "error_during_execution" : "success", is_error: failed,
      session_id: wrong ? "FOREIGN_SESSION" : nativeSession, uuid: `PRIVATE_RESULT_${index}`,
      result: CONTINUATION_TASKS[index].marker, ...(scenario === "missing-identity" ? { uuid: undefined } : {}),
      ...(scenario === "api-error" ? { is_error: false, api_error_status: 429, terminal_reason: "api_error" } : {}) })
    : native({ type: "task_complete", turn_id: wrong ? "FOREIGN_TURN" : `PRIVATE_TURN_${index}` });
  const rpc = (index: number) => emit({ jsonrpc: "2.0", id: writes.filter(v => v.method === "tools/call")[index]?.id,
    result: { structuredContent: { threadId: nativeSession, content: CONTINUATION_TASKS[index].marker } } });
  const tool = (index: number) => {
    const task = CONTINUATION_TASKS[index];
    const command = `bun --version && cat ${task.file}` + (scenario === "extra-command" ? " && PRIVATE_UNRELATED_COMMAND" : "");
    const content = `1.3.14\n${task.content}`;
    if (path === "claude") {
      emit({ type: "assistant", session_id: nativeSession, message: { id: `PRIVATE_MESSAGE_${index}`, content: [
        { type: "thinking", thinking: "PRIVATE_REASONING_SENTINEL" },
        { type: "tool_use", name: "Bash", id: `PRIVATE_CALL_${index}`, input: { command, env: { private: "SECRET" } } },
      ] } });
      emit({ type: "user", session_id: nativeSession, message: { content: [{ type: "tool_result", tool_use_id: `PRIVATE_CALL_${index}`,
        is_error: false, ...(scenario === "wrong-call" ? { tool_use_id: "PRIVATE_WRONG_CALL" } : {}), content: scenario === "missing-output" ? "PRIVATE_OUTPUT" : content }] } });
    } else {
      native({ type: "session_configured", thread_id: nativeSession, session_id: nativeSession, model: "gpt-6-astra", reasoning_effort: "xhigh" });
      native({ type: "task_started", turn_id: `PRIVATE_TURN_${index}` });
      native({ type: "agent_reasoning", turn_id: `PRIVATE_TURN_${index}`, text: "PRIVATE_REASONING_SENTINEL" });
      native({ type: "exec_command_begin", turn_id: `PRIVATE_TURN_${index}`, call_id: `PRIVATE_CALL_${index}`, command: ["/bin/zsh", "-lc", command] });
      native({ type: "exec_command_end", turn_id: `PRIVATE_TURN_${index}`, call_id: scenario === "wrong-call" ? "PRIVATE_WRONG_CALL" : `PRIVATE_CALL_${index}`, exit_code: 0,
        stdout: scenario === "missing-output" ? "PRIVATE_OUTPUT" : content });
    }
  };
  const complete = (index: number) => { tool(index); terminal(index); if (path === "codex-mcp") rpc(index); };
  const proc = { stdin: { write(data: string) {
    const value = JSON.parse(data); writes.push(value);
    if (["initialize", "tools/list"].includes(value.method)) {
      if (scenario !== "handshake-timeout") queueMicrotask(() => emit({ jsonrpc: "2.0", id: value.id, result: {} }));
      return;
    }
    if (value.method === "notifications/initialized") return;
    const index = sends++;
    queueMicrotask(() => {
      if (scenario === "malformed") { bytes("PRIVATE malformed JSON\n"); return; }
      if (scenario === "partial") { bytes('{"type":"result","result":"PRIVATE'); return; }
      if (scenario === "timeout") return;
      if (scenario === "malformed-then-success") bytes("PRIVATE malformed JSON\n");
      if (scenario === "rpc-only" || (scenario === "missing-identity" && path === "codex-mcp")) { tool(index); rpc(index); return; }
      if (scenario === "foreign") { tool(index); terminal(index, true); return; }
      if (scenario === "error") {
        tool(index);
        if (path === "claude") terminal(index, false, true); else { emit({ jsonrpc: "2.0", id: value.id, error: { message: "PRIVATE_RPC_ERROR" } }); }
        return;
      }
      if (scenario === "duplicate" && index === 1) { tool(index); terminal(0); if (path === "codex-mcp") rpc(index); return; }
      complete(index);
      if (scenario === "success-eof") exit();
    });
    if (scenario === "write-failure") throw Error("PRIVATE_WRITE_ERROR_AFTER_FORWARD");
  }, flush() {}, end() {} }, stdout: new ReadableStream<Uint8Array>({ start(c) { controller = c; } }),
    stderr: new ReadableStream<Uint8Array>({ start(c) { c.close(); } }), exited: new Promise<number>(resolve => { finish = resolve; }),
    kill() { kills++; if (scenario !== "kill-no-exit") exit(143); } };
  const capture = new ContinuationCapture(path, { cwd: "<controlled-fake-directory>", startDeadlineMs: 20, sendDeadlineMs: 30, settleMs: 5,
    spawn: cmd => { spawned++; argv.push(cmd); if (path === "claude") queueMicrotask(() => emit({ type: "system", subtype: "init", session_id: nativeSession, model: "claude-fable-5-1" })); return proc; },
    observationFault: boundary => {
      if (boundary === "stdin") stdinObservations++;
      if (fault === "handshake" && boundary === "stdin" && stdinObservations === 1) throw Error("PRIVATE_HANDSHAKE_OBSERVER");
      if (boundary === fault && (boundary === "stdin" ? stdinObservations === (path === "claude" ? 1 : 4) : sends > 0)) throw Error("PRIVATE_OBSERVER_ERROR");
    }, checkpoint,
  });
  return { capture, writes, argv, complete, emit, exit, get sends() { return sends; }, get spawned() { return spawned; }, get kills() { return kills; } };
}
for (const path of ["claude", "codex-mcp"] as const) {
  test(`${path}: two independent tasks use one instance/process, actual joined evidence and stable pseudonyms`, async () => {
    const f = fixture(path);
    try {
      const report = await f.capture.run();
      expect(report.stop).toBe("complete"); expect(f.sends).toBe(2); expect(f.spawned).toBe(1);
      expect(f.capture.session.attempts).toHaveLength(2);
      expect(f.argv[0]).toEqual(continuationPlan(path, runId).expectedSpawn);
      const turns = report.turns.map(t => t.attempt as any);
      expect(turns[0].admissionId).not.toBe(turns[1].admissionId);
      expect(turns[0][path === "claude" ? "nativeSessionId" : "threadId"]).toBe(turns[1][path === "claude" ? "nativeSessionId" : "threadId"]);
      for (const turn of report.turns) {
        const events = turn.eventIndices.map(index => report.normalized[index] as any);
        const begin = events.find((e: any) => e.kind === "tool_use");
        const end = events.find((e: any) => e.kind === "tool_result");
        expect(begin.callId).toBe(end.callId); expect(begin.callId).toMatch(/^ref-/);
      }
      expect(turns.every(t => t.nativeOutcome === "completed")).toBe(true);
      expect(f.argv[0]).not.toContain("--resume"); expect(f.argv[0]).not.toContain("--fork-session");
      if (path === "codex-mcp") expect(f.writes.filter(v => v.method === "tools/call").map(v => v.params.name)).toEqual(["codex", "codex-reply"]);
      expect(JSON.stringify(report)).not.toMatch(/PRIVATE|FOREIGN|SECRET|api_key|Bearer|\/Users\//);
      const immutableFirst = JSON.stringify(report.turns[0]);
      expect(await f.capture.closeOwned()).toBe(true);
      expect(f.capture.snapshot().processExited).toBe(true);
      expect(JSON.stringify(report.turns[0])).toBe(immutableFirst);
      await expect(f.capture.run()).rejects.toThrow(/only once/);
    } finally { f.exit(); await f.capture.closeOwned(); }
  });
  for (const scenario of ["malformed", "malformed-then-success", "partial", "timeout", "foreign", "error", "missing-output", "wrong-call", "missing-identity", "extra-command", "success-eof", "write-failure"])
    test(`${path}: ${scenario} never admits a second task or retries`, async () => {
      const f = fixture(path, scenario);
      try {
        const report = await f.capture.run();
        expect(report.stop).not.toBe("complete"); expect(report.admittedSends).toBe(1); expect(f.sends).toBe(1); expect(f.spawned).toBe(1);
        expect(JSON.stringify(report)).not.toMatch(/PRIVATE|FOREIGN|SECRET/);
        if (["malformed", "partial", "timeout", "foreign"].includes(scenario)) {
          expect(report.nativeOutcome).toBe("unknown"); expect(await f.capture.closeOwned()).toBe(false); expect(f.kills).toBe(0);
        }
        if (scenario === "success-eof") { expect(report.nativeOutcome).toBe("completed"); expect((report.turns[0].result as any).content).toContain("S1_FIRST_DONE"); }
      } finally { f.exit(); await f.capture.closeOwned(); }
    });
  for (const fault of ["stdin", "stdout", "event"] as const) test(`${path}: ${fault} observer failure cannot authorize task two or leak the exception`, async () => {
    const f = fixture(path, "success", fault);
    try {
      const report = await f.capture.run();
      expect(report.stop).not.toBe("complete"); expect(f.sends).toBe(1); expect(report.observerErrors.length).toBeGreaterThan(0);
      expect(JSON.stringify(report)).not.toMatch(/PRIVATE|SECRET/);
    } finally { f.exit(); await f.capture.closeOwned(); }
  });
  test(`${path}: successful first execution followed by checkpoint failure preserves result and refuses task two`, async () => {
    const f = fixture(path, "success", undefined, () => { throw Error("PRIVATE_QUOTA_ERROR"); });
    try {
      const report = await f.capture.run();
      expect(report.stop).toBe("checkpoint-failed"); expect(f.sends).toBe(1);
      expect((report.turns[0].result as any).nativeOutcome).toBe("completed");
      expect((report.turns[0].result as any).content).toContain("S1_FIRST_DONE");
      expect(JSON.stringify(report)).not.toContain("PRIVATE");
    } finally { f.exit(); await f.capture.closeOwned(); }
  });
  for (const failOn of [1, 2]) test(`${path}: rejecting pre-send hook ${failOn} never adopts startup or a previous admission's evidence`, async () => {
    const f = fixture(path); let calls = 0;
    f.capture.session.onBeforeSend(message => { if (++calls === failOn) throw Error("PRIVATE_HOOK_FAILURE"); return message; });
    try {
      const report = await f.capture.run();
      expect(report.stop).toBe("send-rejected"); expect(report.sendCalls).toBe(failOn);
      expect(report.admittedSends).toBe(failOn - 1); expect(f.sends).toBe(failOn - 1);
      expect(report.turns.at(-1)?.eventIndices).toEqual([]);
      expect(report.nativeOutcome).toBe("unknown");
      expect(await f.capture.closeOwned()).toBe(false); // A previous terminal cannot cover the current uncorrelated send call.
      if (failOn === 2) expect((report.turns[0].result as any).nativeOutcome).toBe("completed");
    } finally { f.exit(); await f.capture.closeOwned(); }
  });
  test(`${path}: EOF during the pre-second checkpoint cannot slip a second admission past verification`, async () => {
    let checkpoints = 0;
    const f = fixture(path, "success", undefined, () => { if (++checkpoints === 2) f.exit(); });
    try {
      const report = await f.capture.run();
      expect(f.sends).toBe(1); expect(report.stop).toBe("evidence-incomplete");
      expect((report.turns[0].result as any).nativeOutcome).toBe("completed");
    } finally { f.exit(); await f.capture.closeOwned(); }
  });
  test(`${path}: timeout then late terminal reconciles only the original admission and permits owned cleanup`, async () => {
    const f = fixture(path, "timeout");
    try {
      const historical = await f.capture.run(); expect(historical.nativeOutcome).toBe("unknown");
      const waiting = f.capture.waitForCleanup(); f.complete(0); await waiting;
      expect(f.capture.snapshot().nativeOutcome).toBe("completed"); expect(historical.nativeOutcome).toBe("unknown");
      expect(f.sends).toBe(1); expect(await f.capture.closeOwned()).toBe(true);
    } finally { f.exit(); await f.capture.closeOwned(); }
  });
  test(`${path}: a repeated first terminal cannot complete admission two`, async () => {
    const f = fixture(path, "duplicate");
    try {
      const report = await f.capture.run();
      expect(f.sends).toBe(2); expect(report.stop).not.toBe("complete");
      expect((report.turns[0].attempt as any).nativeOutcome).toBe("completed");
      expect((report.turns[1].attempt as any).nativeOutcome).toBe("unknown");
    } finally { f.exit(); await f.capture.closeOwned(); }
  });
  test(`${path}: owned kill request does not manufacture process exit or cancellation acknowledgment`, async () => {
    const f = fixture(path, "kill-no-exit");
    try {
      expect((await f.capture.run()).stop).toBe("complete");
      let closed = false;
      const closing = f.capture.closeOwned().then(value => { closed = true; return value; });
      await Bun.sleep(5);
      expect(closed).toBe(false); expect(f.capture.snapshot().processExited).toBe(false); expect(f.kills).toBe(1);
      f.exit(0); expect(await closing).toBe(true); expect(f.capture.snapshot().nativeOutcome).toBe("completed");
    } finally { f.exit(); await f.capture.closeOwned(); }
  });
}

test("MCP handshake deadline admits no send; cleanup is based on explicit no-turn writes", async () => {
  const f = fixture("codex-mcp", "handshake-timeout");
  try { const report = await f.capture.run(); expect(report.stop).toBe("start-deadline"); expect(f.sends).toBe(0); expect(await f.capture.closeOwned()).toBe(true); }
  finally { f.exit(); }
});

test("synthetic Claude API-error terminal keeps precedence evidence in the sanitized wire and result", async () => {
  const f = fixture("claude", "api-error");
  try {
    const report = await f.capture.run(); expect(f.sends).toBe(1); expect(report.nativeOutcome).toBe("failed");
    expect((report.turns[0].result as any).terminal.apiErrorStatus).toBe(429);
    expect((report.turns[0].result as any).terminal.reason).toBe("api_error");
    const terminal = report.stdout.frames.find(f => (f.value as any)?.type === "result")!.value as any;
    expect(terminal.api_error_status).toBe(429); expect(terminal.is_error).toBe(false); expect(terminal.subtype).toBe("success");
    const s = new Sanitizer("continuation");
    expect(JSON.stringify(s.clean({ type: "assistant", content: [987654321], api_error_status: 987654321 }))).not.toContain("987654321");
  } finally { f.exit(); await f.capture.closeOwned(); }
});

test("MCP handshake observer failure is not no-turn proof and cannot admit a model call", async () => {
  const f = fixture("codex-mcp", "success", "handshake");
  try {
    const report = await f.capture.run(); expect(f.sends).toBe(0); expect(report.stop).toBe("evidence-incomplete");
    expect(report.admission.noTurn).toBe(false); expect(await f.capture.closeOwned()).toBe(false);
  } finally { f.exit(); await f.capture.closeOwned(); }
});

test("plan mode launches no model or version process and creates no files", () => {
  const dir = mkdtempSync(join(tmpdir(), "continuation-plan-"));
  try {
    const script = resolve(import.meta.dir, "../scripts/s0/continuation-record.ts");
    const p = Bun.spawnSync(["bun", script, "--plan", "claude", runId], { cwd: dir, stdout: "pipe", stderr: "pipe" });
    expect(p.exitCode).toBe(0); expect(JSON.parse(new TextDecoder().decode(p.stdout)).mode).toBe("plan-only");
    expect(readdirSync(dir)).toEqual([]);
    expect(() => continuationPlan("codex-app-server", runId)).toThrow(); expect(() => continuationPlan("claude", "../old")).toThrow();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("exclusive output reservation and writes preserve existing evidence on collisions", () => {
  const root = mkdtempSync(join(tmpdir(), "continuation-output-"));
  try {
    const output = reserveOutput(root, "claude", runId);
    output.write({ controlled: "first" }, true); const file = join(output.dir, "recording.json");
    const original = readFileSync(file, "utf8");
    expect(() => reserveOutput(root, "claude", runId)).toThrow();
    expect(() => output.write({ controlled: "replacement" }, true)).toThrow();
    expect(readFileSync(file, "utf8")).toBe(original);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("controlled artifact inspection rejects symlink replacement without reading its target", () => {
  const dir = mkdtempSync(join(tmpdir(), "continuation-sentinel-"));
  try {
    for (const task of CONTINUATION_TASKS) writeFileSync(join(dir, task.file), task.content);
    expect(sampleManifest(dir).unchanged).toBe(true);
    rmSync(join(dir, CONTINUATION_TASKS[0].file)); symlinkSync("/nonexistent-private-target", join(dir, CONTINUATION_TASKS[0].file));
    expect(sampleManifest(dir).files[0].hash).toBeNull(); expect(sampleManifest(dir).unchanged).toBe(false);
    expect(JSON.stringify(sampleManifest(dir))).not.toContain("private-target");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("continuation profile preserves only controlled literals; the single-turn text policy is unchanged", () => {
  expect(Object.isFrozen(CONTINUATION_TASKS)).toBe(true);
  const s = new Sanitizer("continuation");
  for (const task of CONTINUATION_TASKS) {
    expect(s.text(task.prompt)).toBe(task.prompt);
    expect(new Sanitizer().text(task.content)).toBe("[redacted]");
    const value = s.clean({ kind: "text", text: `PRIVATE ${task.content}`, raw: { phase: "analysis", content: task.content },
      toolInput: { env: { token: "PRIVATE" }, content: [987654321], text: "PRIVATE" } });
    expect(JSON.stringify(value)).toContain(task.content.trim());
    expect(JSON.stringify(value)).not.toMatch(/PRIVATE|987654321/);
  }
});
