/**
 * The keeper: one small detached process per kept native session. It starts the CLI, owns its
 * pipes, and numbers every stdout line, stderr line and the exit code into one stream, held from
 * the last acked frame. It does no session work: the only frame it reads is a control request's
 * subtype, to count approvals waiting while no daemon is attached. It never answers one.
 *
 * Run as `bun keeper.ts` with a `KeeperLaunch` on stdin (see `client.ts`).
 */
import { timingSafeEqual } from 'node:crypto';
import { chmodSync, statSync, unlinkSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import {
  encodeFrame,
  frameReader,
  KEEPER_PROTOCOL,
  type KeeperFrame,
  type KeeperLaunch,
  type KeeperStreamFrame,
} from './protocol';

/** A heartbeat this recent keeps an unattached keeper waiting past its deadline. */
const BEAT_FRESH_MS = 90_000;
const BEAT_RECHECK_MS = 30_000;
const AUTH_TIMEOUT_MS = 5_000;
const END_STDIN_GRACE_MS = 5_000;
const END_TERM_GRACE_MS = 10_000;
const GATE_SUBTYPES = new Set(['can_use_tool', 'hook_callback']);

type Spooled = KeeperStreamFrame & { readonly bytes: number };

export async function runKeeper(launch: KeeperLaunch): Promise<void> {
  if (launch.protocol !== KEEPER_PROTOCOL)
    throw Error(`Keeper protocol ${launch.protocol} unknown`);
  process.on('SIGHUP', () => {});
  process.on('SIGPIPE', () => {});

  const spool: Spooled[] = [];
  let spooledBytes = 0;
  let nextN = 1;
  let acked = 0;
  let epoch = 0;
  let attached: Socket | null = null;
  let held = true;
  let forwarded = 0;
  let deadlineMs = launch.attachDeadlineMs;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let exitFrame: number | undefined;
  let ending = false;
  let roomWaiters: (() => void)[] = [];
  const pendingGates = new Set<string>();

  const cliStartTime = Date.now();
  const cli = Bun.spawn([...launch.cmd], {
    cwd: launch.cwd,
    env: { ...launch.env },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const log = (message: string) =>
    process.stderr.write(`${new Date().toISOString()} keeper ${process.pid}: ${message}\n`);

  const removeFiles = (paths: readonly string[]) => {
    for (const path of paths)
      try {
        unlinkSync(path);
      } catch {
        /* already gone */
      }
  };
  const shutdown = (why: string) => {
    log(`exiting: ${why}`);
    removeFiles([launch.socketPath, ...(launch.cleanup ?? [])]);
    process.exit(0);
  };

  // --- the numbered stream -------------------------------------------------

  const send = (socket: Socket, frame: KeeperFrame) => socket.write(encodeFrame(frame));

  let pumping = false;
  const pump = async () => {
    if (pumping) return;
    pumping = true;
    try {
      while (attached && !held) {
        const socket = attached;
        const next = spool.find((frame) => frame.n > forwarded);
        if (!next) break;
        forwarded = next.n;
        const { bytes: _bytes, ...frame } = next;
        if (!send(socket, frame))
          await new Promise<void>((resolve) => {
            socket.once('drain', resolve);
            socket.once('close', resolve);
          });
      }
    } finally {
      pumping = false;
    }
  };

  const append = (frame: KeeperStreamFrame) => {
    const bytes = 'data' in frame ? Buffer.byteLength(frame.data) : 0;
    spool.push({ ...frame, bytes });
    spooledBytes += bytes;
    void pump();
  };

  const countGate = (line: string) => {
    if (!line.includes('control_request')) return;
    try {
      const message = JSON.parse(line) as {
        type?: unknown;
        request_id?: unknown;
        request?: { subtype?: unknown };
      };
      if (
        message.type === 'control_request' &&
        typeof message.request_id === 'string' &&
        GATE_SUBTYPES.has(String(message.request?.subtype))
      )
        pendingGates.add(message.request_id);
    } catch {
      /* not a frame */
    }
  };

  const uncountGate = (data: string) => {
    if (!data.includes('control_response')) return;
    for (const line of data.split('\n'))
      try {
        const message = JSON.parse(line) as { response?: { request_id?: unknown } };
        if (typeof message.response?.request_id === 'string')
          pendingGates.delete(message.response.request_id);
      } catch {
        /* partial */
      }
  };

  const room = () =>
    spooledBytes <= launch.spoolMaxBytes
      ? Promise.resolve()
      : new Promise<void>((resolve) => roomWaiters.push(resolve));

  const readLines = async (stream: ReadableStream<Uint8Array>, kind: 'out' | 'err') => {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      while (true) {
        // Backpressure: past the bound the CLI's own writes stall; nothing is dropped.
        await room();
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (kind === 'out') countGate(line);
          append({ t: kind, n: nextN++, data: line });
        }
      }
    } catch (error) {
      log(`${kind} read failed: ${(error as Error).message}`);
    }
    buffer += decoder.decode();
    if (buffer) append({ t: kind, n: nextN++, data: buffer });
  };

  const drained = Promise.all([readLines(cli.stdout, 'out'), readLines(cli.stderr, 'err')]);
  void Promise.all([cli.exited, drained]).then(([code]) => {
    exitFrame = nextN++;
    append({ t: 'exit', n: exitFrame, code: typeof code === 'number' ? code : 1 });
    log(`cli exited ${code}`);
  });

  const acknowledge = (through: number) => {
    if (!Number.isSafeInteger(through) || through <= acked) return;
    acked = Math.min(through, nextN - 1);
    for (let head = spool[0]; head && head.n <= acked; head = spool[0]) {
      spool.shift();
      spooledBytes -= head.bytes;
    }
    if (spooledBytes <= launch.spoolMaxBytes) {
      const waiters = roomWaiters;
      roomWaiters = [];
      for (const wake of waiters) wake();
    }
    if (exitFrame !== undefined && acked >= exitFrame) shutdown('exit acked');
  };

  // --- stdin, in order, each write acked once it reached the CLI's pipe ----

  let writes = Promise.resolve();
  const writeStdin = (socket: Socket, seq: number, data: string) => {
    writes = writes.then(async () => {
      try {
        cli.stdin.write(data);
        await cli.stdin.flush();
        uncountGate(data);
        if (attached === socket) send(socket, { t: 'inAck', seq });
      } catch (error) {
        log(`stdin write failed: ${(error as Error).message}`);
      }
    });
  };

  // --- ending the CLI --------------------------------------------------------

  const endCli = async (why: string) => {
    if (ending) return;
    ending = true;
    log(`ending cli: ${why}`);
    try {
      cli.stdin.end();
    } catch {
      /* closed */
    }
    const exited = cli.exited.then(() => true);
    const within = (ms: number) => Promise.race([exited, Bun.sleep(ms).then(() => false)]);
    if (!(await within(END_STDIN_GRACE_MS))) {
      cli.kill('SIGTERM');
      if (!(await within(END_TERM_GRACE_MS))) cli.kill('SIGKILL');
    }
    await cli.exited;
  };

  // --- the orphan deadline ---------------------------------------------------

  const beatFresh = () => {
    if (!launch.beatPath) return false;
    try {
      return Date.now() - statSync(launch.beatPath).mtimeMs < BEAT_FRESH_MS;
    } catch {
      return false;
    }
  };

  const armDeadline = (ms: number) => {
    if (deadline) clearTimeout(deadline);
    deadline = setTimeout(async () => {
      if (attached) return;
      if (beatFresh()) return armDeadline(BEAT_RECHECK_MS);
      await endCli('no daemon attached before the deadline');
      // An exit frame nobody will ack: the stream has no reader left.
      shutdown('orphan deadline');
    }, ms);
  };

  // --- the socket ------------------------------------------------------------

  const expected = new Bun.CryptoHasher('sha256').update(launch.token).digest();
  const tokenMatches = (token: unknown) =>
    typeof token === 'string' &&
    timingSafeEqual(expected, new Bun.CryptoHasher('sha256').update(token).digest());

  const server = createServer((socket) => {
    let authed = false;
    const authTimer = setTimeout(() => socket.destroy(), AUTH_TIMEOUT_MS);
    socket.on('error', () => socket.destroy());
    socket.on('close', () => {
      clearTimeout(authTimer);
      if (attached !== socket) return;
      attached = null;
      held = true;
      armDeadline(deadlineMs);
    });
    socket.on(
      'data',
      frameReader((frame) => {
        if (!authed) {
          if (frame.t !== 'auth' || !tokenMatches(frame.token)) {
            send(socket, { t: 'refused', reason: 'unauthenticated' });
            return socket.end();
          }
          if (attached) {
            send(socket, { t: 'refused', reason: 'another daemon is attached' });
            return socket.end();
          }
          if (ending) {
            send(socket, { t: 'refused', reason: 'the cli is ending' });
            return socket.end();
          }
          clearTimeout(authTimer);
          authed = true;
          attached = socket;
          held = true;
          epoch += 1;
          if (deadline) clearTimeout(deadline);
          deadlineMs = launch.attachDeadlineMs;
          send(socket, {
            t: 'hello',
            protocol: KEEPER_PROTOCOL,
            keeperPid: process.pid,
            cliPid: cli.pid,
            cliStartTime,
            epoch,
            acked,
            spooled: nextN - 1,
            waiting: pendingGates.size,
          });
          return;
        }
        switch (frame.t) {
          case 'release':
            forwarded = Math.max(acked, Number(frame.after) || 0);
            held = false;
            void pump();
            return;
          case 'hold':
            held = true;
            send(socket, { t: 'held', forwarded });
            return;
          case 'ack':
            return acknowledge(Number(frame.through));
          case 'in':
            if (typeof frame.data === 'string') writeStdin(socket, Number(frame.seq), frame.data);
            return;
          case 'inEnd':
            writes = writes.then(() => {
              try {
                cli.stdin.end();
              } catch {
                /* closed */
              }
            });
            return;
          case 'kill':
            try {
              cli.kill('SIGTERM');
            } catch {
              /* gone */
            }
            return;
          case 'deadline':
            if (Number.isSafeInteger(frame.ms) && Number(frame.ms) > 0)
              deadlineMs = Number(frame.ms);
            return;
        }
      }),
    );
  });

  // The socket is created owner-only: no window between listen and a chmod.
  const umask = process.umask(0o177);
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(launch.socketPath, () => resolve());
    });
  } catch (error) {
    // Nothing can ever attach to this CLI: end it rather than leave it running unowned.
    cli.kill('SIGKILL');
    removeFiles(launch.cleanup ?? []);
    throw error;
  } finally {
    process.umask(umask);
  }
  chmodSync(launch.socketPath, 0o600);
  process.on('SIGTERM', () => void endCli('keeper terminated').then(() => shutdown('SIGTERM')));
  armDeadline(deadlineMs);
  log(`keeping cli ${cli.pid} on ${launch.socketPath}`);
}

if (import.meta.main) {
  const launch = JSON.parse(await Bun.stdin.text()) as KeeperLaunch;
  await runKeeper(launch).catch((error) => {
    process.stderr.write(`keeper failed to start: ${(error as Error).message}\n`);
    process.exit(1);
  });
}
