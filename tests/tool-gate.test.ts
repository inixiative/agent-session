import { afterEach, describe, expect, test } from 'bun:test';
import {
  ClaudeAgentSdkSession,
  ClaudeCodeSession,
  CodexAppServerSession,
  codexPermissions,
  type ToolRequest,
  TRANSPORTS,
} from '../src';
import { fakeProcess, tick } from './helpers/fake-process';

// Wire shapes follow claude 2.1.296 (stdio permission prompt + SDK hook callbacks, probed live
// 2026-10-11) and the codex-cli 0.155.1 app-server schema (`codex app-server generate-ts`).

const kills: Array<() => void> = [];
afterEach(() => {
  for (const kill of kills.splice(0)) kill();
});

const SESSION = 'gate-session';
const tool = { name: 'Bash', input: { command: 'rm -rf build' }, id: 'toolu_1' };

/** A Claude CLI that, per user message, runs the PreToolUse callback and then (optionally) asks. */
function claude(opts: { ask?: boolean; hold?: boolean } = {}) {
  let hookId: string | undefined;
  const results: Record<string, unknown>[] = [];
  const answers = new Map<string, (response: Record<string, unknown>) => void>();
  const request = (io: { emit(value: unknown): void }, id: string, body: unknown) =>
    new Promise<Record<string, unknown>>((resolve) => {
      answers.set(id, resolve);
      io.emit({ type: 'control_request', request_id: id, request: body });
    });
  const fake = fakeProcess(async (message, io) => {
    if (message.type === 'control_request' && message.request.subtype === 'initialize') {
      hookId = message.request.hooks.PreToolUse[0].hookCallbackIds[0];
      io.emit({
        type: 'control_response',
        response: { subtype: 'success', request_id: message.request_id, response: {} },
      });
      return;
    }
    if (message.type === 'control_response') {
      results.push(message.response);
      answers.get(message.response.request_id)?.(message.response.response);
      return;
    }
    if (message.type !== 'user') return;
    io.emit({ type: 'system', subtype: 'init', session_id: SESSION });
    io.emit({
      type: 'assistant',
      session_id: SESSION,
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: tool.id, name: tool.name, input: tool.input }],
      },
    });
    const pre = await request(io, 'hook-1', {
      subtype: 'hook_callback',
      callback_id: hookId,
      input: {
        hook_event_name: 'PreToolUse',
        tool_name: tool.name,
        tool_input: tool.input,
        tool_use_id: tool.id,
        permission_mode: 'bypassPermissions',
      },
      tool_use_id: tool.id,
    });
    let outcome = 'ran';
    const denied = (pre.hookSpecificOutput as Record<string, unknown> | undefined)
      ?.permissionDecision;
    if (denied === 'deny') outcome = 'hook-denied';
    else if (opts.ask) {
      if (opts.hold) return;
      const asked = await request(io, 'ask-1', {
        subtype: 'can_use_tool',
        tool_name: tool.name,
        display_name: tool.name,
        input: tool.input,
        description: 'Remove the build directory',
        blocked_path: '/work/build',
        tool_use_id: tool.id,
      });
      outcome = asked.behavior === 'allow' ? 'ran' : 'ask-denied';
    }
    io.emit({
      type: 'result',
      subtype: 'success',
      result: outcome,
      session_id: SESSION,
      uuid: crypto.randomUUID(),
    });
  });
  return { fake, results, argv: [] as string[], answers };
}

function claudeSession(
  harness: ReturnType<typeof claude>,
  config: ConstructorParameters<typeof ClaudeCodeSession>[0] = {},
) {
  const session = new ClaudeCodeSession({
    permissionMode: 'bypassPermissions',
    toolGate: true,
    ...config,
    spawn: (cmd) => {
      harness.argv.push(...cmd);
      return harness.fake.proc;
    },
  });
  kills.push(() => session.kill());
  return session;
}

describe('Claude tool gate (claude-cli)', () => {
  test('a pre-use deny holds under bypassPermissions and reaches the model as the reason', async () => {
    const h = claude();
    const session = claudeSession(h);
    const seen: ToolRequest[] = [];
    session.onToolRequest((request) => {
      seen.push(request);
      return { behavior: 'deny', message: 'structural: exec:shell is denied' };
    });
    await session.start();
    expect(h.argv).toContain('--permission-prompt-tool');
    expect(h.argv[h.argv.indexOf('--permission-prompt-tool') + 1]).toBe('stdio');
    const result = await session.send('clean up');
    expect(result.content).toBe('hook-denied');
    expect(seen[0]).toMatchObject({
      stage: 'pre-use',
      toolName: 'Bash',
      toolInput: { command: 'rm -rf build' },
      callId: 'toolu_1',
      admissionId: result.admissionId,
    });
    expect(h.results[0]).toEqual({
      subtype: 'success',
      request_id: 'hook-1',
      response: {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: 'structural: exec:shell is denied',
        },
      },
    });
  });

  test('pre-use allow leaves the mode to decide; the permission ask is then final', async () => {
    const h = claude({ ask: true });
    const session = claudeSession(h, { permissionMode: 'default' });
    const stages: string[] = [];
    session.onToolRequest((request) => {
      stages.push(request.stage);
      if (request.stage === 'permission') {
        expect(request).toMatchObject({
          description: 'Remove the build directory',
          blockedPath: '/work/build',
        });
        return { behavior: 'deny', message: 'Aron said no' };
      }
      return { behavior: 'allow' };
    });
    await session.start();
    expect((await session.send('clean up')).content).toBe('ask-denied');
    expect(stages).toEqual(['pre-use', 'permission']);
    expect(h.results[0]).toEqual({ subtype: 'success', request_id: 'hook-1', response: {} });
    expect(h.results[1]).toEqual({
      subtype: 'success',
      request_id: 'ask-1',
      response: { behavior: 'deny', message: 'Aron said no' },
    });
  });

  test('an allowed ask echoes the input back as updatedInput', async () => {
    const h = claude({ ask: true });
    const session = claudeSession(h, { permissionMode: 'default' });
    session.onToolRequest(() => ({ behavior: 'allow' }));
    await session.start();
    expect((await session.send('clean up')).content).toBe('ran');
    expect(h.results[1]).toEqual({
      subtype: 'success',
      request_id: 'ask-1',
      response: { behavior: 'allow', updatedInput: tool.input },
    });
  });

  test('gates compose in order: first deny wins, a thrown gate denies', async () => {
    const order: string[] = [];
    const h = claude({ ask: true });
    const session = claudeSession(h, { permissionMode: 'default' });
    session.onToolRequest(() => {
      order.push('first');
      return { behavior: 'allow' };
    });
    session.onToolRequest((request) => {
      order.push('second');
      if (request.stage === 'permission') throw new Error('policy store offline');
      return { behavior: 'allow' };
    });
    session.onToolRequest(() => {
      order.push('third');
      return { behavior: 'allow' };
    });
    await session.start();
    expect((await session.send('clean up')).content).toBe('ask-denied');
    expect(order).toEqual(['first', 'second', 'third', 'first', 'second']);
    expect(h.results[1]?.response).toEqual({
      behavior: 'deny',
      message: 'Tool gate failed: policy store offline',
    });
  });

  test('with no gate registered: pre-use continues, a permission ask is denied', async () => {
    const h = claude({ ask: true });
    const session = claudeSession(h, { permissionMode: 'default' });
    await session.start();
    expect((await session.send('clean up')).content).toBe('ask-denied');
    expect(h.results[0]?.response).toEqual({});
    expect(h.results[1]?.response).toEqual({ behavior: 'deny', message: 'No approval handler' });
  });

  test('an unregistered gate no longer decides', async () => {
    const h = claude();
    const session = claudeSession(h);
    const off = session.onToolRequest(() => ({ behavior: 'deny', message: 'no' }));
    off();
    await session.start();
    expect((await session.send('go')).content).toBe('ran');
  });

  test('a withdrawn or late decision is never written', async () => {
    const h = claude({ ask: true, hold: true });
    const session = claudeSession(h, { permissionMode: 'default' });
    let signal: AbortSignal | undefined;
    let release!: () => void;
    session.onToolRequest((request) => {
      if (request.stage === 'pre-use') return { behavior: 'allow' };
      signal = request.signal;
      return new Promise((resolve) => {
        release = () => resolve({ behavior: 'allow' });
      });
    });
    await session.start();
    void session.send('go').catch(() => {});
    await tick(5);
    // The CLI holds no ask in this script; emulate one, then the CLI withdrawing it.
    h.fake.io.emit({
      type: 'control_request',
      request_id: 'ask-late',
      request: { subtype: 'can_use_tool', tool_name: 'Bash', input: {}, tool_use_id: 'toolu_2' },
    });
    await tick(5);
    expect(signal?.aborted).toBe(false);
    h.fake.io.emit({ type: 'control_cancel_request', request_id: 'ask-late' });
    await tick(5);
    expect(signal?.aborted).toBe(true);
    release();
    await tick(5);
    expect(h.results.some((r) => r.request_id === 'ask-late')).toBe(false);
  });

  test('kill withdraws pending decisions', async () => {
    const h = claude();
    const session = claudeSession(h);
    let signal: AbortSignal | undefined;
    session.onToolRequest((request) => {
      signal = request.signal;
      return new Promise(() => {});
    });
    await session.start();
    void session.send('go').catch(() => {});
    await tick(5);
    expect(signal?.aborted).toBe(false);
    session.kill();
    expect(signal?.aborted).toBe(true);
  });

  test('an ungated session keeps its argv and refuses tool control requests as before', async () => {
    const h = claude();
    const session = claudeSession(h, { toolGate: false });
    await session.start();
    expect(h.argv).not.toContain('--permission-prompt-tool');
    expect(h.fake.lines.some((line) => line.type === 'control_request')).toBe(false);
    expect(() => session.onToolRequest(() => ({ behavior: 'allow' }))).toThrow(/toolGate/);
    h.fake.io.emit({
      type: 'control_request',
      request_id: 'x',
      request: { subtype: 'can_use_tool', tool_name: 'Bash', input: {} },
    });
    await tick(5);
    expect(h.results.at(-1)).toMatchObject({ subtype: 'error', request_id: 'x' });
  });

  test('textOnly sessions cannot be gated; forks carry the gate', async () => {
    expect(() => new ClaudeCodeSession({ textOnly: true, toolGate: true })).toThrow(/toolGate/);
    const h = claude();
    const session = claudeSession(h);
    session.onToolRequest(() => ({ behavior: 'deny', message: 'carried' }));
    await session.start();
    await session.send('go');
    const forkHarness = claude();
    const forked = session.fork({
      spawn: (cmd) => {
        forkHarness.argv.push(...cmd);
        return forkHarness.fake.proc;
      },
    });
    kills.push(() => forked.kill());
    await forked.start();
    expect(forkHarness.argv).toContain('--permission-prompt-tool');
    expect((await forked.send('go')).content).toBe('hook-denied');
  });

  test('MCP tool names are split into server and method', async () => {
    const h = claude();
    const session = claudeSession(h);
    const seen: ToolRequest[] = [];
    session.onToolRequest((request) => {
      seen.push(request);
      return { behavior: 'allow' };
    });
    await session.start();
    h.fake.io.emit({
      type: 'control_request',
      request_id: 'mcp-ask',
      request: {
        subtype: 'can_use_tool',
        tool_name: 'mcp__linear_server__save_issue',
        input: { title: 'x' },
      },
    });
    await tick(5);
    expect(seen[0]).toMatchObject({
      stage: 'permission',
      toolServer: 'linear_server',
      toolMethod: 'save_issue',
    });
  });

  test('an unreadable gated request is denied, never answered with an error (fail closed)', async () => {
    const h = claude();
    const session = claudeSession(h);
    const seen: ToolRequest[] = [];
    session.onToolRequest((request) => {
      seen.push(request);
      return { behavior: 'allow' };
    });
    await session.start();
    const hookId = h.fake.lines.find((line) => line.request?.subtype === 'initialize')?.request
      .hooks.PreToolUse[0].hookCallbackIds[0];
    // Our callback without a tool name, our callback for another event, and an ask without input.
    h.fake.io.emit({
      type: 'control_request',
      request_id: 'bad-hook',
      request: {
        subtype: 'hook_callback',
        callback_id: hookId,
        input: { hook_event_name: 'PreToolUse' },
      },
    });
    h.fake.io.emit({
      type: 'control_request',
      request_id: 'bad-event',
      request: {
        subtype: 'hook_callback',
        callback_id: hookId,
        input: { hook_event_name: 'Stop' },
      },
    });
    h.fake.io.emit({
      type: 'control_request',
      request_id: 'bad-ask',
      request: { subtype: 'can_use_tool', input: {} },
    });
    h.fake.io.emit({
      type: 'control_request',
      request_id: 'other-hook',
      request: { subtype: 'hook_callback', callback_id: 'someone-else', input: {} },
    });
    await tick(5);
    const answer = (id: string) => h.results.find((r) => r.request_id === id);
    const hookDeny = {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: 'Tool gate: unreadable PreToolUse callback',
      },
    };
    expect(answer('bad-hook')).toEqual({
      subtype: 'success',
      request_id: 'bad-hook',
      response: hookDeny,
    });
    expect(answer('bad-event')).toEqual({
      subtype: 'success',
      request_id: 'bad-event',
      response: hookDeny,
    });
    expect(answer('bad-ask')).toEqual({
      subtype: 'success',
      request_id: 'bad-ask',
      response: { behavior: 'deny', message: 'Tool gate: unreadable permission request' },
    });
    expect(answer('other-hook')).toMatchObject({ subtype: 'error', request_id: 'other-hook' });
    expect(seen).toEqual([]);
  });

  test('subagent calls carry agentId; asks carry decisionReason', async () => {
    const h = claude();
    const session = claudeSession(h);
    const seen: ToolRequest[] = [];
    session.onToolRequest((request) => {
      seen.push(request);
      return { behavior: 'allow' };
    });
    await session.start();
    const hookId = h.fake.lines.find((line) => line.request?.subtype === 'initialize')?.request
      .hooks.PreToolUse[0].hookCallbackIds[0];
    h.fake.io.emit({
      type: 'control_request',
      request_id: 'sub-hook',
      request: {
        subtype: 'hook_callback',
        callback_id: hookId,
        input: {
          hook_event_name: 'PreToolUse',
          tool_name: 'Read',
          tool_input: { file_path: '/a' },
          tool_use_id: 'toolu_s',
          agent_id: 'agent-7',
        },
      },
    });
    h.fake.io.emit({
      type: 'control_request',
      request_id: 'sub-ask',
      request: {
        subtype: 'can_use_tool',
        tool_name: 'Bash',
        input: { command: 'ls' },
        tool_use_id: 'toolu_t',
        agent_id: 'agent-7',
        decision_reason: 'Bash(ls) is not in the allow list',
      },
    });
    await tick(5);
    expect(seen[0]).toMatchObject({ stage: 'pre-use', agentId: 'agent-7', callId: 'toolu_s' });
    expect(seen[1]).toMatchObject({
      stage: 'permission',
      agentId: 'agent-7',
      decisionReason: 'Bash(ls) is not in the allow list',
    });
  });

  test('claude-cli declares callback approvals', () => {
    expect(TRANSPORTS['claude-cli'].capabilities.approvals).toBe('callback');
    expect(TRANSPORTS['codex-app-server'].capabilities.approvals).toBe('callback');
  });
});

describe('Claude tool gate (claude-agent-sdk)', () => {
  test('SDK canUseTool and PreToolUse hooks route through the same gates', async () => {
    let options: Record<string, unknown> = {};
    const session = new ClaudeAgentSdkSession({
      toolGate: true,
      permissionMode: 'default',
      query: (params) => {
        options = params.options;
        let close!: () => void;
        const closed = new Promise<void>((resolve) => {
          close = resolve;
        });
        return {
          interrupt: async () => {},
          close,
          [Symbol.asyncIterator]: () => ({
            next: async (): Promise<IteratorResult<unknown>> => {
              await closed;
              return { done: true, value: undefined };
            },
          }),
        };
      },
    });
    kills.push(() => session.kill());
    const seen: string[] = [];
    session.onToolRequest((request) => {
      seen.push(`${request.stage}:${request.toolName}`);
      return request.stage === 'pre-use'
        ? { behavior: 'deny', message: 'structural' }
        : { behavior: 'allow' };
    });
    await session.start();
    expect(Object.keys((options.extraArgs as object) ?? {})).not.toContain(
      'permission-prompt-tool',
    );
    const hook = (
      options.hooks as {
        PreToolUse: Array<{ hooks: Array<(i: unknown, id?: string) => Promise<unknown>> }>;
      }
    ).PreToolUse[0]!.hooks[0]!;
    expect(
      await hook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: {} }, 't1'),
    ).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: 'structural',
      },
    });
    const canUseTool = options.canUseTool as (
      name: string,
      input: Record<string, unknown>,
      context: { toolUseID: string },
    ) => Promise<unknown>;
    expect(await canUseTool('Write', { file_path: '/a' }, { toolUseID: 't2' })).toEqual({
      behavior: 'allow',
      updatedInput: { file_path: '/a' },
    });
    expect(seen).toEqual(['pre-use:Bash', 'permission:Write']);
  });

  test('SDK canUseTool context and unanswered hooks', async () => {
    let options: Record<string, unknown> = {};
    const session = new ClaudeAgentSdkSession({
      toolGate: true,
      permissionMode: 'default',
      query: (params) => {
        options = params.options;
        let close!: () => void;
        const closed = new Promise<void>((resolve) => {
          close = resolve;
        });
        return {
          interrupt: async () => {},
          close,
          [Symbol.asyncIterator]: () => ({
            next: async (): Promise<IteratorResult<unknown>> => {
              await closed;
              return { done: true, value: undefined };
            },
          }),
        };
      },
    });
    kills.push(() => session.kill());
    const seen: ToolRequest[] = [];
    session.onToolRequest((request) => {
      seen.push(request);
      return { behavior: 'allow' };
    });
    await session.start();
    const canUseTool = options.canUseTool as (
      name: string,
      input: Record<string, unknown>,
      context: Record<string, unknown>,
    ) => Promise<unknown>;
    await canUseTool(
      'Bash',
      { command: 'ls' },
      {
        toolUseID: 't3',
        description: 'List files',
        decisionReason: 'Bash(ls) needs approval',
        agentID: 'agent-2',
      },
    );
    expect(seen[0]).toMatchObject({
      stage: 'permission',
      callId: 't3',
      description: 'List files',
      decisionReason: 'Bash(ls) needs approval',
      agentId: 'agent-2',
    });
    const hook = (
      options.hooks as {
        PreToolUse: Array<{
          hooks: Array<(i: unknown, id?: string, c?: { signal?: AbortSignal }) => Promise<unknown>>;
        }>;
      }
    ).PreToolUse[0]!.hooks[0]!;
    const deny = (reason: string) => ({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
      },
    });
    // An input the session cannot read is denied by the session itself.
    expect(await hook({ hook_event_name: 'PreToolUse' }, 't4')).toEqual(
      deny('Tool gate: unreadable PreToolUse callback'),
    );
    // No answer at all (withdrawn, bridge closed) is a deny, never an allow.
    const controller = new AbortController();
    const pending = hook(
      { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: {} },
      't5',
      {
        signal: controller.signal,
      },
    );
    controller.abort();
    expect(await pending).toEqual(deny('Tool gate unavailable'));
  });

  test('canUseTool and toolGate are exclusive', () => {
    expect(
      () =>
        new ClaudeAgentSdkSession({
          toolGate: true,
          canUseTool: async () => ({}),
          query: () => ({
            interrupt: async () => {},
            close() {},
            async *[Symbol.asyncIterator]() {},
          }),
        }),
    ).toThrow(/either canUseTool or toolGate/);
  });
});

// ---------------------------------------------------------------------------
// Codex app-server approvals
// ---------------------------------------------------------------------------

function codex(
  appServer: Record<string, unknown> = {},
  opts: { reviewer?: string; exited?: Promise<number> } = {},
) {
  const threadId = 'thread-gated';
  const written: any[] = [];
  const fake = fakeProcess((message, io) => {
    written.push(message);
    if (message.method === 'initialize')
      io.emit({
        id: message.id,
        result: {
          userAgent: 'codex/0.155.1',
          platformFamily: 'unix',
          platformOs: 'macos',
          codexHome: '/codex-home',
        },
      });
    if (message.method === 'thread/start')
      io.emit({
        id: message.id,
        result: {
          thread: { id: threadId, turns: [], status: { type: 'idle' } },
          model: 'm',
          modelProvider: 'openai',
          cwd: '/work',
          approvalPolicy: message.params.approvalPolicy,
          approvalsReviewer: opts.reviewer ?? 'user',
          sandbox: {
            type: {
              'read-only': 'readOnly',
              'workspace-write': 'workspaceWrite',
              'danger-full-access': 'dangerFullAccess',
            }[message.params.sandbox as string],
          },
        },
      });
    if (message.method === 'turn/start') {
      const turn = { id: 'turn-1', status: 'inProgress', items: [], error: null };
      io.emit({ id: message.id, result: { turn } });
      io.emit({ method: 'turn/started', params: { threadId, turn } });
    }
  });
  const session = new CodexAppServerSession({
    cwd: '/work',
    model: 'm',
    timeout: 2_000,
    appServer: { requireConfiguration: true, ...appServer },
    spawn: () => (opts.exited ? { ...fake.proc, exited: opts.exited } : fake.proc),
  });
  kills.push(() => session.kill());
  const finish = () =>
    fake.io.emit({
      method: 'turn/completed',
      params: { threadId, turn: { id: 'turn-1', status: 'completed', items: [], error: null } },
    });
  const approval = (id: number, method: string, params: Record<string, unknown>) =>
    fake.io.emit({
      id,
      method,
      params: { threadId, turnId: 'turn-1', itemId: `item-${id}`, startedAtMs: 1, ...params },
    });
  return { session, written, fake, finish, approval, threadId };
}

describe('Codex app-server approvals', () => {
  test('host modes map onto approval policy and sandbox', () => {
    expect(codexPermissions('default')).toEqual({
      approvalPolicy: 'on-request',
      sandbox: 'workspace-write',
    });
    expect(codexPermissions('acceptEdits')).toEqual({
      approvalPolicy: 'on-request',
      sandbox: 'workspace-write',
    });
    expect(codexPermissions('plan')).toEqual({ approvalPolicy: 'never', sandbox: 'read-only' });
    expect(codexPermissions('bypassPermissions')).toEqual({
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
    });
  });

  test('command and file-change approvals are answered through the gates', async () => {
    const c = codex(codexPermissions('default'));
    const seen: ToolRequest[] = [];
    c.session.onToolRequest((request) => {
      seen.push(request);
      return request.toolName === 'shell'
        ? { behavior: 'allow' }
        : { behavior: 'deny', message: 'no writes' };
    });
    await c.session.start();
    const pending = c.session.send('work');
    await tick(10);
    expect(c.written.find((m) => m.method === 'thread/start').params).toMatchObject({
      approvalPolicy: 'on-request',
      sandbox: 'workspace-write',
    });
    c.approval(90, 'item/commandExecution/requestApproval', {
      kind: 'command',
      command: 'bun test',
      cwd: '/work',
      reason: 'run tests',
      environmentId: null,
    });
    c.approval(91, 'item/fileChange/requestApproval', { grantRoot: '/work/src' });
    await tick(10);
    expect(c.written.find((m) => m.id === 90)).toEqual({
      jsonrpc: '2.0',
      id: 90,
      result: { decision: 'accept' },
    });
    expect(c.written.find((m) => m.id === 91)).toEqual({
      jsonrpc: '2.0',
      id: 91,
      result: { decision: 'decline' },
    });
    expect(seen[0]).toMatchObject({
      stage: 'permission',
      toolName: 'shell',
      toolInput: { command: 'bun test', cwd: '/work', kind: 'command' },
      callId: 'item-90',
      description: 'run tests',
    });
    expect(seen[1]).toMatchObject({
      toolName: 'apply_patch',
      toolInput: { grantRoot: '/work/src' },
    });
    c.finish();
    await pending;
  });

  test('with no gate an approval is declined; other server requests stay refused', async () => {
    const c = codex(codexPermissions('default'));
    await c.session.start();
    const pending = c.session.send('work');
    await tick(10);
    c.approval(92, 'item/commandExecution/requestApproval', { command: 'ls' });
    c.approval(93, 'item/permissions/requestApproval', { cwd: '/work', reason: null });
    c.approval(94, 'item/tool/requestUserInput', {});
    await tick(10);
    expect(c.written.find((m) => m.id === 92)?.result).toEqual({ decision: 'decline' });
    expect(c.written.find((m) => m.id === 93)?.error?.code).toBe(-32601);
    expect(c.written.find((m) => m.id === 94)?.error?.code).toBe(-32601);
    c.finish();
    await pending;
  });

  test('an approval the runtime resolved itself is not answered', async () => {
    const c = codex(codexPermissions('default'));
    let signal: AbortSignal | undefined;
    let release!: () => void;
    c.session.onToolRequest((request) => {
      signal = request.signal;
      return new Promise((resolve) => {
        release = () => resolve({ behavior: 'allow' });
      });
    });
    await c.session.start();
    const pending = c.session.send('work');
    await tick(10);
    c.approval(95, 'item/commandExecution/requestApproval', { command: 'ls' });
    await tick(10);
    c.fake.io.emit({
      method: 'serverRequest/resolved',
      params: { threadId: c.threadId, requestId: 95 },
    });
    await tick(10);
    expect(signal?.aborted).toBe(true);
    release();
    await tick(10);
    expect(c.written.some((m) => m.id === 95)).toBe(false);
    c.finish();
    await pending;
  });

  test('an unconfigured session keeps never / danger-full-access and validates it', async () => {
    const c = codex();
    expect(() => c.session.onToolRequest(() => ({ behavior: 'allow' }))).toThrow(/approvalPolicy/);
    await c.session.start();
    const pending = c.session.send('work');
    await tick(10);
    const params = c.written.find((m) => m.method === 'thread/start').params;
    expect(params).toMatchObject({ approvalPolicy: 'never', sandbox: 'danger-full-access' });
    expect(params).not.toHaveProperty('approvalsReviewer');
    c.finish();
    expect((await pending).nativeOutcome).toBe('completed');
  });

  test('a gated thread asks for the user reviewer and refuses any other', async () => {
    for (const requireConfiguration of [true, false]) {
      const c = codex(
        { ...codexPermissions('default'), requireConfiguration },
        { reviewer: 'auto_review' },
      );
      c.session.onToolRequest(() => ({ behavior: 'allow' }));
      await c.session.start();
      await expect(c.session.send('work')).rejects.toThrow(
        /approvals-not-routed-to-user \(auto_review\); no turn was sent/,
      );
      expect(c.written.find((m) => m.method === 'thread/start').params.approvalsReviewer).toBe(
        'user',
      );
      expect(c.written.some((m) => m.method === 'turn/start')).toBe(false);
    }
  });

  test('file-change approvals carry the item changes; command approvals the network context', async () => {
    const c = codex(codexPermissions('default'));
    const seen: ToolRequest[] = [];
    c.session.onToolRequest((request) => {
      seen.push(request);
      return { behavior: 'allow' };
    });
    await c.session.start();
    const pending = c.session.send('work');
    await tick(10);
    const big = 'x'.repeat(20_000);
    c.fake.io.emit({
      method: 'item/started',
      params: {
        threadId: c.threadId,
        turnId: 'turn-1',
        startedAtMs: 1,
        item: {
          type: 'fileChange',
          id: 'item-96',
          status: 'inProgress',
          changes: [
            {
              path: '/work/a.ts',
              kind: { type: 'update', move_path: '/work/b.ts' },
              diff: '-a\n+b',
            },
            { path: '/work/big.bin', kind: { type: 'add' }, diff: big },
            { path: 7, kind: { type: 'add' }, diff: '' },
          ],
        },
      },
    });
    c.fake.io.emit({
      method: 'item/fileChange/patchUpdated',
      params: {
        threadId: c.threadId,
        turnId: 'turn-1',
        itemId: 'item-96',
        changes: [
          { path: '/work/a.ts', kind: { type: 'update', move_path: '/work/b.ts' }, diff: '-a\n+b' },
          { path: '/work/big.bin', kind: { type: 'add' }, diff: big },
          { path: '/work/gone.ts', kind: { type: 'delete' }, diff: '' },
        ],
      },
    });
    await tick(5);
    c.approval(96, 'item/fileChange/requestApproval', { reason: 'write outside workspace' });
    c.approval(97, 'item/commandExecution/requestApproval', {
      kind: 'command',
      command: 'curl example.com',
      networkApprovalContext: { host: 'example.com', protocol: 'https' },
      environmentId: null,
    });
    await tick(10);
    expect(seen[0]).toMatchObject({
      toolName: 'apply_patch',
      callId: 'item-96',
      description: 'write outside workspace',
      toolInput: {
        changes: [
          { path: '/work/a.ts', kind: 'update', movePath: '/work/b.ts', diff: '-a\n+b' },
          { path: '/work/big.bin', kind: 'add', diffOmitted: true },
          { path: '/work/gone.ts', kind: 'delete' },
        ],
      },
    });
    expect(seen[1]?.toolInput).toEqual({
      command: 'curl example.com',
      kind: 'command',
      networkApprovalContext: { host: 'example.com', protocol: 'https' },
    });
    c.finish();
    await pending;
  });

  test('process exit and transport failure withdraw pending approvals', async () => {
    for (const ending of ['exit', 'stdout-closed'] as const) {
      let exit!: (code: number) => void;
      const exited = new Promise<number>((resolve) => {
        exit = resolve;
      });
      const c = codex(codexPermissions('default'), { exited });
      let signal: AbortSignal | undefined;
      let release!: () => void;
      c.session.onToolRequest((request) => {
        signal = request.signal;
        return new Promise((resolve) => {
          release = () => resolve({ behavior: 'allow' });
        });
      });
      await c.session.start();
      const pending = c.session.send('work').catch((error: Error) => error);
      await tick(10);
      c.approval(98, 'item/commandExecution/requestApproval', { command: 'ls' });
      await tick(10);
      expect(signal?.aborted).toBe(false);
      // `exit`: the exit handler runs (then stdout drains); otherwise only stdout closes.
      if (ending === 'exit') exit(1);
      await tick(5);
      c.fake.io.exit(1);
      await tick(10);
      expect(signal?.aborted).toBe(true);
      expect(c.session.alive).toBe(false);
      release();
      await tick(10);
      expect(c.written.some((m) => m.id === 98)).toBe(false);
      expect(await pending).toBeInstanceOf(Error);
    }
  });
});
