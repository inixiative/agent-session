/**
 * The daemon's side of a keeper: spawn one (`spawnThroughKeeper`) or reattach to a running one
 * (`attachKeeper`). Either returns a `KeeperSubprocess`, a `PipedSubprocess` whose pipes run over
 * the keeper's socket, so a session drives it exactly as it drives a CLI it spawned itself.
 *
 * Stdout is pull-based: a frame is handed to the session's reader only when it asks for one, and
 * every handed frame is acked (batched). `detach` holds the keeper, closes the streams and returns
 * the last frame handed out; a later attachment resumes the stream after it with `release`.
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, closeSync, mkdirSync, openSync } from 'node:fs';
import { connect, type Socket } from 'node:net';
import { join } from 'node:path';
import {
  encodeFrame,
  frameReader,
  KEEPER_PROTOCOL,
  type KeeperFrame,
  type KeeperLaunch,
  type KeeperRequest,
  type KeeperStreamFrame,
  keeperId,
} from './protocol';

export const KEEPER_DEFAULT_SPOOL_MAX_BYTES = 64 * 1024 * 1024;
export const KEEPER_DEFAULT_ATTACH_DEADLINE_MS = 10 * 60_000;
const CONNECT_RETRY_MS = 5_000;
const HELD_TIMEOUT_MS = 2_000;
const STDIN_ACK_GRACE_MS = 1_000;
const ACK_BATCH_FRAMES = 64;
const ACK_BATCH_MS = 25;

export interface KeeperSpawnOptions {
  /** The keeper's socket, log and registration live under `<configDir>/k/`. */
  readonly configDir: string;
  readonly spoolMaxBytes?: number;
  readonly attachDeadlineMs?: number;
  readonly beatPath?: string;
  /** Files the keeper removes when it exits. */
  readonly cleanup?: readonly string[];
}

/** What a later daemon needs to find and reattach to this keeper. */
export interface KeeperHandle {
  readonly id: string;
  readonly socketPath: string;
  readonly token: string;
  readonly keeperPid: number;
  readonly cliPid: number;
  readonly cliStartTime: number;
  readonly epoch: number;
  /** Approval requests the CLI asked while no daemon was attached, unanswered. */
  readonly waiting: number;
}

export interface KeeperSubprocess {
  readonly stdin: {
    write(data: string): void;
    flush(): void;
    end(): void;
    /** Resolves once every write so far reached the CLI's pipe. */
    drained(): Promise<void>;
  };
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  readonly exited: Promise<number>;
  /** The CLI's pid, known once `ready` resolves. */
  readonly pid: number | undefined;
  /** Connected, authenticated and (when spawned) released. A rejection is a failed spawn. */
  readonly ready: Promise<void>;
  /** Known once `ready` resolves. */
  readonly keeper: KeeperHandle | undefined;
  /** True once `detach` began: the streams end without the CLI having exited. */
  readonly detached: boolean;
  kill(): void;
  /**
   * Hold the keeper, end the streams, ack what was handed out and leave the CLI running under the
   * keeper for `orphanDeadlineMs` with no daemon attached. Returns the last frame handed out.
   */
  detach(options: { readonly orphanDeadlineMs: number }): Promise<{ readonly offset: number }>;
  /** Forward frames numbered above `after`, then live. Every attachment starts held. */
  release(after: number): void;
}

/** Start the CLI under a new detached keeper. Returns at once; `ready` settles the start. */
export function spawnThroughKeeper(
  cmd: readonly string[],
  // The shape a session's `spawn` hook receives; unset variables are left out.
  spawnOptions: {
    readonly cwd?: string;
    readonly env: Readonly<Record<string, string | undefined>>;
  },
  options: KeeperSpawnOptions,
): KeeperSubprocess {
  const dir = join(options.configDir, 'k');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // An existing directory keeps its mode; the keepers' sockets and logs are owner-only.
  chmodSync(dir, 0o700);
  const id = keeperId(randomBytes(16).toString('hex'));
  const socketPath = join(dir, `${id}.sock`);
  const logPath = join(dir, `${id}.log`);
  const token = randomBytes(32).toString('hex');
  const launch: KeeperLaunch = {
    protocol: KEEPER_PROTOCOL,
    token,
    socketPath,
    cmd,
    ...(spawnOptions.cwd ? { cwd: spawnOptions.cwd } : {}),
    env: Object.fromEntries(
      Object.entries(spawnOptions.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    ),
    spoolMaxBytes: options.spoolMaxBytes ?? KEEPER_DEFAULT_SPOOL_MAX_BYTES,
    attachDeadlineMs: options.attachDeadlineMs ?? KEEPER_DEFAULT_ATTACH_DEADLINE_MS,
    ...(options.beatPath ? { beatPath: options.beatPath } : {}),
    cleanup: [logPath, ...(options.cleanup ?? [])],
  };

  const logFd = openSync(logPath, 'a', 0o600);
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(process.execPath, [new URL('./keeper.ts', import.meta.url).pathname], {
      detached: true,
      stdio: ['pipe', logFd, logFd],
    });
  } finally {
    closeSync(logFd);
  }
  // The token reaches the keeper on its stdin only, never argv or the environment.
  child.stdin?.end(JSON.stringify(launch));
  const spawnError = new Promise<never>((_, reject) =>
    child.once('error', (error) => reject(error)),
  );
  const keeperExit = new Promise<never>((_, reject) =>
    child.once('exit', (code) =>
      reject(new Error(`Keeper exited (${code}) before it listened; see ${logPath}`)),
    ),
  );
  child.unref();

  return keeperSubprocess(
    Promise.race([connectWithRetry(socketPath, CONNECT_RETRY_MS), spawnError, keeperExit]),
    { id, socketPath, token, releaseOnHello: 0 },
  );
}

/** Reattach to a running keeper. The returned process is held: `release(offset)` resumes it. */
export async function attachKeeper(target: {
  readonly socketPath: string;
  readonly token: string;
}): Promise<KeeperSubprocess> {
  const id =
    target.socketPath
      .split('/')
      .pop()
      ?.replace(/\.sock$/, '') ?? '';
  const proc = keeperSubprocess(connectOnce(target.socketPath), {
    id,
    socketPath: target.socketPath,
    token: target.token,
  });
  await proc.ready;
  return proc;
}

function connectOnce(socketPath: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    socket.once('connect', () => {
      socket.off('error', reject);
      resolve(socket);
    });
    socket.once('error', reject);
  });
}

async function connectWithRetry(socketPath: string, withinMs: number): Promise<Socket> {
  const until = Date.now() + withinMs;
  for (;;) {
    try {
      return await connectOnce(socketPath);
    } catch (error) {
      if (Date.now() >= until) throw error;
      await Bun.sleep(50);
    }
  }
}

function keeperSubprocess(
  connecting: Promise<Socket>,
  target: {
    readonly id: string;
    readonly socketPath: string;
    readonly token: string;
    readonly releaseOnHello?: number;
  },
): KeeperSubprocess {
  const encoder = new TextEncoder();
  let socket: Socket | null = null;
  let handle: KeeperHandle | undefined;
  let detached = false;
  let closed = false;
  /** Requests written before the socket connected. */
  let outbox: KeeperRequest[] = [];

  const request = (frame: KeeperRequest) => {
    if (closed) return;
    if (socket) socket.write(encodeFrame(frame));
    else outbox.push(frame);
  };

  // --- the numbered stream ---------------------------------------------------

  const queue: KeeperStreamFrame[] = [];
  let handedOut = 0;
  let ackedThrough = 0;
  let wakeReader: (() => void) | null = null;
  let ackTimer: ReturnType<typeof setTimeout> | undefined;
  let resolveExited!: (code: number) => void;
  const exited = new Promise<number>((resolve) => {
    resolveExited = resolve;
  });
  let stderrController!: ReadableStreamDefaultController<Uint8Array>;
  let stdoutController: ReadableStreamDefaultController<Uint8Array> | undefined;

  const flushAck = () => {
    if (ackTimer) clearTimeout(ackTimer);
    ackTimer = undefined;
    if (handedOut > ackedThrough) {
      ackedThrough = handedOut;
      request({ t: 'ack', through: handedOut });
    }
  };
  const scheduleAck = () => {
    if (handedOut - ackedThrough >= ACK_BATCH_FRAMES) return flushAck();
    ackTimer ??= setTimeout(flushAck, ACK_BATCH_MS);
  };

  const endStreams = () => {
    try {
      stdoutController?.close();
    } catch {
      /* closed */
    }
    try {
      stderrController.close();
    } catch {
      /* closed */
    }
  };

  /** Hand out every frame up to and including the next stdout line; false when none is queued. */
  const handOut = (controller: ReadableStreamDefaultController<Uint8Array>): boolean => {
    while (queue.length) {
      const frame = queue.shift() as KeeperStreamFrame;
      handedOut = frame.n;
      scheduleAck();
      if (frame.t === 'err') {
        try {
          stderrController.enqueue(encoder.encode(`${frame.data}\n`));
        } catch {
          /* stderr closed */
        }
        continue;
      }
      if (frame.t === 'exit') {
        flushAck();
        endStreams();
        resolveExited(frame.code);
        return true;
      }
      controller.enqueue(encoder.encode(`${frame.data}\n`));
      return true;
    }
    return false;
  };

  const stdout = new ReadableStream<Uint8Array>(
    {
      start(controller) {
        stdoutController = controller;
      },
      async pull(controller) {
        while (!detached && !closed && !handOut(controller))
          await new Promise<void>((resolve) => {
            wakeReader = resolve;
          });
      },
    },
    { highWaterMark: 0 },
  );
  const stderr = new ReadableStream<Uint8Array>({
    start(controller) {
      stderrController = controller;
    },
  });
  const wake = () => {
    const resolve = wakeReader;
    wakeReader = null;
    resolve?.();
  };

  // --- stdin ------------------------------------------------------------------

  let sentSeq = 0;
  let ackedSeq = 0;
  let drainWaiters: (() => void)[] = [];
  const onInAck = (seq: number) => {
    ackedSeq = Math.max(ackedSeq, seq);
    if (ackedSeq < sentSeq) return;
    const waiters = drainWaiters;
    drainWaiters = [];
    for (const resolve of waiters) resolve();
  };
  const drained = () =>
    ackedSeq >= sentSeq
      ? Promise.resolve()
      : new Promise<void>((resolve) => drainWaiters.push(resolve));

  // --- the connection ---------------------------------------------------------

  let heldWaiter: ((forwarded: number) => void) | null = null;

  const ready = (async () => {
    const connected = await connecting;
    const hello = await new Promise<Extract<KeeperFrame, { t: 'hello' }>>((resolve, reject) => {
      connected.on(
        'data',
        frameReader((raw) => {
          const frame = raw as KeeperFrame;
          switch (frame.t) {
            case 'hello':
              return resolve(frame);
            case 'refused':
              return reject(new Error(`Keeper refused the connection: ${frame.reason}`));
            case 'out':
            case 'err':
            case 'exit':
              if (frame.n <= handedOut) return;
              queue.push(frame);
              return wake();
            case 'inAck':
              return onInAck(frame.seq);
            case 'held': {
              const waiter = heldWaiter;
              heldWaiter = null;
              return waiter?.(frame.forwarded);
            }
          }
        }),
      );
      connected.once('close', () => reject(new Error('Keeper closed the connection')));
      connected.write(encodeFrame({ t: 'auth', token: target.token }));
    });
    if (hello.protocol !== KEEPER_PROTOCOL) {
      connected.destroy();
      throw new Error(`Keeper speaks protocol ${hello.protocol}, not ${KEEPER_PROTOCOL}`);
    }
    connected.on('close', () => {
      closed = true;
      wake();
      if (detached) return;
      // The keeper went away without an exit frame: the CLI under it is lost to this daemon.
      try {
        stderrController.enqueue(encoder.encode('agent-session: keeper connection lost\n'));
      } catch {
        /* closed */
      }
      endStreams();
      resolveExited(1);
    });
    socket = connected;
    for (const frame of outbox) connected.write(encodeFrame(frame));
    outbox = [];
    handedOut = hello.acked;
    ackedThrough = hello.acked;
    handle = {
      id: target.id,
      socketPath: target.socketPath,
      token: target.token,
      keeperPid: hello.keeperPid,
      cliPid: hello.cliPid,
      cliStartTime: hello.cliStartTime,
      epoch: hello.epoch,
      waiting: hello.waiting,
    };
    if (target.releaseOnHello !== undefined)
      request({ t: 'release', after: target.releaseOnHello });
  })();
  // A failed start surfaces through `ready`; the streams end so a reader never hangs on it.
  ready.catch(() => {
    closed = true;
    endStreams();
    resolveExited(1);
    wake();
  });

  const release = (after: number) => {
    handedOut = Math.max(handedOut, after);
    ackedThrough = Math.max(ackedThrough, after);
    queue.length = 0;
    request({ t: 'release', after });
  };

  return {
    stdin: {
      write(data: string) {
        sentSeq += 1;
        request({ t: 'in', seq: sentSeq, data });
      },
      flush() {},
      end() {
        request({ t: 'inEnd' });
      },
      drained,
    },
    stdout,
    stderr,
    exited,
    get pid() {
      return handle?.cliPid;
    },
    ready,
    get keeper() {
      return handle;
    },
    get detached() {
      return detached;
    },
    kill() {
      request({ t: 'kill' });
    },
    async detach({ orphanDeadlineMs }) {
      await ready;
      if (closed) throw new Error('Keeper connection already closed');
      request({ t: 'hold' });
      const held = new Promise<number>((resolve) => {
        heldWaiter = resolve;
      });
      const answered = await Promise.race([
        held.then(() => true),
        Bun.sleep(HELD_TIMEOUT_MS).then(() => false),
      ]);
      if (!answered) {
        // The hold may still land: release it from what was handed out, so the stream resumes
        // either way (the keeper re-sends past `handedOut`, and nothing at or below it is kept).
        heldWaiter = null;
        release(handedOut);
        throw new Error('Keeper did not confirm the hold');
      }
      detached = true;
      endStreams();
      wake();
      await Promise.race([drained(), Bun.sleep(STDIN_ACK_GRACE_MS)]);
      flushAck();
      const offset = handedOut;
      request({ t: 'deadline', ms: orphanDeadlineMs });
      const live = socket;
      await new Promise<void>((resolve) => {
        if (!live || closed) return resolve();
        live.once('close', () => resolve());
        live.end();
      });
      return { offset };
    },
    release,
  };
}
