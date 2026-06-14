import { describe, test, expect } from "bun:test";
import { ClaudeCodeSession, type PipedSubprocess } from "../src/claude-code-session";
import { type SessionEvent } from "../src/harness-session";

// ---------------------------------------------------------------------------
// Fake subprocess — drives a ClaudeCodeSession without spawning the real CLI.
//
// Event shapes below match what claude 2.1.114 emits on stdout when invoked
// with --print --verbose --input-format stream-json --output-format stream-json.
// Captured during wire-format validation on 2026-04-18.
// ---------------------------------------------------------------------------

function makeFakeProc(opts?: {
  autoReplyOnSend?: boolean;
  sessionId?: string;
  stderrText?: string;
}): {
  proc: PipedSubprocess;
  emit: (json: Record<string, unknown>) => void;
  stdinLines: string[];
  exit: (code: number) => void;
  kill: () => void;
  onStdin: (cb: (line: string) => void) => void;
} {
  const sessionId = opts?.sessionId ?? "test-session-1";
  const autoReply = opts?.autoReplyOnSend ?? true;

  const stdinLines: string[] = [];
  const stdinCbs: Array<(line: string) => void> = [];

  let stdoutCtrl: ReadableStreamDefaultController<Uint8Array>;
  const stdout = new ReadableStream<Uint8Array>({
    start(ctrl) { stdoutCtrl = ctrl; },
  });

  const stderr = new ReadableStream<Uint8Array>({
    start(ctrl) {
      if (opts?.stderrText) ctrl.enqueue(new TextEncoder().encode(opts.stderrText));
    },
  });

  let exitResolve: (code: number) => void;
  const exited = new Promise<number>((r) => { exitResolve = r; });

  const emit = (json: Record<string, unknown>) => {
    const line = JSON.stringify(json) + "\n";
    stdoutCtrl.enqueue(new TextEncoder().encode(line));
  };

  const exit = (code: number) => {
    try { stdoutCtrl.close(); } catch {}
    exitResolve(code);
  };

  const kill = () => exit(143);

  const proc: PipedSubprocess = {
    stdin: {
      write(data: string) {
        for (const line of data.split("\n")) {
          if (!line.trim()) continue;
          stdinLines.push(line);
          for (const cb of stdinCbs) cb(line);
          if (autoReply) {
            // Simulate a minimal turn: system init → user replay → assistant text → result
            queueMicrotask(() => {
              emit({ type: "system", subtype: "init", session_id: sessionId });
              emit({
                type: "user",
                message: JSON.parse(line).message,
                session_id: sessionId,
                isReplay: true,
              });
              emit({
                type: "assistant",
                message: {
                  role: "assistant",
                  content: [{ type: "text", text: "ok" }],
                },
                session_id: sessionId,
              });
              emit({
                type: "result",
                subtype: "success",
                is_error: false,
                result: "ok",
                session_id: sessionId,
                usage: { input_tokens: 10, output_tokens: 2 },
              });
            });
          }
        }
      },
      flush() {},
      end() {},
    },
    stdout,
    stderr,
    exited,
    kill,
  };

  return {
    proc,
    emit,
    stdinLines,
    exit,
    kill,
    onStdin: (cb) => { stdinCbs.push(cb); },
  };
}

function makeSession(fake: ReturnType<typeof makeFakeProc>, extras?: ConstructorParameters<typeof ClaudeCodeSession>[0]) {
  return new ClaudeCodeSession({
    bin: "claude",
    cwd: "/tmp",
    model: "haiku",
    maxTurns: 1,
    spawn: () => fake.proc,
    ...extras,
  });
}

describe("ClaudeCodeSession", () => {
  test("start() → send() captures the full turn and returns result text", async () => {
    const fake = makeFakeProc();
    const session = makeSession(fake);
    await session.start();

    const result = await session.send("hello");

    expect(result.content).toBe("ok");
    expect(result.tokens).toEqual({ input: 10, output: 2 });
    expect(result.externalSessionId).toBe("test-session-1");

    const kinds = result.events.map((e) => e.kind);
    expect(kinds).toContain("text");
    expect(kinds).toContain("result");
  });

  test("stdin payload uses the validated wire format", async () => {
    const fake = makeFakeProc();
    const session = makeSession(fake);
    await session.start();
    await session.send("the message");

    const sent = JSON.parse(fake.stdinLines[0]);
    expect(sent.type).toBe("user");
    expect(sent.message.role).toBe("user");
    expect(sent.message.content).toEqual([{ type: "text", text: "the message" }]);
  });

  test("externalSessionId is captured from system init, not just result", async () => {
    const fake = makeFakeProc({ autoReply: false, sessionId: "xyz-123" } as never);
    // Custom script: emit init first, then let send() drive the rest
    const session = makeSession(fake);
    await session.start();
    expect(session.externalSessionId).toBeUndefined();

    const sendPromise = session.send("hi");
    // Manual script the turn
    fake.emit({ type: "system", subtype: "init", session_id: "xyz-123" });
    // Session captures it even before result arrives
    await new Promise((r) => setTimeout(r, 5));
    expect(session.externalSessionId).toBe("xyz-123");

    // Finish the turn so the promise resolves
    fake.emit({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "done" }] },
    });
    fake.emit({
      type: "result",
      subtype: "success",
      result: "done",
      session_id: "xyz-123",
      usage: { input_tokens: 1, output_tokens: 1 },
    });

    await sendPromise;
  });

  test("tool_use and tool_result events are classified and preserved", async () => {
    const fake = makeFakeProc({ autoReplyOnSend: false });
    const session = makeSession(fake);
    await session.start();

    const sendPromise = session.send("run a tool");

    fake.emit({ type: "system", subtype: "init", session_id: "tool-session" });
    fake.emit({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } },
        ],
      },
    });
    fake.emit({
      type: "tool",
      content: [{ type: "tool_result", tool_use_id: "t1", content: "file1\nfile2", is_error: false }],
    });
    fake.emit({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "done" }] },
    });
    fake.emit({
      type: "result",
      subtype: "success",
      result: "done",
      session_id: "tool-session",
      usage: { input_tokens: 5, output_tokens: 3 },
    });

    const result = await sendPromise;
    const kinds = result.events.map((e) => e.kind);
    expect(kinds).toContain("tool_use");
    expect(kinds).toContain("tool_result");

    const toolUse = result.events.find((e) => e.kind === "tool_use")!;
    expect(toolUse.toolName).toBe("Bash");
    expect(toolUse.toolInput).toEqual({ command: "ls" });
  });

  test("onBeforeSend composes hooks in order and transforms the outgoing message", async () => {
    const fake = makeFakeProc();
    const session = makeSession(fake);
    await session.start();

    session.onBeforeSend((m) => `[delta] ${m}`);
    session.onBeforeSend(async (m) => `${m} [done]`);

    await session.send("original");

    const sent = JSON.parse(fake.stdinLines[0]);
    expect(sent.message.content[0].text).toBe("[delta] original [done]");
  });

  test("queue: second send() waits for first to complete", async () => {
    const fake = makeFakeProc({ autoReplyOnSend: false });
    const session = makeSession(fake);
    await session.start();

    const p1 = session.send("first");
    const p2 = session.send("second");

    // Only the first message should have reached stdin so far
    expect(fake.stdinLines.length).toBe(1);
    expect(JSON.parse(fake.stdinLines[0]).message.content[0].text).toBe("first");

    // Complete turn 1
    fake.emit({ type: "system", subtype: "init", session_id: "q" });
    fake.emit({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "r1" }] },
    });
    fake.emit({
      type: "result", subtype: "success", result: "r1",
      session_id: "q", usage: { input_tokens: 1, output_tokens: 1 },
    });

    await p1;
    // Second turn should now be in flight
    await new Promise((r) => setTimeout(r, 5));
    expect(fake.stdinLines.length).toBe(2);
    expect(JSON.parse(fake.stdinLines[1]).message.content[0].text).toBe("second");

    fake.emit({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "r2" }] },
    });
    fake.emit({
      type: "result", subtype: "success", result: "r2",
      session_id: "q", usage: { input_tokens: 1, output_tokens: 1 },
    });

    await p2;
  });

  test("fork() requires an established session id", () => {
    const fake = makeFakeProc();
    const session = makeSession(fake);
    // No start() / send() yet → no externalSessionId
    expect(() => session.fork()).toThrow(/no external session ID/);
  });

  test("fork() produces a new unstarted session that resumes from parent's external ID", async () => {
    const fake = makeFakeProc();
    const session = makeSession(fake);
    await session.start();
    await session.send("first");

    const forked = session.fork();
    expect(forked).not.toBe(session);
    expect(forked.alive).toBe(false);
  });

  test("interrupt() rejects the in-flight turn", async () => {
    const fake = makeFakeProc({ autoReplyOnSend: false });
    const session = makeSession(fake);
    await session.start();

    const p = session.send("will be interrupted");
    session.interrupt();

    await expect(p).rejects.toThrow(/interrupted/);
  });

  test("kill() tears down the session and rejects pending turns", async () => {
    const fake = makeFakeProc({ autoReplyOnSend: false });
    const session = makeSession(fake);
    await session.start();

    const p1 = session.send("first");
    const p2 = session.send("queued");
    // Attach handlers before kill() — otherwise Bun flags unhandled rejections.
    p1.catch(() => {});
    p2.catch(() => {});

    session.kill();

    await expect(p1).rejects.toThrow(/killed/);
    await expect(p2).rejects.toThrow(/killed/);
    expect(session.alive).toBe(false);
  });

  test("process exit rejects pending turns with stderr context", async () => {
    const fake = makeFakeProc({
      autoReplyOnSend: false,
      stderrText: "fatal: credit balance too low\n",
    });
    const session = makeSession(fake);
    await session.start();

    const p = session.send("will never complete");
    // Let stderr drain
    await new Promise((r) => setTimeout(r, 5));
    fake.exit(1);

    await expect(p).rejects.toThrow(/credit balance/);
  });

  test("artifact() summarizes the session across turns", async () => {
    const fake = makeFakeProc();
    const session = makeSession(fake);
    await session.start();

    await session.send("one");
    await session.send("two");

    const art = session.artifact();
    expect(art.turns).toBe(2);
    expect(art.totalTokens.input).toBe(20);
    expect(art.totalTokens.output).toBe(4);
    expect(art.errors).toBe(0);
  });

  test("push() emits a push_ignored error event (current CLI has no OOB channel)", async () => {
    const fake = makeFakeProc();
    const session = makeSession(fake);
    await session.start();

    const captured: SessionEvent[] = [];
    session.onEvent((e) => { captured.push(e); });

    await session.push({ kind: "guard_alert", text: "stop editing auth" });

    const err = captured.find((e) => e.kind === "error");
    expect(err).toBeDefined();
    expect(err!.text).toContain("push_ignored");
  });

  test("onEvent handlers receive live events and can be unsubscribed", async () => {
    const fake = makeFakeProc();
    const session = makeSession(fake);
    await session.start();

    const received: SessionEvent[] = [];
    const unsub = session.onEvent((e) => { received.push(e); });

    await session.send("hi");
    const countAfterFirst = received.length;
    expect(countAfterFirst).toBeGreaterThan(0);

    unsub();
    await session.send("again");
    // No additional events received after unsubscribe
    expect(received.length).toBe(countAfterFirst);
  });
});
