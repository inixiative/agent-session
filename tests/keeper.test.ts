import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { attachKeeper, type KeeperSubprocess, spawnThroughKeeper } from '../src/keeper/client';
import {
  encodeFrame,
  frameReader,
  KEEPER_PROTOCOL,
  type KeeperFrame,
  type KeeperRequest,
} from '../src/keeper/protocol';

const FAKE_CLI = new URL('./fixtures/fake-keeper-cli.ts', import.meta.url).pathname;
const dirs: string[] = [];
const live: KeeperSubprocess[] = [];
/** Readers the tests took, released at cleanup so the exit frame can still be pulled and acked. */
const readers: { releaseLock(): void }[] = [];

afterEach(async () => {
  for (const reader of readers.splice(0)) reader.releaseLock();
  for (const proc of live.splice(0)) {
    if (proc.detached) continue;
    proc.kill();
    void drain(proc.stdout);
    await Promise.race([proc.exited, Bun.sleep(3_000)]);
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function configDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'kp-'));
  dirs.push(dir);
  return dir;
}

function start(options: Partial<Parameters<typeof spawnThroughKeeper>[2]> = {}) {
  const proc = spawnThroughKeeper(
    [process.execPath, FAKE_CLI],
    { env: { PATH: process.env.PATH ?? '' } },
    { configDir: options.configDir ?? configDir(), ...options },
  );
  live.push(proc);
  return proc;
}

function lineReader(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  readers.push(reader);
  const decoder = new TextDecoder();
  let buffer = '';
  return {
    async next(withinMs = 5_000): Promise<string | null> {
      const until = Date.now() + withinMs;
      while (!buffer.includes('\n')) {
        const read = await Promise.race([
          reader.read(),
          Bun.sleep(Math.max(0, until - Date.now())).then(() => 'timeout' as const),
        ]);
        if (read === 'timeout') throw new Error(`no line within ${withinMs} ms`);
        if (read.done) return null;
        buffer += decoder.decode(read.value, { stream: true });
      }
      const index = buffer.indexOf('\n');
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      return line;
    },
  };
}

async function drain(stream: ReadableStream<Uint8Array>) {
  try {
    for await (const _ of stream) {
      /* discard */
    }
  } catch {
    /* locked or closed */
  }
}

async function until(check: () => boolean, withinMs = 5_000) {
  const end = Date.now() + withinMs;
  while (!check()) {
    if (Date.now() > end) throw new Error('condition not met in time');
    await Bun.sleep(25);
  }
}

test('a kept CLI echoes through the keeper, with its pid and acked stdin', async () => {
  const proc = start();
  await proc.ready;
  expect(proc.pid).toBeGreaterThan(0);
  expect(proc.keeper?.epoch).toBe(1);
  const out = lineReader(proc.stdout);
  proc.stdin.write('echo:hello\n');
  await proc.stdin.drained();
  expect(await out.next()).toBe('hello');
});

test('stderr lines arrive on stderr, in order with stdout', async () => {
  const proc = start();
  await proc.ready;
  const out = lineReader(proc.stdout);
  const err = lineReader(proc.stderr);
  proc.stdin.write('err:warned\necho:after\n');
  expect(await out.next()).toBe('after');
  expect(await err.next()).toBe('warned');
});

test('the exit code arrives once, and the keeper removes its socket after the ack', async () => {
  const proc = start();
  await proc.ready;
  const socketPath = proc.keeper?.socketPath ?? '';
  expect(existsSync(socketPath)).toBe(true);
  void drain(proc.stdout);
  proc.stdin.write('exit:7\n');
  expect(await proc.exited).toBe(7);
  await until(() => !existsSync(socketPath));
});

test('a wrong token and a second daemon are both refused', async () => {
  const proc = start();
  await proc.ready;
  const socketPath = proc.keeper?.socketPath ?? '';
  const ask = (token: string) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      const socket = connect(socketPath);
      socket.on(
        'data',
        frameReader((frame) => resolve(frame)),
      );
      socket.on('error', reject);
      socket.write(encodeFrame({ t: 'auth', token }));
    });
  expect(await ask('not-the-token')).toEqual({ t: 'refused', reason: 'unauthenticated' });
  expect(await ask(proc.keeper?.token ?? '')).toEqual({
    t: 'refused',
    reason: 'another daemon is attached',
  });
});

test('output written while detached is held and resumes after the offset', async () => {
  const proc = start();
  await proc.ready;
  const out = lineReader(proc.stdout);
  proc.stdin.write('echo:before\n');
  expect(await out.next()).toBe('before');
  proc.stdin.write('later:300:while-away\n');
  const handle = proc.keeper;
  const { offset } = await proc.detach({ orphanDeadlineMs: 60_000 });
  expect(proc.detached).toBe(true);
  expect(await out.next()).toBeNull();
  await Bun.sleep(500);

  const again = await attachKeeper({
    socketPath: handle?.socketPath ?? '',
    token: handle?.token ?? '',
  });
  live.push(again);
  expect(again.keeper?.epoch).toBe(2);
  expect(again.pid).toBe(proc.pid as number);
  again.release(offset);
  const resumed = lineReader(again.stdout);
  expect(await resumed.next()).toBe('while-away');
  again.stdin.write('echo:still-here\n');
  expect(await resumed.next()).toBe('still-here');
});

test('frames forwarded but never handed out are sent again after reattach', async () => {
  const proc = start();
  await proc.ready;
  proc.stdin.write('echo:one\necho:two\necho:three\n');
  await proc.stdin.drained();
  await Bun.sleep(200);
  // Nothing was read: all three reached the client but none was handed out, so none is acked.
  const handle = proc.keeper;
  const { offset } = await proc.detach({ orphanDeadlineMs: 60_000 });
  expect(offset).toBe(0);
  const again = await attachKeeper({
    socketPath: handle?.socketPath ?? '',
    token: handle?.token ?? '',
  });
  live.push(again);
  again.release(offset);
  const out = lineReader(again.stdout);
  expect([await out.next(), await out.next(), await out.next()]).toEqual(['one', 'two', 'three']);
});

test('an approval asked while detached is counted as waiting, never answered', async () => {
  const proc = start();
  await proc.ready;
  proc.stdin.write(
    'later:200:{"type":"control_request","request_id":"r1","request":{"subtype":"can_use_tool"}}\n',
  );
  const handle = proc.keeper;
  const { offset } = await proc.detach({ orphanDeadlineMs: 60_000 });
  await Bun.sleep(400);
  const again = await attachKeeper({
    socketPath: handle?.socketPath ?? '',
    token: handle?.token ?? '',
  });
  live.push(again);
  expect(again.keeper?.waiting).toBe(1);
  again.release(offset);
  const out = lineReader(again.stdout);
  expect(JSON.parse((await out.next()) ?? '{}').request_id).toBe('r1');
  again.stdin.write(
    `${JSON.stringify({ type: 'control_response', response: { request_id: 'r1' } })}\n`,
  );
  await again.stdin.drained();
});

test('backpressure holds a flood past the spool bound without dropping a line', async () => {
  const proc = start({ spoolMaxBytes: 1_024 });
  await proc.ready;
  const out = lineReader(proc.stdout);
  proc.stdin.write('flood:2000\n');
  for (let i = 1; i <= 2000; i++) expect((await out.next())?.startsWith(`line ${i} `)).toBe(true);
});

test('an unattached keeper past its deadline ends the CLI and removes itself', async () => {
  const proc = start();
  await proc.ready;
  const socketPath = proc.keeper?.socketPath ?? '';
  await proc.detach({ orphanDeadlineMs: 200 });
  await until(() => !existsSync(socketPath), 8_000);
});

test('a fresh heartbeat keeps an unattached keeper waiting past its deadline', async () => {
  const dir = configDir();
  const beatPath = join(dir, '.beat');
  writeFileSync(beatPath, '');
  utimesSync(beatPath, new Date(), new Date());
  const proc = start({ configDir: dir, beatPath });
  await proc.ready;
  const handle = proc.keeper;
  await proc.detach({ orphanDeadlineMs: 200 });
  await Bun.sleep(600);
  expect(existsSync(handle?.socketPath ?? '')).toBe(true);
  const again = await attachKeeper({
    socketPath: handle?.socketPath ?? '',
    token: handle?.token ?? '',
  });
  live.push(again);
  again.release(0);
});

test('a keeper that cannot start fails ready instead of hanging', async () => {
  const proc = spawnThroughKeeper(
    ['/definitely/not/a/cli'],
    { env: {} },
    { configDir: configDir() },
  );
  // The keeper's own Bun.spawn throws, so it exits before it listens.
  await expect(proc.ready).rejects.toThrow();
  expect(await proc.exited).toBe(1);
});

test('the framing matches the golden fixture for this protocol number', async () => {
  const golden = (await Bun.file(
    new URL('./fixtures/keeper-framing.json', import.meta.url),
  ).json()) as { protocol: number; requests: string[]; frames: string[] };
  expect(KEEPER_PROTOCOL).toBe(golden.protocol);
  const requests: KeeperRequest[] = [
    { t: 'auth', token: 'tok' },
    { t: 'release', after: 3 },
    { t: 'hold' },
    { t: 'ack', through: 4 },
    { t: 'in', seq: 1, data: 'x\n' },
    { t: 'inEnd' },
    { t: 'kill' },
    { t: 'deadline', ms: 600_000 },
  ];
  const frames: KeeperFrame[] = [
    {
      t: 'hello',
      protocol: 1,
      keeperPid: 10,
      cliPid: 11,
      cliStartTime: 12,
      epoch: 1,
      acked: 0,
      waiting: 0,
    },
    { t: 'out', n: 1, data: 'line' },
    { t: 'err', n: 2, data: 'warn' },
    { t: 'exit', n: 3, code: 0 },
    { t: 'inAck', seq: 1 },
    { t: 'held', forwarded: 2 },
    { t: 'refused', reason: 'unauthenticated' },
  ];
  expect(requests.map(encodeFrame)).toEqual(golden.requests);
  expect(frames.map(encodeFrame)).toEqual(golden.frames);
  const parsed: Record<string, unknown>[] = [];
  const read = frameReader((frame) => parsed.push(frame));
  const joined = golden.frames.join('');
  read(joined.slice(0, 17));
  read(joined.slice(17));
  expect(parsed).toEqual(frames as unknown as Record<string, unknown>[]);
});
