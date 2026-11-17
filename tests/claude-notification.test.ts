import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { ClaudeCodeSession, type PipedSubprocess } from '../src/claude-code-session';

// Replays a real claude 2.1.326 run (fixtures/claude-notification/README.md) through a fake
// process: the frames before `prompt-2-written` answer the first message, the rest the second,
// with each recorded message uuid replaced by the one the session wrote.

type Frame = Record<string, unknown>;
const frames = readFileSync(
  new URL('../fixtures/claude-notification/queued-behind.jsonl', import.meta.url),
  'utf8',
)
  .trim()
  .split('\n')
  .map((line) => JSON.parse(line) as Frame);

/** `manualSecond`: the second message gets no recorded answer; the test emits its frames. */
function replay({ manualSecond = false } = {}) {
  const secondAt = frames.findIndex((f) => f.__marker === 'prompt-2-written');
  const stdin: Frame[] = [];
  const controls: Frame[] = [];
  let out!: ReadableStreamDefaultController<Uint8Array>;
  const stdout = new ReadableStream<Uint8Array>({
    start(c) {
      out = c;
    },
  });
  let exit!: (code: number) => void;
  const exited = new Promise<number>((r) => {
    exit = r;
  });
  const emitRange = (from: number, to: number, marker: string, uuid: string) => {
    for (const f of frames.slice(from, to)) {
      if (f.__marker) continue;
      const line = JSON.stringify(f).replaceAll(marker, uuid);
      out.enqueue(new TextEncoder().encode(`${line}\n`));
    }
  };
  const proc: PipedSubprocess = {
    stdin: {
      write(data: string) {
        for (const line of data.split('\n')) {
          if (!line.trim()) continue;
          const message = JSON.parse(line) as Frame;
          if (message.type === 'control_request') controls.push(message);
          if (message.type !== 'user') continue;
          stdin.push(message);
          const uuid = message.uuid as string;
          if (stdin.length === 1)
            queueMicrotask(() => emitRange(0, secondAt, '__PROMPT_1__', uuid));
          else if (!manualSecond)
            queueMicrotask(() => emitRange(secondAt + 1, frames.length, '__PROMPT_2__', uuid));
        }
      },
      flush() {},
      end() {},
    },
    stdout,
    stderr: new ReadableStream<Uint8Array>({ start: (c) => c.close() }),
    exited,
    kill: () => {
      try {
        out.close();
      } catch {}
      exit(143);
    },
  };
  const session = new ClaudeCodeSession({
    bin: 'claude',
    cwd: '/tmp',
    model: 'haiku',
    spawn: () => proc,
  });
  /** Sends recorded frames (1-based fixture lines) or literal frames as the CLI's own output. */
  const emit = (...items: (number | Frame)[]) => {
    for (const item of items) {
      const f = typeof item === 'number' ? frames[item - 1]! : item;
      const line = JSON.stringify(f)
        .replaceAll('__PROMPT_1__', String(stdin[0]?.uuid))
        .replaceAll('__PROMPT_2__', String(stdin[1]?.uuid));
      out.enqueue(new TextEncoder().encode(`${line}\n`));
    }
  };
  return { session, stdin, controls, emit };
}

const settle = () => Bun.sleep(5);

describe('Claude turns of its own (a task notification)', () => {
  test('every turn message carries its own uuid', async () => {
    const { session, stdin } = replay();
    await session.start();
    await session.send('start the background task');
    expect(stdin[0]).toMatchObject({ type: 'user', parent_tool_use_id: null });
    expect(typeof stdin[0]!.uuid).toBe('string');
    session.kill();
  });

  test("a message queued behind a notification's turn settles on its own result, not that one", async () => {
    const { session } = replay();
    await session.start();
    const first = await session.send('start the background task');
    expect(first.content).toContain('STARTED');
    const second = await session.send('Reply with exactly the word BANANA.');
    expect(second.nativeOutcome).toBe('completed');
    expect(second.content).toContain('BANANA');
    expect(second.content).not.toContain('background command');
    expect(second.events.filter((e) => e.kind === 'result')).toHaveLength(1);
    // The notification's turn is a turn of the CLI's own, never the second turn's.
    const foreign = session.events
      .filter((e) => e.unattributedReason === 'foreign-turn')
      .map((e) => (e.raw as Frame | undefined)?.type);
    expect(foreign).not.toContain('assistant');
    expect(foreign).not.toContain('result');
    const wake = session.events.filter((e) => e.correlation === 'native-turn');
    const turnId = wake[0]?.turnId;
    expect(turnId).toBeString();
    expect(wake.every((e) => e.turnId === turnId && e.unattributedReason === 'task')).toBe(true);
    expect(wake[0]).toMatchObject({
      kind: 'task',
      task: { phase: 'started', taskId: turnId, taskType: 'claude-wake' },
    });
    expect(wake[0]?.task?.description).toContain('Background command');
    const result = wake.find((e) => e.kind === 'result');
    expect(result?.text).toContain('background command');
    expect(result?.nativeOutcome).toBe('completed');
    expect(wake.at(-1)).toMatchObject({
      kind: 'task',
      task: { phase: 'ended', taskId: turnId, status: 'completed' },
    });
    expect(session.turns).toBe(2);
    session.kill();
  });

  test('a notification turn with no message in flight is a turn of its own', async () => {
    const { session, emit } = replay();
    await session.start();
    await session.send('start the background task');
    emit(11, 12, 13, 14, 15, 18, 19);
    await settle();
    const open = session.events.filter((e) => e.correlation === 'native-turn');
    expect(open[0]).toMatchObject({ kind: 'task', task: { phase: 'started' } });
    expect(open.some((e) => e.kind === 'text')).toBe(true);
    expect(open.some((e) => e.task?.phase === 'ended')).toBe(false);
    emit(20);
    await settle();
    const wake = session.events.filter((e) => e.correlation === 'native-turn');
    expect(wake.find((e) => e.kind === 'result')?.text).toContain('background command');
    expect(wake.at(-1)?.task).toMatchObject({ phase: 'ended', status: 'completed' });
    const dropped = session.events
      .filter((e) => e.unattributedReason === 'no-admission')
      .map((e) => (e.raw as Frame | undefined)?.type);
    expect(dropped).not.toContain('assistant');
    expect(dropped).not.toContain('result');
    expect(session.turns).toBe(1);
    session.kill();
  });

  test('a lone result with no turn open, or a frame before the CLI names its messages, opens nothing', async () => {
    const { session, emit } = replay();
    await session.start();
    emit(18);
    await settle();
    expect(session.events.some((e) => e.correlation === 'native-turn')).toBe(false);
    await session.send('start the background task');
    emit(11, 20);
    await settle();
    expect(session.events.some((e) => e.correlation === 'native-turn')).toBe(false);
    session.kill();
  });

  test('a stop with no message in flight stops the turn the CLI started', async () => {
    const { session, emit, controls } = replay();
    await session.start();
    await session.send('start the background task');
    emit(11, 13, 15, 18);
    await settle();
    const stopping = session.interruptNative({ timeoutMs: 1000 });
    await settle();
    const request = controls.find((c) => (c.request as Frame | undefined)?.subtype === 'interrupt');
    expect(request).toBeDefined();
    emit(
      {
        type: 'control_response',
        response: { subtype: 'success', request_id: request!.request_id },
      },
      { ...frames[19]!, subtype: 'error_during_execution', is_error: true, uuid: 'wake-stop' },
    );
    expect(await stopping).toBe('acknowledged');
    const ended = session.events.filter(
      (e) => e.task?.phase === 'ended' && e.task.taskType === 'claude-wake',
    );
    expect(ended).toHaveLength(1);
    expect(ended[0]?.task?.status).toBe('failed');
    session.kill();
  });

  test('a session that ends mid-turn ends the turn the CLI started', async () => {
    const { session, emit } = replay();
    await session.start();
    await session.send('start the background task');
    emit(11, 15, 18);
    await settle();
    session.kill();
    const ended = session.events.filter(
      (e) => e.task?.taskType === 'claude-wake' && e.task.phase === 'ended',
    );
    expect(ended).toHaveLength(1);
    expect(ended[0]?.task?.status).toBe('killed');
  });
  test('two turns the CLI starts in a row are two turns, each with its own cause', async () => {
    const { session, emit } = replay();
    await session.start();
    await session.send('start the background task');
    emit(11, 13, 15, 18, 20);
    await settle();
    emit(
      { ...frames[6]!, task_id: 'second-task', uuid: 't2' },
      {
        ...frames[12]!,
        task_id: 'second-task',
        summary: 'Second background command finished',
        uuid: 'n2',
      },
      { ...frames[17]!, uuid: 'a2' },
      { ...frames[19]!, uuid: 'r2' },
    );
    await settle();
    const started = session.events.filter(
      (e) => e.task?.taskType === 'claude-wake' && e.task.phase === 'started',
    );
    expect(started).toHaveLength(2);
    expect(started[0]!.turnId).not.toBe(started[1]!.turnId);
    expect(started[1]!.task?.description).toBe('Second background command finished');
    const ended = session.events.filter(
      (e) => e.task?.taskType === 'claude-wake' && e.task.phase === 'ended',
    );
    expect(ended.map((e) => e.task?.status)).toEqual(['completed', 'completed']);
    session.kill();
  });

  test("the CLI starting one of this session's messages ends its own turn as unknown", async () => {
    const { session, emit } = replay({ manualSecond: true });
    await session.start();
    await session.send('start the background task');
    emit(11, 13, 15, 18);
    await settle();
    const second = session.send('Reply with exactly the word BANANA.');
    await settle();
    // Before the CLI takes our message in, the model's frames are still its own turn's.
    emit(17, 19);
    await settle();
    emit(21);
    await settle();
    const ended = session.events.filter(
      (e) => e.task?.taskType === 'claude-wake' && e.task.phase === 'ended',
    );
    expect(ended).toHaveLength(1);
    expect(ended[0]?.task).toMatchObject({ status: 'unknown', reason: 'message started' });
    const wakeText = session.events.filter(
      (e) => e.correlation === 'native-turn' && e.kind === 'text',
    );
    expect(wakeText.length).toBeGreaterThan(0);
    emit(22, 23, 24);
    const answer = await second;
    expect(answer.content).toContain('BANANA');
    expect(answer.content).not.toContain('background command');
    session.kill();
  });

  test('a result with no success or error ends the turn as unknown, its text as the summary', async () => {
    const { session, emit } = replay();
    await session.start();
    await session.send('start the background task');
    const { subtype: _subtype, ...noSubtype } = frames[19]!;
    emit(11, 13, 15, 18, { ...noSubtype, uuid: 'r-unknown' });
    await settle();
    const ended = session.events.find(
      (e) => e.task?.taskType === 'claude-wake' && e.task.phase === 'ended',
    );
    expect(ended?.task?.status).toBe('unknown');
    expect(ended?.task?.summary).toContain('background command');
    session.kill();
  });
});
