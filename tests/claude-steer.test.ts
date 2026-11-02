import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { ClaudeCodeSession, type PipedSubprocess } from '../src/claude-code-session';
import type { SessionEvent } from '../src/harness-session';
import { TRANSPORTS } from '../src/transport';

// Replays real claude 2.1.316 steer runs (fixtures/claude-steer/README.md) through a fake process:
// the frames before `steer-written` answer the turn's message, the rest answer the steer, with the
// recorded steer uuid replaced by the one the session wrote.

type Frame = Record<string, unknown>;
const cassette = (name: string): Frame[] =>
  readFileSync(new URL(`../fixtures/claude-steer/${name}.jsonl`, import.meta.url), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Frame);

function replay(name: string, opts?: { holdAfterFirstResult?: boolean }) {
  const frames = cassette(name);
  const steerAt = frames.findIndex((f) => f.__marker === 'steer-written');
  const cancelAt = frames.findIndex((f) => f.__marker === 'cancel-written');
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
  const emit = (f: Frame) => out.enqueue(new TextEncoder().encode(`${JSON.stringify(f)}\n`));
  const emitRange = (from: number, to: number, uuid?: string) => {
    for (const f of frames.slice(from, to)) {
      if (f.__marker || f.type === 'control_response') continue;
      emit(uuid ? JSON.parse(JSON.stringify(f).replaceAll('__STEER_UUID__', uuid)) : f);
    }
  };
  let steerUuid: string | undefined;
  const recordedResponse = (subtype: string) =>
    (
      frames.find(
        (f) =>
          f.type === 'control_response' &&
          (f.response as { request_id?: string }).request_id ===
            (subtype === 'interrupt' ? 'i1' : 'c1'),
      )?.response as { response?: unknown }
    )?.response;
  const proc: PipedSubprocess = {
    stdin: {
      write(data: string) {
        for (const line of data.split('\n')) {
          if (!line.trim()) continue;
          const message = JSON.parse(line) as Frame;
          stdin.push(message);
          if (message.type === 'user' && !message.priority)
            queueMicrotask(() => emitRange(0, steerAt));
          else if (message.type === 'user') {
            steerUuid = message.uuid as string;
            // Held: stop after the first result, before the CLI starts the steer's run.
            const firstResult = frames.findIndex((f, i) => i > steerAt && f.type === 'result');
            const until = opts?.holdAfterFirstResult
              ? firstResult + 1
              : cancelAt === -1
                ? frames.length
                : cancelAt;
            queueMicrotask(() => emitRange(steerAt + 1, until, steerUuid));
          } else if (message.type === 'control_request') {
            const request = message.request as { subtype: string };
            const id = message.request_id as string;
            queueMicrotask(() => {
              if (opts?.holdAfterFirstResult && request.subtype === 'cancel_async_message') {
                emit({
                  type: 'control_response',
                  response: { subtype: 'success', request_id: id, response: { cancelled: true } },
                });
                emit({
                  type: 'command_lifecycle',
                  command_uuid: steerUuid,
                  state: 'cancelled',
                  session_id: 'steer-session-1',
                });
                return;
              }
              emit({
                type: 'control_response',
                response: {
                  subtype: 'success',
                  request_id: id,
                  response: recordedResponse(request.subtype) ?? {},
                },
              });
              if (request.subtype === 'interrupt' && cancelAt !== -1)
                emitRange(cancelAt + 1, frames.length, steerUuid);
            });
          }
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
  const events: SessionEvent[] = [];
  session.onEvent((e) => void events.push(e));
  return { session, stdin, events };
}

/** Send the turn, wait until it is in flight, then steer. */
async function steerDuring(name: string, opts?: { holdAfterFirstResult?: boolean }) {
  const r = replay(name, opts);
  await r.session.start();
  const settled = r.session.send('the task').then(
    (result) => ({ result }),
    (error: Error) => ({ error }),
  );
  while (!r.events.some((e) => e.kind === 'text' || e.kind === 'tool_use')) await Bun.sleep(1);
  const pushed = await r.session.push({ kind: 'steer', text: 'Steer: end with PINEAPPLE.' });
  return { ...r, pushed, settled };
}

describe('Claude steer (push into the running turn)', () => {
  test('claude-cli declares steer; the Agent SDK transport does not', () => {
    expect(TRANSPORTS['claude-cli'].capabilities.push).toBe('steer');
    expect(TRANSPORTS['claude-agent-sdk'].capabilities.push).toBe('none');
  });

  test('a steer taken in after a tool result: one turn, one result, the steer answered in it', async () => {
    const { session, stdin, pushed, settled, events } = await steerDuring('fold-in');
    expect(pushed).toEqual({ outcome: 'steered' });
    const steer = stdin.find((m) => m.priority === 'next')!;
    expect(steer).toMatchObject({
      type: 'user',
      parent_tool_use_id: null,
      message: { role: 'user', content: [{ type: 'text', text: 'Steer: end with PINEAPPLE.' }] },
    });
    expect(typeof steer.uuid).toBe('string');
    const { result } = (await settled) as { result: Awaited<ReturnType<typeof session.send>> };
    expect(result.nativeOutcome).toBe('completed');
    expect(result.content).toContain('PINEAPPLE');
    expect(session.turns).toBe(1);
    expect(
      events.find((e) => (e.raw as { type?: string })?.type === 'push-steered')?.admissionId,
    ).toBe(result.admissionId);
    session.kill();
  });

  test('a steer the reply had finished before: the turn stays open for its follow-on result', async () => {
    const { session, pushed, settled } = await steerDuring('follow-on');
    expect(pushed).toEqual({ outcome: 'steered' });
    const { result } = (await settled) as { result: Awaited<ReturnType<typeof session.send>> };
    expect(result.nativeOutcome).toBe('completed');
    // The turn's answer is the follow-on run's; both results' usage is the turn's.
    expect(result.content).toContain('PINEAPPLE');
    expect(result.events.filter((e) => e.kind === 'result')).toHaveLength(2);
    const [first, second] = result.events.filter((e) => e.kind === 'result');
    expect(result.tokens?.output).toBe(
      (first!.tokens?.output ?? 0) + (second!.tokens?.output ?? 0),
    );
    expect(session.turns).toBe(1);
    expect(session.events.filter((e) => e.unattributedReason === 'no-admission')).toEqual([]);
    session.kill();
  });

  test('a stop while a steer runs after the result: the steer is withdrawn first, then the turn stops', async () => {
    const { session, stdin, pushed, settled } = await steerDuring('withdraw');
    expect(pushed).toEqual({ outcome: 'steered' });
    // Wait until the first result has come and the follow-on started (the turn is held).
    while (!session.events.some((e) => e.kind === 'result')) await Bun.sleep(1);
    await Bun.sleep(5);
    expect(await session.interruptNative({ timeoutMs: 2_000 })).toBe('acknowledged');
    const requests = stdin.filter((m) => m.type === 'control_request').map((m) => m.request);
    // It had started (the recording's cancel answered false), so the stop is a plain interrupt.
    expect(requests).toEqual([{ subtype: 'interrupt' }]);
    const outcome = await settled;
    expect('error' in outcome || outcome.result.nativeOutcome === 'failed').toBe(true);
    session.kill();
  });

  test('a stop while a steer still waits after the result: withdrawn, and the turn settles on its result', async () => {
    const { session, stdin, pushed, settled } = await steerDuring('follow-on', {
      holdAfterFirstResult: true,
    });
    expect(pushed).toEqual({ outcome: 'steered' });
    while (!session.events.some((e) => e.kind === 'result')) await Bun.sleep(1);
    expect(await session.interruptNative({ timeoutMs: 2_000 })).toBe('acknowledged');
    const requests = stdin.filter((m) => m.type === 'control_request').map((m) => m.request);
    expect(requests).toEqual([
      { subtype: 'cancel_async_message', message_uuid: stdin.find((m) => m.priority)!.uuid },
    ]);
    const { result } = (await settled) as { result: Awaited<ReturnType<typeof session.send>> };
    expect(result.nativeOutcome).toBe('completed');
    expect(result.events.filter((e) => e.kind === 'result')).toHaveLength(1);
    session.kill();
  });

  test('no owned in-flight turn: ignored, with the reason, and nothing written', async () => {
    const r = replay('fold-in');
    await r.session.start();
    expect(await r.session.push({ kind: 'steer', text: 'x' })).toEqual({
      outcome: 'ignored',
      reason: 'no owned in-flight turn',
    });
    expect(r.stdin).toEqual([]);
    expect(r.events.find((e) => e.kind === 'error')?.text).toContain('push_ignored');
    r.session.kill();
  });
});
