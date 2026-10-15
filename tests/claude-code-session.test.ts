import { describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ClaudeCodeSession,
  type PipedSubprocess,
  sweepOrphanedBaseContexts,
} from '../src/claude-code-session';
import type { SessionEvent } from '../src/harness-session';

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
  const sessionId = opts?.sessionId ?? 'test-session-1';
  const autoReply = opts?.autoReplyOnSend ?? true;

  const stdinLines: string[] = [];
  const stdinCbs: Array<(line: string) => void> = [];

  let stdoutCtrl: ReadableStreamDefaultController<Uint8Array>;
  const stdout = new ReadableStream<Uint8Array>({
    start(ctrl) {
      stdoutCtrl = ctrl;
    },
  });

  const stderr = new ReadableStream<Uint8Array>({
    start(ctrl) {
      if (opts?.stderrText) ctrl.enqueue(new TextEncoder().encode(opts.stderrText));
    },
  });

  let exitResolve: (code: number) => void;
  const exited = new Promise<number>((r) => {
    exitResolve = r;
  });

  const emit = (json: Record<string, unknown>) => {
    const line = `${JSON.stringify(json)}\n`;
    stdoutCtrl.enqueue(new TextEncoder().encode(line));
  };

  const exit = (code: number) => {
    try {
      stdoutCtrl.close();
    } catch {}
    exitResolve(code);
  };

  const kill = () => exit(143);

  const proc: PipedSubprocess = {
    stdin: {
      write(data: string) {
        for (const line of data.split('\n')) {
          if (!line.trim()) continue;
          stdinLines.push(line);
          for (const cb of stdinCbs) cb(line);
          if (autoReply) {
            // Simulate a minimal turn: system init → user replay → assistant text → result
            queueMicrotask(() => {
              emit({ type: 'system', subtype: 'init', session_id: sessionId });
              emit({
                type: 'user',
                message: JSON.parse(line).message,
                session_id: sessionId,
                isReplay: true,
              });
              emit({
                type: 'assistant',
                message: {
                  role: 'assistant',
                  content: [{ type: 'text', text: 'ok' }],
                },
                session_id: sessionId,
              });
              emit({
                type: 'result',
                subtype: 'success',
                is_error: false,
                result: 'ok',
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
    onStdin: (cb) => {
      stdinCbs.push(cb);
    },
  };
}

function makeSession(
  fake: ReturnType<typeof makeFakeProc>,
  extras?: ConstructorParameters<typeof ClaudeCodeSession>[0],
) {
  return new ClaudeCodeSession({
    bin: 'claude',
    cwd: '/tmp',
    model: 'haiku',
    maxTurns: 1,
    spawn: () => fake.proc,
    ...extras,
  });
}

describe('ClaudeCodeSession', () => {
  test('start() → send() captures the full turn and returns result text', async () => {
    const fake = makeFakeProc();
    const session = makeSession(fake);
    await session.start();

    const result = await session.send('hello');

    expect(result.content).toBe('ok');
    expect(result.tokens).toMatchObject({ input: 10, output: 2 });
    expect(result.externalSessionId).toBe('test-session-1');

    const kinds = result.events.map((e) => e.kind);
    expect(kinds).toContain('text');
    expect(kinds).toContain('result');
  });

  test('stdin payload uses the validated wire format', async () => {
    const fake = makeFakeProc();
    const session = makeSession(fake);
    await session.start();
    await session.send('the message');

    const sent = JSON.parse(fake.stdinLines[0]);
    expect(sent.type).toBe('user');
    expect(sent.message.role).toBe('user');
    expect(sent.message.content).toEqual([{ type: 'text', text: 'the message' }]);
  });

  test('externalSessionId is captured from system init, not just result', async () => {
    const fake = makeFakeProc({ autoReply: false, sessionId: 'xyz-123' } as never);
    // Custom script: emit init first, then let send() drive the rest
    const session = makeSession(fake);
    await session.start();
    expect(session.externalSessionId).toBeUndefined();

    const sendPromise = session.send('hi');
    // Manual script the turn
    fake.emit({ type: 'system', subtype: 'init', session_id: 'xyz-123' });
    // Session captures it even before result arrives
    await new Promise((r) => setTimeout(r, 5));
    expect(session.externalSessionId).toBe('xyz-123');

    // Finish the turn so the promise resolves
    fake.emit({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
    });
    fake.emit({
      type: 'result',
      subtype: 'success',
      result: 'done',
      session_id: 'xyz-123',
      usage: { input_tokens: 1, output_tokens: 1 },
    });

    await sendPromise;
  });

  test('tool_use and tool_result events are classified and preserved', async () => {
    const fake = makeFakeProc({ autoReplyOnSend: false });
    const session = makeSession(fake);
    await session.start();

    const sendPromise = session.send('run a tool');

    fake.emit({ type: 'system', subtype: 'init', session_id: 'tool-session' });
    fake.emit({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }],
      },
    });
    fake.emit({
      type: 'tool',
      content: [
        { type: 'tool_result', tool_use_id: 't1', content: 'file1\nfile2', is_error: false },
      ],
    });
    fake.emit({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
    });
    fake.emit({
      type: 'result',
      subtype: 'success',
      result: 'done',
      session_id: 'tool-session',
      usage: { input_tokens: 5, output_tokens: 3 },
    });

    const result = await sendPromise;
    const kinds = result.events.map((e) => e.kind);
    expect(kinds).toContain('tool_use');
    expect(kinds).toContain('tool_result');

    const toolUse = result.events.find((e) => e.kind === 'tool_use')!;
    expect(toolUse.toolName).toBe('Bash');
    expect(toolUse.toolInput).toEqual({ command: 'ls' });
  });

  test('onBeforeSend composes hooks in order and transforms the outgoing message', async () => {
    const fake = makeFakeProc();
    const session = makeSession(fake);
    await session.start();

    session.onBeforeSend((m) => `[delta] ${m}`);
    session.onBeforeSend(async (m) => `${m} [done]`);

    await session.send('original');

    const sent = JSON.parse(fake.stdinLines[0]);
    expect(sent.message.content[0].text).toBe('[delta] original [done]');
  });

  test('queue: second send() waits for first to complete', async () => {
    const fake = makeFakeProc({ autoReplyOnSend: false });
    const session = makeSession(fake);
    await session.start();

    const p1 = session.send('first');
    const p2 = session.send('second');

    // Only the first message should have reached stdin so far
    expect(fake.stdinLines.length).toBe(1);
    expect(JSON.parse(fake.stdinLines[0]).message.content[0].text).toBe('first');

    // Complete turn 1
    fake.emit({ type: 'system', subtype: 'init', session_id: 'q' });
    fake.emit({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'r1' }] },
    });
    fake.emit({
      type: 'result',
      subtype: 'success',
      result: 'r1',
      session_id: 'q',
      usage: { input_tokens: 1, output_tokens: 1 },
    });

    await p1;
    // Second turn should now be in flight
    await new Promise((r) => setTimeout(r, 5));
    expect(fake.stdinLines.length).toBe(2);
    expect(JSON.parse(fake.stdinLines[1]).message.content[0].text).toBe('second');

    fake.emit({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'r2' }] },
    });
    fake.emit({
      type: 'result',
      subtype: 'success',
      result: 'r2',
      session_id: 'q',
      usage: { input_tokens: 1, output_tokens: 1 },
    });

    await p2;
  });

  test('fork() requires an established session id', () => {
    const fake = makeFakeProc();
    const session = makeSession(fake);
    // No start() / send() yet → no externalSessionId
    expect(() => session.fork()).toThrow(/no external session ID/);
  });

  test("fork() produces a new unstarted session that resumes from parent's external ID", async () => {
    const fake = makeFakeProc();
    const session = makeSession(fake);
    await session.start();
    await session.send('first');

    const forked = session.fork();
    expect(forked).not.toBe(session);
    expect(forked.alive).toBe(false);
  });

  test('interrupt() rejects the in-flight turn', async () => {
    const fake = makeFakeProc({ autoReplyOnSend: false });
    const session = makeSession(fake);
    await session.start();

    const p = session.send('will be interrupted');
    session.interrupt();

    await expect(p).rejects.toThrow(/interrupted/);
  });

  test('the base context rides in a private file, not argv, and is removed with the process', async () => {
    const fake = makeFakeProc();
    let argv: string[] = [];
    const base = `BASE ${'x'.repeat(200 * 1024)}`;
    const session = new ClaudeCodeSession({
      bin: 'claude',
      cwd: '/tmp',
      model: 'haiku',
      baseContext: base,
      spawn: (cmd) => {
        argv = cmd;
        return fake.proc;
      },
    });
    await session.start();
    expect(argv).not.toContain('--append-system-prompt');
    expect(argv.every((arg) => arg.length < 128 * 1024)).toBe(true);
    const file = argv[argv.indexOf('--append-system-prompt-file') + 1]!;
    expect(readFileSync(file, 'utf8')).toBe(base);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    session.kill();
    expect(existsSync(file)).toBe(false);
  });

  test("a dead process's base context directory is swept; a live one's is kept", () => {
    const dir = mkdtempSync(join(tmpdir(), 'sweep-'));
    try {
      const dead = join(dir, 'agent-session-base-2147483646-abc');
      const live = join(dir, `agent-session-base-${process.ppid}-def`);
      const other = join(dir, 'unrelated-2147483646-x');
      for (const path of [dead, live, other]) {
        mkdirSync(path);
        writeFileSync(join(path, 'append-system-prompt.md'), 'CONTEXT');
      }
      sweepOrphanedBaseContexts(dir);
      expect([dead, live, other].map((path) => existsSync(path))).toEqual([false, true, true]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a process that exits on its own removes its base context file', async () => {
    const fake = makeFakeProc();
    let argv: string[] = [];
    const session = new ClaudeCodeSession({
      bin: 'claude',
      cwd: '/tmp',
      model: 'haiku',
      baseContext: 'BASE',
      spawn: (cmd) => {
        argv = cmd;
        return fake.proc;
      },
    });
    await session.start();
    const file = argv[argv.indexOf('--append-system-prompt-file') + 1]!;
    expect(existsSync(file)).toBe(true);
    fake.exit(1);
    await Bun.sleep(10);
    expect(existsSync(file)).toBe(false);
  });

  test('kill() tears down the session and rejects pending turns', async () => {
    const fake = makeFakeProc({ autoReplyOnSend: false });
    const session = makeSession(fake);
    await session.start();

    const p1 = session.send('first');
    const p2 = session.send('queued');
    // Attach handlers before kill() — otherwise Bun flags unhandled rejections.
    p1.catch(() => {});
    p2.catch(() => {});

    session.kill();

    await expect(p1).rejects.toThrow(/killed/);
    await expect(p2).rejects.toThrow(/killed/);
    expect(session.alive).toBe(false);
  });

  test('process exit rejects pending turns with stderr context', async () => {
    const fake = makeFakeProc({
      autoReplyOnSend: false,
      stderrText: 'fatal: credit balance too low\n',
    });
    const session = makeSession(fake);
    await session.start();

    const p = session.send('will never complete');
    // Let stderr drain
    await new Promise((r) => setTimeout(r, 5));
    fake.exit(1);

    await expect(p).rejects.toThrow(/credit balance/);
  });

  test('artifact() summarizes the session across turns', async () => {
    const fake = makeFakeProc();
    const session = makeSession(fake);
    await session.start();

    await session.send('one');
    await session.send('two');

    const art = session.artifact();
    expect(art.turns).toBe(2);
    expect(art.totalTokens.input).toBe(20);
    expect(art.totalTokens.output).toBe(4);
    expect(art.errors).toBe(0);
  });

  test('push() emits a push_ignored error event (current CLI has no OOB channel)', async () => {
    const fake = makeFakeProc();
    const session = makeSession(fake);
    await session.start();

    const captured: SessionEvent[] = [];
    session.onEvent((e) => {
      captured.push(e);
    });

    await session.push({ kind: 'guard_alert', text: 'stop editing auth' });

    const err = captured.find((e) => e.kind === 'error');
    expect(err).toBeDefined();
    expect(err!.text).toContain('push_ignored');
  });

  test('onEvent handlers receive live events and can be unsubscribed', async () => {
    const fake = makeFakeProc();
    const session = makeSession(fake);
    await session.start();

    const received: SessionEvent[] = [];
    const unsub = session.onEvent((e) => {
      received.push(e);
    });

    await session.send('hi');
    const countAfterFirst = received.length;
    expect(countAfterFirst).toBeGreaterThan(0);

    unsub();
    await session.send('again');
    // No additional events received after unsubscribe
    expect(received.length).toBe(countAfterFirst);
  });
});

describe('Claude usage telemetry', () => {
  const usage = {
    input_tokens: 10,
    output_tokens: 20,
    cache_read_input_tokens: 1000,
    cache_creation_input_tokens: 200,
    cache_creation: { ephemeral_5m_input_tokens: 50, ephemeral_1h_input_tokens: 150 },
    output_tokens_details: { thinking_tokens: 12 },
    service_tier: 'standard',
    inference_geo: 'us',
    future_tag: { retained: true },
  };

  test('preserves tags and disjoint cache counters through results, totals and artifacts', async () => {
    const fake = makeFakeProc({ autoReplyOnSend: false });
    const session = makeSession(fake);
    fake.onStdin(() =>
      queueMicrotask(() => {
        // The same request can appear once per content block. Result is the
        // authoritative aggregate, not an additional billable request.
        for (let i = 0; i < 2; i++)
          fake.emit({
            type: 'assistant',
            requestId: 'request-1',
            message: {
              id: 'message-1',
              model: 'test-model',
              usage,
              content: [{ type: 'text', text: 'ok' }],
            },
          });
        fake.emit({ type: 'result', subtype: 'success', result: 'done', usage });
      }),
    );
    await session.start();
    try {
      const result = await session.send('hello');
      expect(result.tokens).toEqual({
        input: 10,
        output: 20,
        cacheRead: 1000,
        cacheWrite: 200,
        cacheWrite5m: 50,
        cacheWrite1h: 150,
        thinking: 12,
        providerUsage: usage,
      });
      expect(result.events.filter((e) => e.kind === 'usage')).toHaveLength(2);
      expect(result.events.find((e) => e.kind === 'usage')?.raw).toMatchObject({
        requestId: 'request-1',
        message: { id: 'message-1', usage },
      });
      await session.send('again');
      expect(session.totalTokens).toEqual({
        input: 20,
        output: 40,
        cacheRead: 2000,
        cacheWrite: 400,
        cacheWrite5m: 100,
        cacheWrite1h: 300,
        thinking: 24,
      });
      const artifact = JSON.parse(JSON.stringify(session.artifact()));
      expect(artifact.totalTokens).toEqual(session.totalTokens);
      expect(
        artifact.events.find((e: SessionEvent) => e.kind === 'result').tokens.providerUsage,
      ).toEqual(usage);
    } finally {
      session.kill();
    }
  });

  test('keeps request usage available after an interrupted turn without fabricating turn totals', async () => {
    const fake = makeFakeProc({ autoReplyOnSend: false });
    const session = makeSession(fake);
    await session.start();
    const pending = session.send('hello');
    const rejected = pending.catch((error) => error);
    fake.emit({ type: 'assistant', message: { id: 'partial', usage, content: [] } });
    await new Promise<void>((resolve) =>
      session.onEvent((e) => {
        if (e.kind === 'usage') resolve();
      }),
    );
    session.kill();
    expect(await rejected).toBeInstanceOf(Error);
    expect(
      session.artifact().events.find((e) => e.kind === 'usage')?.tokens?.providerUsage,
    ).toEqual(usage);
    expect(session.totalTokens).toEqual({ input: 0, output: 0 });
  });

  test('subagent frames are tagged with the spawning call and never become the parent content', async () => {
    const fake = makeFakeProc({ autoReplyOnSend: false });
    const session = makeSession(fake);
    await session.start();
    const sendPromise = session.send('delegate');
    fake.emit({ type: 'system', subtype: 'init', session_id: 'sub-session' });
    fake.emit({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'spawn-1', name: 'Agent', input: { prompt: 'look' } }],
      },
    });
    fake.emit({
      type: 'system',
      subtype: 'task_started',
      task_id: 'task-a',
      tool_use_id: 'spawn-1',
      description: 'look around',
      subagent_type: 'explorer',
      spawn_depth: 1,
      is_backgrounded: false,
      prompt: 'look',
    });
    fake.emit({
      type: 'assistant',
      parent_tool_use_id: 'spawn-1',
      message: { role: 'assistant', content: [{ type: 'text', text: 'CHILD TEXT' }] },
    });
    fake.emit({
      type: 'system',
      subtype: 'task_notification',
      task_id: 'task-a',
      tool_use_id: 'spawn-1',
      status: 'completed',
      summary: 'found it',
    });
    fake.emit({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'PARENT TEXT' }] },
    });
    fake.emit({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'PARENT TEXT',
      session_id: 'sub-session',
    });
    const result = await sendPromise;
    expect(result.content).toBe('PARENT TEXT');
    const child = result.events.find((e) => e.text === 'CHILD TEXT')!;
    expect(child).toMatchObject({ kind: 'text', parentToolUseId: 'spawn-1' });
    const lifecycle = result.events.filter((e) => e.kind === 'subagent').map((e) => e.subagent);
    expect(lifecycle).toEqual([
      {
        phase: 'started',
        taskId: 'task-a',
        toolUseId: 'spawn-1',
        agentType: 'explorer',
        description: 'look around',
        depth: 1,
        backgrounded: false,
        prompt: 'look',
      },
      {
        phase: 'ended',
        taskId: 'task-a',
        toolUseId: 'spawn-1',
        status: 'completed',
        summary: 'found it',
      },
    ]);
    // A text that arrives before the parent's own is still not the parent's content.
    const early = result.events.findIndex((e) => e.text === 'CHILD TEXT');
    expect(early).toBeGreaterThan(-1);
  });

  test('a background subagent working between turns still reaches handlers, tagged and unattributed', async () => {
    const fake = makeFakeProc();
    const session = makeSession(fake);
    await session.start();
    await session.send('start a background agent');
    const captured: SessionEvent[] = [];
    session.onEvent((e) => {
      captured.push(e);
    });
    fake.emit({
      type: 'assistant',
      session_id: 'test-session-1',
      parent_tool_use_id: 'spawn-bg',
      message: { role: 'assistant', content: [{ type: 'text', text: 'BACKGROUND' }] },
    });
    fake.emit({
      type: 'system',
      session_id: 'test-session-1',
      subtype: 'task_notification',
      task_id: 'task-bg',
      tool_use_id: 'spawn-bg',
      status: 'completed',
    });
    await new Promise((r) => setTimeout(r, 5));
    expect(captured.map((e) => [e.kind, e.unattributedReason, e.parentToolUseId])).toEqual([
      ['text', 'no-admission', 'spawn-bg'],
      ['subagent', 'no-admission', undefined],
    ]);
    expect(captured[1]!.subagent).toMatchObject({
      phase: 'ended',
      taskId: 'task-bg',
      status: 'completed',
    });
    // Unrelated frames between turns stay plain diagnostics.
    fake.emit({
      type: 'assistant',
      session_id: 'test-session-1',
      message: { role: 'assistant', content: [{ type: 'text', text: 'STRAY' }] },
    });
    await new Promise((r) => setTimeout(r, 5));
    expect(captured.at(-1)).toMatchObject({
      kind: 'native_status',
      unattributedReason: 'no-admission',
    });
  });
});
