// A scripted Muse Session Protocol host behind the SDK's own Connection. Requests from the client
// are answered by per-method handlers; notifications are pushed as the real host frames them.
import { Connection, type DuplexTransport } from '@muse-code/sdk';
import type { MuseConnect, MuseInitializeResult, MuseLaunch } from '../../src';

export type Params = Record<string, unknown>;
export interface Frame {
  jsonrpc: '2.0';
  id?: number | string;
  method?: string;
  params?: Params;
  result?: unknown;
  error?: unknown;
}
/** Thrown by a handler to answer with an MSP error. */
export class FakeMspError {
  constructor(
    readonly code: number,
    readonly kind: string,
    readonly message: string,
  ) {}
}
export type Handler = (params: Params) => unknown | Promise<unknown>;

export const SESSION_ID = '01a199f8-0d1d-75d1-8393-5758fcc647cf';
export const TURN_ID = '01a199f8-1089-7000-bd67-6245cffc78e8';

export const INITIALIZE: MuseInitializeResult = {
  serverInfo: { name: 'muse', version: '1.4.14' },
  userAgent: 'muse-build/1.4.14 (serve; macos-aarch64)',
  museHome: '/home/user/.local/share/muse',
  platformFamily: 'unix',
  platformOs: 'macos',
  schema: { version: 1, fingerprint: 'sha256:fake' },
  grantedCapabilities: [],
  experimentalApi: true,
  sessionDurability: 'durable',
} as MuseInitializeResult;

class Lines implements AsyncIterable<string> {
  private _queue: string[] = [];
  private _wake?: () => void;
  private _done = false;
  push(line: string) {
    this._queue.push(line);
    this._wake?.();
  }
  end() {
    this._done = true;
    this._wake?.();
  }
  async *[Symbol.asyncIterator]() {
    while (true) {
      while (this._queue.length) yield this._queue.shift() as string;
      if (this._done) return;
      await new Promise<void>((resolve) => {
        this._wake = resolve;
      });
      this._wake = undefined;
    }
  }
}

export interface FakeMuse {
  readonly connect: MuseConnect;
  readonly launches: MuseLaunch[];
  /** Client → host requests, in order. */
  readonly requests: Frame[];
  readonly handlers: Record<string, Handler>;
  /** The session's committed permission profile and approval mode, as session/read reports them. */
  readonly state: { profile?: string; mode?: string; sessionId: string };
  notify(method: string, params: Params): void;
  /** Write one frame exactly as given (a recorded one). */
  send(frame: Frame): void;
  /** Frames with a session-scoped cursor and source range, as the host writes them. */
  frame(method: string, params: Params): Frame;
  waitFor(method: string, predicate?: (params: Params) => boolean): Promise<Params>;
  exit(): void;
  readonly closed: boolean;
}

export function fakeMuse(
  opts: { initialize?: MuseInitializeResult; sessionId?: string; turnId?: string } = {},
): FakeMuse {
  const lines = new Lines();
  const requests: Frame[] = [];
  const launches: MuseLaunch[] = [];
  const waiters: Array<{
    method: string;
    predicate?: (p: Params) => boolean;
    resolve: (p: Params) => void;
  }> = [];
  let exited!: () => void;
  const exitedPromise = new Promise<void>((resolve) => {
    exited = resolve;
  });
  let closed = false;
  let seq = 0;
  const state: FakeMuse['state'] = { sessionId: opts.sessionId ?? SESSION_ID };
  const turnId = opts.turnId ?? TURN_ID;
  const write = (frame: Frame) => {
    if (!closed) lines.push(`${JSON.stringify(frame)}\n`);
  };
  const frame = (method: string, params: Params): Frame => {
    seq++;
    return {
      jsonrpc: '2.0',
      method,
      params: {
        sessionId: state.sessionId,
        viewCursor: `v4:${state.sessionId}:${seq}`,
        sourceRange: {
          stream: { kind: 'session', id: state.sessionId },
          first: { id: `rec-${seq}`, sequence: seq },
          last: { id: `rec-${seq}`, sequence: seq },
        },
        ...params,
      },
    };
  };
  const session = (extra: Params = {}) => ({
    sessionId: state.sessionId,
    path: `/home/user/.local/share/muse/sessions/${state.sessionId}/session.jsonl`,
    status: 'idle',
    activeTurnId: null,
    createdAt: '2026-11-02T01:55:32Z',
    updatedAt: '2026-11-02T01:55:32Z',
    workspaceRoot: '/workspace',
    providerId: 'meta',
    modelId: 'muse-wonder-1.0',
    turnCount: 0,
    forkedFrom: null,
    sideFrom: null,
    kind: 'root',
    ...extra,
  });
  const committed = () => ({
    ...(state.profile
      ? { permissionState: { profileId: state.profile, reviewerAuthority: 'human' } }
      : {}),
    ...(state.mode ? { approvalMode: { mode: state.mode, source: 'startup' } } : {}),
  });
  const handlers: Record<string, Handler> = {
    'session/start': (p) => {
      state.profile = p.permissionProfile as string;
      state.mode = p.approvalMode as string;
      return { session: session(committed()), viewCursor: `v4:${state.sessionId}:0` };
    },
    'session/resume': (p) => {
      state.sessionId = p.sessionId as string;
      state.profile = p.permissionProfile as string;
      return {
        session: session(),
        viewCursor: `v4:${state.sessionId}:0`,
        history: { mode: 'none', items: null, snapshot: null, noneReason: 'excluded' },
        pendingRequests: [],
      };
    },
    'session/setApprovalMode': (p) => {
      state.mode = p.mode as string;
      return {
        commandId: p.commandId,
        status: 'accepted',
        applyOutcome: 'completed',
        effectiveMode: { mode: p.mode },
      };
    },
    'session/read': () => ({
      session: session(committed()),
      viewCursor: `v4:${state.sessionId}:0`,
    }),
    'turn/start': (p) => ({
      commandId: p.commandId,
      disposition: 'started',
      startedNewTurn: true,
      status: 'accepted',
      turnId,
    }),
    'approval/decide': (p) => ({
      approvalId: p.approvalId,
      commandId: p.commandId,
      status: 'accepted',
      terminal: true,
    }),
    'userInput/answer': (p) => ({
      commandId: p.commandId,
      status: 'accepted',
      userInputId: p.userInputId,
    }),
    'userInput/cancel': (p) => ({
      commandId: p.commandId,
      status: 'accepted',
      userInputId: p.userInputId,
    }),
    'turn/interrupt': (p) => ({ commandId: p.commandId, status: 'accepted', turnId: p.turnId }),
    'turn/steer': (p) => ({ commandId: p.commandId, status: 'accepted', turnId: p.expectedTurnId }),
    'usage/read': () => ({}),
  };
  const transport: DuplexTransport = {
    incoming: lines,
    async write(chunk: string) {
      for (const line of chunk.split('\n')) {
        if (!line.trim()) continue;
        const request = JSON.parse(line) as Frame;
        if (request.method === undefined) continue; // a response to a host request
        requests.push(request);
        const params = request.params ?? {};
        for (const waiter of waiters.splice(0))
          if (waiter.method === request.method && (!waiter.predicate || waiter.predicate(params)))
            waiter.resolve(params);
          else waiters.push(waiter);
        if (request.id === undefined) continue;
        const handler = handlers[request.method];
        void Promise.resolve()
          .then(() => {
            if (!handler) throw new FakeMspError(-32601, 'methodNotFound', `no ${request.method}`);
            return handler(params);
          })
          .then(
            (result) => write({ jsonrpc: '2.0', id: request.id, result }),
            (error) =>
              write({
                jsonrpc: '2.0',
                id: request.id,
                error:
                  error instanceof FakeMspError
                    ? { code: error.code, message: error.message, data: { kind: error.kind } }
                    : { code: -32603, message: String(error), data: { kind: 'internal' } },
              }),
          );
      }
    },
    close() {
      fake.exit();
    },
  };
  const fake: FakeMuse = {
    launches,
    requests,
    handlers,
    state,
    frame,
    get closed() {
      return closed;
    },
    connect: async (launch) => {
      launches.push(launch);
      return {
        connection: new Connection(transport),
        initializeResult: opts.initialize ?? INITIALIZE,
        exited: exitedPromise,
        stderrTail: () => ['fake host stderr'],
        close: async () => fake.exit(),
      };
    },
    notify(method, params) {
      write(frame(method, params));
    },
    send(recorded) {
      write(recorded);
    },
    waitFor(method, predicate) {
      const seen = requests.find(
        (r) => r.method === method && (!predicate || predicate(r.params ?? {})),
      );
      if (seen) return Promise.resolve(seen.params ?? {});
      return new Promise((resolve) => waiters.push({ method, predicate, resolve }));
    },
    exit() {
      if (closed) return;
      closed = true;
      lines.end();
      exited();
    },
  };
  return fake;
}
