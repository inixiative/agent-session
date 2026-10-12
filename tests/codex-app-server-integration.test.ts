import { afterEach, expect, test } from 'bun:test';
import { CodexAppServerSession, type CodexSessionConfig } from '../src';

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn();
});
const tick = () => Bun.sleep(0);
export function appFixture(
  options: {
    binding?: string;
    response?: Record<string, unknown>;
    inventory?: unknown;
    inventoryPages?: readonly unknown[];
    holdInventory?: boolean;
    initialize?: unknown;
  } = {},
) {
  let out!: ReadableStreamDefaultController<Uint8Array>,
    exit!: (n: number) => void,
    closed = false;
  let inventoryPage = 0;
  const requests: any[] = [];
  const emit = (v: unknown) => {
    if (!closed) out.enqueue(new TextEncoder().encode(`${JSON.stringify(v)}\n`));
  };
  const threadId = options.binding ?? 'native-thread';
  const response = {
    thread: { id: threadId, status: { type: 'idle' }, turns: [], sessionId: 'native-tree' },
    model: 'observed',
    modelProvider: 'openai',
    cwd: '/controlled',
    approvalPolicy: 'never',
    approvalsReviewer: 'user',
    sandbox: { type: 'dangerFullAccess' },
    reasoningEffort: 'xhigh',
    ...options.response,
  };
  const inventory = Object.hasOwn(options, 'inventory')
    ? options.inventory
    : {
        data: [
          {
            name: 'owned',
            runtimeStatus: 'connected',
            tools: { foundry_memory: { name: 'foundry_memory', inputSchema: { type: 'object' } } },
            resources: [],
            resourceTemplates: [],
            authStatus: 'unsupported',
          },
        ],
        nextCursor: null,
      };
  const proc = {
    stdout: new ReadableStream<Uint8Array>({
      start(c) {
        out = c;
      },
    }),
    stderr: new ReadableStream<Uint8Array>({
      start(c) {
        c.close();
      },
    }),
    exited: new Promise<number>((r) => (exit = r)),
    kill() {
      if (!closed) {
        closed = true;
        out.close();
        exit(0);
      }
    },
    stdin: {
      write(line: string) {
        const v = JSON.parse(line);
        requests.push(v);
        if (v.method === 'initialize')
          queueMicrotask(() =>
            emit({
              id: v.id,
              result: Object.hasOwn(options, 'initialize')
                ? options.initialize
                : {
                    userAgent: 'controlled',
                    platformFamily: 'unix',
                    platformOs: 'macos',
                    codexHome: '/controlled-native-home',
                  },
            }),
          );
        if (['thread/start', 'thread/resume'].includes(v.method))
          queueMicrotask(() => emit({ id: v.id, result: response }));
        if (v.method === 'mcpServerStatus/list' && !options.holdInventory) {
          const pages = options.inventoryPages;
          const result = pages ? pages[Math.min(inventoryPage++, pages.length - 1)] : inventory;
          queueMicrotask(() => emit({ id: v.id, result }));
        }
      },
      flush() {},
      end() {},
    },
  };
  const session = new CodexAppServerSession({
    cwd: '/controlled',
    externalSessionId: options.binding,
    effort: 'xhigh',
    timeout: 100,
    appServer: {
      requireConfiguration: true,
      config: {
        'mcp_servers.owned': { command: 'bun', args: ['controlled-proxy'] },
        'mcp_servers.other': { command: 'other' },
      },
      requiredMcpServer: { name: 'owned', tools: ['foundry_memory'] },
    },
    spawn: () => proc,
  } as CodexSessionConfig);
  cleanup.push(() => session.kill());
  const send = () => {
    const p = session.send('sentinel');
    void p.catch(() => {});
    return p;
  };
  const notify = (method: string, params: Record<string, unknown>) =>
    emit({ method, params: { threadId, turnId: 'turn-1', ...params } });
  const finish = () => {
    const r = requests.filter((v) => v.method === 'turn/start').at(-1);
    emit({ id: r.id, result: { turn: { id: 'turn-1', status: 'inProgress', items: [] } } });
    notify('turn/completed', { turn: { id: 'turn-1', status: 'completed', items: [] } });
  };
  return { session, requests, emit, notify, finish, send, threadId };
}

// Review pagination controls now live beside the production-class fixture.
// These are controlled responses, not additional captured native evidence.
const ownedInventory = {
  name: 'owned',
  runtimeStatus: 'connected',
  tools: { foundry_memory: { name: 'foundry_memory' } },
};
test('readiness finds the owned server on page two and forwards the cursor exactly once', async () => {
  const f = appFixture({
    inventoryPages: [
      { data: [{ name: 'other' }], nextCursor: 'page-2' },
      { data: [ownedInventory], nextCursor: null },
    ],
  });
  await f.session.start();
  const p = f.send();
  await tick();
  const pages = f.requests.filter((r) => r.method === 'mcpServerStatus/list');
  expect(pages.map((r) => r.params.cursor)).toEqual([undefined, 'page-2']);
  expect(pages.every((r) => r.params.threadId === f.threadId)).toBe(true);
  expect(f.requests.filter((r) => r.method === 'turn/start')).toHaveLength(1);
  f.finish();
  expect((await p).nativeOutcome).toBe('completed');
});
for (const [label, pages, reason, count] of [
  [
    'repeated cursor',
    [
      { data: [], nextCursor: 'loop' },
      { data: [], nextCursor: 'loop' },
    ],
    'mcp-inventory-cursor',
    2,
  ],
  [
    'page ceiling',
    Array.from({ length: 40 }, (_, i) => ({ data: [], nextCursor: `page-${i}` })),
    'mcp-inventory-page-limit',
    32,
  ],
  [
    'duplicate owned server across pages',
    [
      { data: [ownedInventory], nextCursor: 'page-2' },
      { data: [ownedInventory], nextCursor: null },
    ],
    'mcp-inventory-duplicate',
    2,
  ],
] as const)
  test(`readiness refuses ${label} without work or a replacement binding`, async () => {
    const f = appFixture({ binding: 'retained', inventoryPages: pages });
    await f.session.start();
    const error = await f.send().catch((e) => e);
    expect(error.message).toContain(reason);
    expect(f.requests.filter((r) => r.method === 'mcpServerStatus/list')).toHaveLength(count);
    expect(f.requests.some((r) => r.method === 'turn/start' || r.method === 'thread/start')).toBe(
      false,
    );
    expect(f.session.externalSessionId).toBe('retained');
  });
test('readiness refuses empty and non-string cursors before another page or work', async () => {
  for (const nextCursor of ['', 7]) {
    const f = appFixture({ inventoryPages: [{ data: [], nextCursor }] });
    await f.session.start();
    const error = await f.send().catch((e) => e);
    expect(error.message).toContain('mcp-inventory-cursor');
    expect(f.requests.filter((r) => r.method === 'mcpServerStatus/list')).toHaveLength(1);
    expect(f.requests.some((r) => r.method === 'turn/start')).toBe(false);
  }
});

for (const binding of [undefined, 'retained'])
  test(`app integration config and exact readiness precede work (${binding ?? 'fresh'})`, async () => {
    const f = appFixture({ binding });
    await f.session.start();
    const p = f.send();
    await tick();
    const setup = f.requests.find((v) => v.method === (binding ? 'thread/resume' : 'thread/start'));
    expect(setup.params.config['mcp_servers.owned']).toEqual({
      command: 'bun',
      args: ['controlled-proxy'],
    });
    expect(setup.params.config['mcp_servers.other']).toEqual({ command: 'other' });
    expect(f.requests.find((v) => v.method === 'mcpServerStatus/list').params).toMatchObject({
      threadId: f.threadId,
      detail: 'toolsAndAuthOnly',
    });
    expect(f.requests.findIndex((v) => v.method === 'mcpServerStatus/list')).toBeLessThan(
      f.requests.findIndex((v) => v.method === 'turn/start'),
    );
    f.finish();
    expect((await p).nativeOutcome).toBe('completed');
    expect(
      f.session.events.find((e) => (e.raw as any)?.type === 'thread-configured')?.raw,
    ).toMatchObject({ model: 'observed', status: 'idle' });
  });

for (const response of [
  { model: undefined },
  { approvalPolicy: 'on-request' },
  { cwd: '/foreign' },
  { sandbox: { type: 'readOnly' } },
  { approvalsReviewer: undefined },
])
  test(`required configuration rejects ${JSON.stringify(response)}`, async () => {
    const f = appFixture({ binding: 'retained', response });
    await f.session.start();
    const e = await f.send().catch((e) => e);
    expect(e.attempt.localFailure).toBe('validation');
    expect(e.attempt.nativeOutcome).toBe('unknown');
    expect(f.requests.some((v) => v.method === 'turn/start')).toBe(false);
    expect(f.session.externalSessionId).toBe('retained');
  });
for (const inventory of [
  { data: [] },
  { data: [{ name: 'foreign', runtimeStatus: 'connected', tools: { foundry_memory: {} } }] },
  { data: [{ name: 'owned', runtimeStatus: 'starting', tools: { foundry_memory: {} } }] },
  { data: [{ name: 'owned', runtimeStatus: 'connected', tools: {} }] },
  null,
])
  test(`readiness refuses ${JSON.stringify(inventory)}`, async () => {
    const f = appFixture({ inventory });
    await f.session.start();
    const e = await f.send().catch((e) => e);
    expect(e).toBeInstanceOf(Error);
    expect(f.requests.some((v) => v.method === 'turn/start')).toBe(false);
  });
test('readiness timeout cannot later launch work or release unknown ownership', async () => {
  const f = appFixture({ holdInventory: true });
  await f.session.start();
  const e = await f.send().catch((e) => e);
  expect(e.attempt.localFailure).toBe('timeout');
  f.emit({
    id: f.requests.find((v) => v.method === 'mcpServerStatus/list').id,
    result: { data: [] },
  });
  await tick();
  expect(f.requests.some((v) => v.method === 'turn/start')).toBe(false);
  await expect(f.session.send('no retry')).rejects.toThrow();
});
test('MCP items preserve public receipt, item identity and streamed text without duplicate final text', async () => {
  const f = appFixture();
  await f.session.start();
  const p = f.send();
  await tick();
  const req = f.requests.find((v) => v.method === 'turn/start');
  f.emit({ id: req.id, result: { turn: { id: 'turn-1', status: 'inProgress', items: [] } } });
  const item = {
    id: 'tool-item',
    type: 'mcpToolCall',
    server: 'owned',
    tool: 'foundry_memory',
    arguments: { query: 'Zephyr' },
    status: 'inProgress',
  };
  f.notify('item/started', { item });
  f.notify('item/started', { item });
  f.notify('item/completed', {
    item: {
      ...item,
      status: 'completed',
      result: { content: [{ type: 'text', text: 'PUBLIC_RECEIPT' }] },
      _meta: { reasoning: 'PRIVATE' },
    },
  });
  f.notify('item/agentMessage/delta', { itemId: 'answer', delta: 'public ' });
  f.notify('item/agentMessage/delta', { itemId: 'answer', delta: 'answer' });
  f.notify('item/completed', {
    item: { id: 'answer', type: 'agentMessage', text: 'public answer' },
  });
  f.notify('turn/completed', { turn: { id: 'turn-1', status: 'completed', items: [] } });
  const r = await p;
  const begin = r.events.find((e) => e.kind === 'tool_use')!,
    end = r.events.find((e) => e.kind === 'tool_result')!;
  expect(begin).toMatchObject({
    itemId: 'tool-item',
    toolServer: 'owned',
    toolMethod: 'foundry_memory',
    toolInput: { query: 'Zephyr' },
  });
  expect(begin.callId).toBeUndefined();
  expect(end.toolOutput).toContain('PUBLIC_RECEIPT');
  expect(JSON.stringify(r)).not.toContain('PRIVATE');
  expect(r.events.filter((e) => e.kind === 'tool_use')).toHaveLength(1);
  expect(r.events.filter((e) => e.kind === 'text_delta')).toHaveLength(2);
  expect(r.content).toBe('public answer');
});
test('server requests receive explicit refusal, and killed owned instance cannot silently respawn', async () => {
  const f = appFixture();
  await f.session.start();
  f.emit({
    id: 'request-1',
    method: 'item/tool/requestUserInput',
    params: { questions: [{ secret: 'PRIVATE' }] },
  });
  await tick();
  expect(f.requests.find((v) => v.id === 'request-1')?.error?.code).toBe(-32601);
  expect(JSON.stringify(f.session.events)).not.toContain('PRIVATE');
  f.session.kill();
  await expect(f.session.start()).rejects.toThrow('new owned instance');
});

for (const mode of ['tool-error', 'non-text', 'foreign', 'mismatch'] as const)
  test(`app MCP ${mode} cannot become a forged successful tool result`, async () => {
    const f = appFixture();
    await f.session.start();
    const p = f.send();
    await tick();
    const req = f.requests.find((v) => v.method === 'turn/start');
    f.emit({ id: req.id, result: { turn: { id: 'turn-1', status: 'inProgress', items: [] } } });
    const item = {
      id: 'item',
      type: 'mcpToolCall',
      server: 'owned',
      tool: 'foundry_memory',
      arguments: { query: 'PUBLIC' },
      status: 'inProgress',
    };
    f.notify('item/started', { item });
    f.notify('item/completed', {
      ...(mode === 'foreign' ? { turnId: 'foreign' } : {}),
      item: {
        ...item,
        status: mode === 'tool-error' ? 'failed' : 'completed',
        ...(mode === 'mismatch' ? { arguments: { query: 'different' } } : {}),
        ...(mode === 'tool-error'
          ? { error: { message: 'public tool failure' } }
          : {
              result: {
                content:
                  mode === 'non-text'
                    ? [{ type: 'image', data: 'PRIVATE' }]
                    : [{ type: 'text', text: 'public result' }],
              },
            }),
      },
    });
    f.notify('turn/completed', { turn: { id: 'turn-1', status: 'completed', items: [] } });
    const r = await p;
    expect(r.nativeOutcome).toBe('completed');
    const end = r.events.find((e) => e.kind === 'tool_result');
    if (mode === 'tool-error') expect(end?.toolError).toBe(true);
    else if (mode === 'non-text') {
      expect(end?.toolOutputOmitted).toBe(true);
      expect(JSON.stringify(r)).not.toContain('PRIVATE');
    } else expect(end).toBeUndefined();
  });
const mcpItem = (id: string, args?: unknown) => ({
  id,
  type: 'mcpToolCall',
  server: 'owned',
  tool: 'foundry_memory',
  ...(args === undefined ? {} : { arguments: args }),
  status: 'inProgress',
});
const mcpDone = (item: Record<string, unknown>) => ({
  ...item,
  status: 'completed',
  result: { content: [{ type: 'text', text: 'PUBLIC' }] },
});
const turnStarted = (f: ReturnType<typeof appFixture>) =>
  f.emit({
    id: f.requests.find((v) => v.method === 'turn/start').id,
    result: { turn: { id: 'turn-1', status: 'inProgress', items: [] } },
  });
test('app MCP arguments drop secret subfields, absent arguments stay unavailable, and tool input is immutable', async () => {
  const f = appFixture();
  await f.session.start();
  f.session.onEvent((e) => {
    if (e.kind === 'tool_use' && e.toolInput)
      try {
        (e.toolInput as Record<string, unknown>).id = 'FORGED';
      } catch {}
  });
  const p = f.send();
  await tick();
  turnStarted(f);
  const args = {
    id: 'owned',
    nested: { credentials: { key: 'PRIVATE' }, reasoning: 'PRIVATE', value: 3 },
  };
  const owned = mcpItem('owned-item', args),
    absent = mcpItem('absent-item');
  f.notify('item/started', { item: owned });
  f.notify('item/completed', { item: mcpDone(owned) });
  f.notify('item/started', { item: absent });
  f.notify('item/completed', { item: mcpDone(absent) });
  f.notify('turn/completed', { turn: { id: 'turn-1', status: 'completed', items: [] } });
  const r = await p;
  const begins = r.events.filter((e) => e.kind === 'tool_use');
  expect(begins).toHaveLength(2);
  expect(begins[0].toolInput).toEqual({ id: 'owned', nested: { value: 3 } });
  expect(begins[0].toolInputOmitted).toBeDefined();
  expect(Object.isFrozen(begins[0].toolInput)).toBe(true);
  expect(begins[1].toolInput).toBeUndefined();
  expect(begins[1].toolInputOmitted).toBeDefined();
  expect(r.events.filter((e) => e.kind === 'tool_result')).toHaveLength(2);
  expect(JSON.stringify(f.session.events)).not.toContain('PRIVATE');
});
test('app MCP result after the native terminal stays unowned and never joins the call', async () => {
  const f = appFixture();
  await f.session.start();
  const p = f.send();
  await tick();
  const item = mcpItem('item', { query: 'PUBLIC' });
  f.notify('turn/started', { turn: { id: 'turn-1', status: 'inProgress', items: [] } });
  f.notify('item/started', { item });
  f.notify('turn/completed', { turn: { id: 'turn-1', status: 'completed', items: [] } });
  f.notify('item/completed', { item: mcpDone(item) });
  turnStarted(f);
  const r = await p;
  expect(r.nativeOutcome).toBe('completed');
  expect(r.events.filter((e) => e.kind === 'tool_result')).toHaveLength(0);
  expect(
    f.session.events.some(
      (e) => e.unattributedReason === 'after-terminal' && e.itemId === 'item' && !e.admissionId,
    ),
  ).toBe(true);
});
test('app MCP evidence after a local timeout stays with the timed-out admission', async () => {
  const f = appFixture();
  await f.session.start();
  const p = f.send();
  await tick();
  turnStarted(f);
  const item = mcpItem('item', { query: 'PUBLIC' });
  f.notify('item/started', { item });
  const error = await p.catch((e) => e);
  expect(error.attempt.localFailure).toBe('timeout');
  const local = f.session.attempts[0];
  f.notify('item/completed', { item: mcpDone(item) });
  f.notify('turn/completed', { turn: { id: 'turn-1', status: 'completed', items: [] } });
  await tick();
  const attempt = f.session.attempts[0];
  expect(attempt).toMatchObject({ nativeOutcome: 'completed', localOutcome: 'rejected' });
  expect(attempt.events.filter((e) => e.kind === 'tool_result')).toHaveLength(1);
  expect(local.nativeOutcome).toBe('unknown');
  expect(local.events.some((e) => e.kind === 'tool_result')).toBe(false);
  expect(f.requests.filter((v) => v.method === 'turn/start')).toHaveLength(1);
});
test('streamed public text survives failed native terminal and rejecting observers', async () => {
  const f = appFixture();
  await f.session.start();
  f.session.onEvent(() => {
    throw Error('observer');
  });
  const p = f.send();
  await tick();
  f.emit({
    id: f.requests.find((v) => v.method === 'turn/start').id,
    result: { turn: { id: 'turn-1', status: 'inProgress', items: [] } },
  });
  f.notify('item/agentMessage/delta', { itemId: 'text', delta: 'partial public text' });
  f.notify('turn/completed', {
    turn: {
      id: 'turn-1',
      status: 'failed',
      error: { message: 'original native error' },
      items: [],
    },
  });
  const r = await p;
  expect(r.content).toBe('partial public text');
  expect(r.nativeOutcome).toBe('failed');
  expect(r.terminal?.reason).toBe('original native error');
  expect(f.session.diagnostics.observerFailures.synchronous).toBeGreaterThan(0);
});
test('strict handshake missing required fields closes owned setup without thread creation or respawn', async () => {
  const f = appFixture({ binding: 'retained', initialize: { userAgent: 'partial' } });
  await expect(f.session.start()).rejects.toThrow('initialize response');
  expect(f.requests.some((r) => r.method === 'thread/resume')).toBe(false);
  expect(f.session.externalSessionId).toBe('retained');
  await expect(f.session.send('no retry')).rejects.toThrow();
  expect(f.requests.filter((r) => r.method === 'initialize')).toHaveLength(1);
});
test('server refusal is journal-projectable only for the exact active native thread and turn', async () => {
  const f = appFixture();
  await f.session.start();
  const p = f.send();
  await tick();
  f.emit({
    id: f.requests.find((v) => v.method === 'turn/start').id,
    result: { turn: { id: 'turn-1', status: 'inProgress', items: [] } },
  });
  f.emit({
    id: 'own-request',
    method: 'item/tool/requestUserInput',
    params: { threadId: f.threadId, turnId: 'turn-1', questions: [{ question: 'PRIVATE' }] },
  });
  f.emit({
    id: 'foreign-request',
    method: 'item/tool/requestUserInput',
    params: { threadId: 'foreign', turnId: 'turn-1' },
  });
  await tick();
  const refusals = f.session.events.filter(
    (e) => (e.raw as any)?.type === 'server-request-refusal',
  );
  expect(refusals).toHaveLength(2);
  expect(refusals[0].admissionId).toBe(f.session.attempts[0].admissionId);
  expect(refusals[1].admissionId).toBeUndefined();
  expect(JSON.stringify(refusals)).not.toContain('PRIVATE');
  f.notify('turn/completed', { turn: { id: 'turn-1', status: 'completed', items: [] } });
  await p;
});
