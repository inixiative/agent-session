import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CLAUDE_SESSION_SNAPSHOT_VERSION,
  ClaudeCodeSession,
  type ClaudeCodeSessionConfig,
  type ClaudeSessionSnapshot,
  type PipedSubprocess,
  sweepOrphanedBaseContexts,
} from '../src/claude-code-session';
import { SessionDetached, SessionReturned, SessionTurnError } from '../src/harness-session';
import { KEEPER_PROTOCOL } from '../src/keeper/protocol';

// detach() / fromSnapshot() / resume() over a fake keeper-held process: the streams end on
// detach without the CLI exiting, and a second fake stands in for the process `attachKeeper`
// returns, recording where the session released it. Wire shapes as in tool-gate.test.ts.

const SESSION = 'kept-session';
type Frame = Record<string, any>;

interface Kept {
  readonly proc: PipedSubprocess;
  readonly lines: Frame[];
  emit(frame: Frame): void;
  /** The offset `release()` was called with; undefined until then. */
  released?: number;
  /** Set false to make `stdin.drained()` never settle. */
  drains: boolean;
  /** Set to make `detach()` throw, as a keeper that never confirms the hold does. */
  failDetach?: Error;
  /** Set to hold `drained()` until it resolves. */
  drainGate?: Promise<void>;
}

/** A keeper-held CLI: answers `initialize`, then hands each other stdin frame to `onMessage`. */
function kept(onMessage: (message: Frame, io: Kept) => void = () => {}, offset = 7): Kept {
  let out!: ReadableStreamDefaultController<Uint8Array>;
  let detached = false;
  let exit!: (code: number) => void;
  const encoder = new TextEncoder();
  const io: Kept = {
    lines: [],
    drains: true,
    emit(frame) {
      if (!detached) out.enqueue(encoder.encode(`${JSON.stringify(frame)}\n`));
    },
    proc: {
      pid: 4242,
      ready: Promise.resolve(),
      get detached() {
        return detached;
      },
      stdout: new ReadableStream<Uint8Array>({
        start(c) {
          out = c;
        },
      }),
      stderr: new ReadableStream<Uint8Array>({ start: (c) => c.close() }),
      exited: new Promise<number>((resolve) => {
        exit = resolve;
      }),
      kill() {
        try {
          out.close();
        } catch {
          /* closed */
        }
        exit(143);
      },
      stdin: {
        write(data: string) {
          for (const line of data.split('\n')) {
            if (!line.trim()) continue;
            const message = JSON.parse(line) as Frame;
            io.lines.push(message);
            queueMicrotask(() => {
              if (message.type === 'control_request' && message.request.subtype === 'initialize') {
                io.emit({
                  type: 'control_response',
                  response: { subtype: 'success', request_id: message.request_id, response: {} },
                });
                return;
              }
              onMessage(message, io);
            });
          }
        },
        flush() {},
        end() {},
        drained: () =>
          io.drainGate ?? (io.drains ? Promise.resolve() : new Promise<void>(() => {})),
      },
      async detach() {
        if (io.failDetach) throw io.failDetach;
        detached = true;
        out.close();
        return { offset };
      },
      release(after: number) {
        io.released = after;
      },
    },
  };
  return io;
}

/** A CLI that starts each user message's turn and leaves it running (no result). */
const running = (message: Frame, io: Kept) => {
  if (message.type !== 'user') return;
  io.emit({ type: 'system', subtype: 'init', session_id: SESSION });
  io.emit({
    type: 'assistant',
    session_id: SESSION,
    message: { role: 'assistant', content: [{ type: 'text', text: 'working' }] },
  });
};

const result = (text: string) => ({
  type: 'result',
  subtype: 'success',
  result: text,
  session_id: SESSION,
  uuid: Bun.randomUUIDv7(),
});

const sessions: ClaudeCodeSession[] = [];
afterEach(() => {
  for (const session of sessions.splice(0)) session.kill();
});

function session(proc: PipedSubprocess, config: ClaudeCodeSessionConfig = {}) {
  const s = new ClaudeCodeSession({ cwd: '/tmp', model: 'haiku', ...config, spawn: () => proc });
  sessions.push(s);
  return s;
}

function rebuilt(snapshot: ClaudeSessionSnapshot, config: ClaudeCodeSessionConfig = {}) {
  const s = ClaudeCodeSession.fromSnapshot(snapshot, { cwd: '/tmp', model: 'haiku', ...config });
  sessions.push(s);
  return s;
}

async function until(check: () => boolean, withinMs = 2_000) {
  const end = Date.now() + withinMs;
  while (!check()) {
    if (Date.now() > end) throw new Error('condition not met in time');
    await Bun.sleep(2);
  }
}

const cause = async (promise: Promise<unknown>) => {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(SessionTurnError);
  return (error as SessionTurnError).cause;
};

describe('detach refuses, leaving the session running', () => {
  test('a process that is not keeper-held', async () => {
    const io = kept((m, k) => m.type === 'user' && k.emit(result('fine')));
    const { detach: _detach, ...plain } = io.proc;
    const s = session(plain as PipedSubprocess);
    await s.start();
    await expect(s.detach({ orphanDeadlineMs: 60_000 })).rejects.toThrow(/not keeper-held/);
    expect((await s.send('still here')).content).toBe('fine');
  });

  test('a session with an extension', async () => {
    const io = kept();
    const s = session(io.proc, { toolGate: true });
    s.extend({
      agents: {},
      mcpServers: [],
      attach() {},
      started() {},
      mcp() {},
      preToolUse: () => undefined,
      permission: () => undefined,
      frame: () => false,
      detach() {},
    });
    await s.start();
    await expect(s.detach({ orphanDeadlineMs: 60_000 })).rejects.toThrow(/extension/);
    expect(io.proc.detached).toBe(false);
    expect(s.alive).toBe(true);
  });

  test('stdin that will not drain in time', async () => {
    const io = kept((m, k) => m.type === 'user' && k.emit(result('fine')));
    const s = session(io.proc);
    await s.start();
    io.drains = false;
    await expect(s.detach({ orphanDeadlineMs: 60_000, drainMs: 20 })).rejects.toThrow(
      /did not drain/,
    );
    expect(io.proc.detached).toBe(false);
    expect((await s.send('still here')).content).toBe('fine');
  });
});

describe('a detach that fails rolls back', () => {
  const ask = {
    type: 'control_request',
    request_id: 'ask-roll',
    request: {
      subtype: 'can_use_tool',
      tool_name: 'Bash',
      display_name: 'Bash',
      input: { command: 'ls' },
      tool_use_id: 'toolu_roll',
    },
  };

  test('a hold the keeper never confirms leaves the session running and detachable again', async () => {
    const io = kept((m, k) => m.type === 'user' && k.emit(result('fine')));
    const s = session(io.proc);
    await s.start();
    io.failDetach = new Error('Keeper did not confirm the hold');
    await expect(s.detach({ orphanDeadlineMs: 60_000 })).rejects.toThrow(/confirm the hold/);
    expect(s.alive).toBe(true);
    expect((await s.send('still here')).content).toBe('fine');
    io.failDetach = undefined;
    const snapshot = await s.detach({ orphanDeadlineMs: 60_000 });
    expect(snapshot.offset).toBe(7);
  });

  test('an approval decided while a drain was failing is written once the detach gives up', async () => {
    const io = kept((m, k) => {
      if (m.type !== 'user') return;
      running(m, k);
      k.emit(ask);
    });
    const s = session(io.proc, { toolGate: true, permissionMode: 'default' });
    let answer!: () => void;
    s.onToolRequest(
      () =>
        new Promise((resolve) => {
          answer = () => resolve({ behavior: 'allow' });
        }),
    );
    await s.start();
    void s.send('look').catch(() => {});
    await until(() => answer !== undefined);
    io.drainGate = new Promise<void>(() => {});
    const detaching = s.detach({ orphanDeadlineMs: 60_000, drainMs: 60 });
    await Bun.sleep(10);
    answer(); // the person answers while the session is detaching
    await Bun.sleep(10);
    expect(
      io.lines.some((l) => l.type === 'control_response' && l.response?.request_id === 'ask-roll'),
    ).toBe(false);
    await expect(detaching).rejects.toThrow(/did not drain/);
    await until(() =>
      io.lines.some((l) => l.type === 'control_response' && l.response?.request_id === 'ask-roll'),
    );
    expect(
      io.lines.find((l) => l.type === 'control_response' && l.response?.request_id === 'ask-roll')
        ?.response,
    ).toMatchObject({ subtype: 'success', response: { behavior: 'allow' } });
  });
});

describe('detach hands a running turn to a rebuilt session', () => {
  test('a queued send is returned, the turn in flight is detached, then adopted and settled', async () => {
    const io = kept(running);
    const s = session(io.proc);
    await s.start();
    const first = s.send('long task');
    await until(() => io.lines.some((l) => l.type === 'user'));
    const queued = s.send('after it');
    const snapshot = await s.detach({ orphanDeadlineMs: 60_000 });

    expect(await cause(queued)).toBeInstanceOf(SessionReturned);
    expect(await cause(first)).toBeInstanceOf(SessionDetached);
    expect(s.attempts.map((a) => a.localFailure)).toEqual(['detached', 'returned']);
    expect(io.lines.filter((l) => l.type === 'user')).toHaveLength(1);
    expect(s.alive).toBe(false);
    expect(s.events.some((e) => e.kind === 'session_end')).toBe(false);
    await expect(s.send('too late')).rejects.toThrow();

    expect(snapshot).toMatchObject({ snapshotVersion: 1, cliPid: 4242, offset: 7 });
    expect(snapshot.externalSessionId).toBe(SESSION);
    const admissionId = snapshot.inflight?.admissionId;
    expect(admissionId).toBe(s.attempts[0]?.admissionId);

    const next = kept();
    const r = rebuilt(snapshot);
    await expect(r.send('before resume')).rejects.toThrow(/resume\(\) first/);
    r.resume(next.proc);
    expect(next.released).toBe(7);
    expect(r.events.find((e) => e.kind === 'session_start')?.raw).toEqual({ resumed: true });
    next.emit(result('done while away'));
    const settled = await r.adoptedTurn;
    expect(settled?.admissionId).toBe(admissionId);
    expect(settled?.content).toBe('done while away');
    expect(settled?.nativeOutcome).toBe('completed');
  });

  test('the snapshot survives a JSON round trip unchanged', async () => {
    const io = kept(running);
    const s = session(io.proc);
    await s.start();
    void s.send('long task').catch(() => {});
    await until(() => io.lines.some((l) => l.type === 'user'));
    const snapshot = await s.detach({ orphanDeadlineMs: 60_000 });
    expect(JSON.parse(JSON.stringify(snapshot))).toEqual(snapshot);
  });

  test('the snapshot shape matches the golden key sets for its version', async () => {
    // Both records fail the typecheck when a key is added to or removed from the type.
    const top = {
      baseContextDir: true,
      cliPid: true,
      externalSessionId: true,
      hookCallbackId: true,
      inflight: true,
      liveTasks: true,
      offset: true,
      pendingControl: true,
      promptLifecycleSeen: true,
      promptUuids: true,
      seenBoundaries: true,
      seenTerminals: true,
      snapshotVersion: true,
      steerUuids: true,
      totalTokens: true,
      turns: true,
      wake: true,
      wakeCause: true,
    } satisfies Record<keyof ClaudeSessionSnapshot, true>;
    const inflight = {
      admissionId: true,
      content: true,
      held: true,
      identity: true,
      modelMissing: true,
      prompt: true,
      steers: true,
      timeout: true,
      timeoutAt: true,
      tokens: true,
    } satisfies Record<keyof NonNullable<ClaudeSessionSnapshot['inflight']>, true>;
    const golden = (await Bun.file(
      new URL('./fixtures/claude-snapshot.json', import.meta.url),
    ).json()) as { versions: Record<string, { top: string[]; inflight: string[] }> };
    const pinned = golden.versions[String(CLAUDE_SESSION_SNAPSHOT_VERSION)];
    expect(pinned).toBeDefined();
    expect(Object.keys(top).sort()).toEqual(pinned?.top ?? []);
    expect(Object.keys(inflight).sort()).toEqual(pinned?.inflight ?? []);

    // And a real snapshot carries no key outside them.
    const io = kept(running);
    const s = session(io.proc);
    await s.start();
    void s.send('long task').catch(() => {});
    await until(() => io.lines.some((l) => l.type === 'user'));
    const snapshot = await s.detach({ orphanDeadlineMs: 60_000 });
    for (const key of Object.keys(snapshot)) expect(pinned?.top).toContain(key);
    for (const key of Object.keys(snapshot.inflight ?? {})) expect(pinned?.inflight).toContain(key);
  });

  test('the package records the keeper protocol and the snapshot version it attaches', async () => {
    const pkg = (await Bun.file(new URL('../package.json', import.meta.url)).json()) as {
      inixiative?: { keeperProtocol?: number; attachCompat?: number };
    };
    expect(pkg.inixiative?.keeperProtocol).toBe(KEEPER_PROTOCOL);
    expect(pkg.inixiative?.attachCompat).toBe(CLAUDE_SESSION_SNAPSHOT_VERSION);
  });

  test('an unknown snapshot version is refused', () => {
    expect(() =>
      ClaudeCodeSession.fromSnapshot(
        { snapshotVersion: 99 } as unknown as ClaudeSessionSnapshot,
        {},
      ),
    ).toThrow(/version 99 unknown/);
  });
});

describe('approvals across a detach', () => {
  const ask = {
    type: 'control_request',
    request_id: 'ask-1',
    request: {
      subtype: 'can_use_tool',
      tool_name: 'Bash',
      display_name: 'Bash',
      input: { command: 'rm -rf build' },
      tool_use_id: 'toolu_1',
    },
  };

  test('an approval still being decided is withdrawn, then asked again of the new gate', async () => {
    const io = kept((m, k) => {
      if (m.type !== 'user') return;
      running(m, k);
      k.emit(ask);
    });
    const s = session(io.proc, { toolGate: true, permissionMode: 'default' });
    let withdrawn = false;
    s.onToolRequest((request) => {
      request.signal?.addEventListener('abort', () => {
        withdrawn = true;
      });
      return new Promise(() => {}); // the person has not answered yet
    });
    await s.start();
    void s.send('clean up').catch(() => {});
    await until(() => io.lines.some((l) => l.type === 'user'));
    await Bun.sleep(5);
    const snapshot = await s.detach({ orphanDeadlineMs: 60_000 });
    expect(withdrawn).toBe(true);
    expect(snapshot.pendingControl).toEqual([ask]);
    expect(io.lines.some((l) => l.type === 'control_response')).toBe(false);

    const next = kept();
    const r = rebuilt(snapshot, { toolGate: true, permissionMode: 'default' });
    const asked: string[] = [];
    r.onToolRequest((request) => {
      asked.push(request.toolName);
      return { behavior: 'allow' };
    });
    r.resume(next.proc);
    await until(() => next.lines.some((l) => l.type === 'control_response'));
    expect(asked).toEqual(['Bash']);
    expect(next.lines.find((l) => l.type === 'control_response')?.response).toMatchObject({
      subtype: 'success',
      request_id: 'ask-1',
      response: { behavior: 'allow' },
    });
  });

  test('a hook callback the rebuilt session has no gate for is denied, never allowed', async () => {
    const io = kept(running);
    const s = session(io.proc);
    await s.start();
    void s.send('long task').catch(() => {});
    await until(() => io.lines.some((l) => l.type === 'user'));
    const snapshot = await s.detach({ orphanDeadlineMs: 60_000 });

    const next = kept();
    const r = rebuilt(snapshot);
    r.resume(next.proc);
    next.emit({
      type: 'control_request',
      request_id: 'hook-9',
      request: {
        subtype: 'hook_callback',
        callback_id: 'hook_from_before',
        input: { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: {} },
      },
    });
    await until(() => next.lines.some((l) => l.type === 'control_response'));
    const reply = next.lines.find((l) => l.type === 'control_response')?.response;
    expect(reply).toMatchObject({ subtype: 'success', request_id: 'hook-9' });
    expect(reply.response.hookSpecificOutput.permissionDecision).toBe('deny');
  });
});

test('the sweeper keeps a directory whose kept CLI is alive, though its creator is gone', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sweep-kept-'));
  try {
    const owned = join(dir, 'agent-session-base-2147483646-kept');
    const orphan = join(dir, 'agent-session-base-2147483646-gone');
    const deadOwner = join(dir, 'agent-session-base-2147483646-dead');
    for (const path of [owned, orphan, deadOwner]) {
      mkdirSync(path);
      writeFileSync(join(path, 'append-system-prompt.md'), 'CONTEXT');
    }
    writeFileSync(join(owned, 'owner'), String(process.pid));
    writeFileSync(join(deadOwner, 'owner'), '2147483645');
    sweepOrphanedBaseContexts(dir);
    expect([owned, orphan, deadOwner].map((path) => existsSync(path))).toEqual([
      true,
      false,
      false,
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('a resumed turn keeps its deadline', () => {
  test('the timeout counts from the first send, not from resume', async () => {
    const io = kept(running);
    const s = session(io.proc);
    await s.start();
    const sentAt = Date.now();
    void s.send('slow', { timeout: 600 }).catch(() => {});
    await until(() => io.lines.some((l) => l.type === 'user'));
    await Bun.sleep(350);
    const snapshot = await s.detach({ orphanDeadlineMs: 60_000 });
    const at = snapshot.inflight?.timeoutAt ?? 0;
    expect(at).toBeGreaterThanOrEqual(sentAt + 600);
    expect(at).toBeLessThan(sentAt + 700);

    const next = kept();
    const r = rebuilt(snapshot);
    r.resume(next.proc);
    const resumedAt = Date.now();
    const error = await (r.adoptedTurn ?? Promise.resolve()).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(SessionTurnError);
    expect(Date.now() - resumedAt).toBeLessThan(500);
  });

  test('a result spooled while detached settles the turn even past its deadline', async () => {
    const io = kept(running);
    const s = session(io.proc);
    await s.start();
    void s.send('slow', { timeout: 200 }).catch(() => {});
    await until(() => io.lines.some((l) => l.type === 'user'));
    const snapshot = await s.detach({ orphanDeadlineMs: 60_000 });
    await Bun.sleep(300);

    const next = kept();
    let replayDone!: () => void;
    const replay = new Promise<void>((resolve) => {
      replayDone = resolve;
    });
    next.proc.release = () => {
      setTimeout(() => next.emit(result('finished while away')), 20);
      setTimeout(replayDone, 40);
    };
    next.proc.replayed = () => replay;
    const r = rebuilt(snapshot);
    r.resume(next.proc);
    const settled = await r.adoptedTurn;
    expect(settled?.content).toBe('finished while away');
  });

  test('a detach during replay keeps a past-deadline turn instead of timing it out', async () => {
    const io = kept(running);
    const s = session(io.proc);
    await s.start();
    void s.send('slow', { timeout: 200 }).catch(() => {});
    await until(() => io.lines.some((l) => l.type === 'user'));
    const snapshot = await s.detach({ orphanDeadlineMs: 60_000 });
    await Bun.sleep(300);

    const next = kept();
    let replayDone!: () => void;
    next.proc.replayed = () =>
      new Promise<void>((resolve) => {
        replayDone = resolve;
      });
    const detach = next.proc.detach!.bind(next.proc);
    next.proc.detach = async (options) => {
      replayDone();
      await Bun.sleep(20);
      return detach(options);
    };
    const r = rebuilt(snapshot);
    r.resume(next.proc);
    const adopted = r.adoptedTurn?.then(
      () => 'settled',
      (error: Error) => error.message,
    );
    const again = await r.detach({ orphanDeadlineMs: 60_000 });
    expect(again.inflight?.admissionId).toBe(snapshot.inflight?.admissionId);
    expect(await adopted).not.toContain('timed out');
  });
});
