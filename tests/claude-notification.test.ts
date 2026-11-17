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

function replay() {
  const secondAt = frames.findIndex((f) => f.__marker === 'prompt-2-written');
  const stdin: Frame[] = [];
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
          if (message.type !== 'user') continue;
          stdin.push(message);
          const uuid = message.uuid as string;
          if (stdin.length === 1)
            queueMicrotask(() => emitRange(0, secondAt, '__PROMPT_1__', uuid));
          else queueMicrotask(() => emitRange(secondAt + 1, frames.length, '__PROMPT_2__', uuid));
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
  return { session, stdin };
}

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
    // The notification's turn is session history, never the second turn's.
    const foreign = session.events
      .filter((e) => e.unattributedReason === 'foreign-turn')
      .map((e) => JSON.stringify(e.raw));
    expect(foreign.some((raw) => raw.includes('"type":"result"'))).toBe(true);
    expect(foreign.some((raw) => raw.includes('background command'))).toBe(true);
    expect(session.turns).toBe(2);
    session.kill();
  });
});
