import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  ClaudeCodeSession,
  ClaudeInSessionDecisions,
  DecisionError,
  type InSessionSetup,
  type PrimedEvent,
  type PrimeSpec,
  type SessionEvent,
} from '../src';
import { type FakeIo, fakeProcess, tick } from './helpers/fake-process';

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn();
});

type Behavior = {
  /** The main model ignores the setup message. */
  noRoot?: boolean;
  /** A member answers its moment with this (default: `ANS:<input>`). */
  answer?: (input: string) => string | undefined;
  /** A member uses this tool before answering. */
  memberTool?: string;
  /** Concurrent subagents the CLI allows (Claude Code's cap). */
  limit?: number;
  /** Per-frame usage reported for a dispatcher's turns. */
  dispatcherContext?: number;
  /** The root skips its first dispatcher line (a model that did not start it). */
  skipFirstDispatch?: boolean;
  /** `stop_task` is never answered (a CLI that does not acknowledge the stop). */
  ignoreStop?: boolean;
  /** `stop_task` is acknowledged and the task ends this many ms later, or never (default: at once). */
  stopEndsAfterMs?: number | 'never';
};

/**
 * A Claude CLI double for one main session: the main model's turns, nested background agents
 * started through the PreToolUse callback, and the host's SDK MCP server over the control channel.
 */
function mainCli(behavior: Behavior = {}) {
  const argv: string[][] = [];
  const agents: Record<string, any>[] = [];
  const initialize: Record<string, any>[] = [];
  const hookOutputs: Array<{ type: string; description: string; by?: string; output: any }> = [];
  const results: string[] = [];
  const stopped: string[] = [];
  const errors: string[] = [];
  /** The SDK server's answer to the connect the CLI makes before `initialize` is answered. */
  const earlyConnect: unknown[] = [];
  let seq = 0;
  let io!: FakeIo;
  const hooks = new Map<string, (r: any) => void>();
  const mcp = new Map<string, (r: any) => void>();
  const tasks = new Map<string, { toolUseId: string; type: string; token: string }>();
  let hookId = '';
  const control = (request: any) =>
    new Promise<any>((resolve) => {
      const id = `cli-${++seq}`;
      (request.subtype === 'hook_callback' ? hooks : mcp).set(id, resolve);
      io.emit({ type: 'control_request', request_id: id, request });
    });
  const tool = (agentId: string, name: string, args: Record<string, unknown>) =>
    control({
      subtype: 'mcp_message',
      server_name: 'foundry-wardens',
      message: {
        jsonrpc: '2.0',
        id: ++seq,
        method: 'tools/call',
        params: { name, arguments: args },
      },
    }).then((r) => r.mcp_response?.result?.content?.[0]?.text as string);
  const preTool = (agentId: string | undefined, name: string, input: any, toolUseId: string) =>
    control({
      subtype: 'hook_callback',
      callback_id: hookId,
      input: {
        hook_event_name: 'PreToolUse',
        tool_name: name,
        tool_input: input,
        tool_use_id: toolUseId,
        ...(agentId ? { agent_id: agentId } : {}),
      },
    });
  const end = (taskId: string, status: string) => {
    const task = tasks.get(taskId);
    if (!task) return;
    tasks.delete(taskId);
    io.emit({
      type: 'system',
      subtype: 'task_notification',
      task_id: taskId,
      tool_use_id: task.toolUseId,
      status,
      session_id: 'main',
    });
  };
  /** Start an agent through the hook; returns once the hook answered. */
  const spawned = new Map<string, number>();
  let skipped = false;
  const spawn = async (by: string | undefined, type: string, description: string) => {
    const toolUseId = `toolu_${++seq}`;
    if (by) spawned.set(by, (spawned.get(by) ?? 0) + 1);
    if (by)
      io.emit({
        type: 'assistant',
        parent_tool_use_id: tasks.get(by)!.toolUseId,
        session_id: 'main',
        message: {
          role: 'assistant',
          model: 'claude-haiku-5-5',
          content: [{ type: 'tool_use', id: toolUseId, name: 'Agent', input: {} }],
          usage: {
            input_tokens: 1,
            cache_read_input_tokens: (behavior.dispatcherContext ?? 100) * spawned.get(by)!,
          },
        },
      });
    const r = await preTool(
      by,
      'Agent',
      { subagent_type: type, description, prompt: '-' },
      toolUseId,
    );
    const out = r?.hookSpecificOutput;
    hookOutputs.push({ type, description, by, output: out });
    if (out?.permissionDecision !== 'allow') return;
    if (behavior.limit !== undefined && tasks.size >= behavior.limit) {
      io.emit({
        type: 'user',
        parent_tool_use_id: tasks.get(by!)!.toolUseId,
        session_id: 'main',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: toolUseId,
              is_error: true,
              content: 'Concurrent subagent limit reached.',
            },
          ],
        },
      });
      return;
    }
    const taskId = `task_${++seq}`;
    const prompt = out.updatedInput.prompt as string;
    tasks.set(taskId, { toolUseId, type, token: description });
    io.emit({
      type: 'system',
      subtype: 'task_started',
      task_id: taskId,
      tool_use_id: toolUseId,
      task_type: 'local_agent',
      subagent_type: type,
      prompt,
      session_id: 'main',
    });
    void run(taskId, type, prompt);
  };
  /** A member's tool call as the CLI makes it: the PreToolUse hook first, then the input it returned. */
  const memberTool = async (taskId: string, name: string, args: Record<string, unknown>) => {
    const r = await preTool(taskId, `mcp__foundry-wardens__${name}`, args, `toolu_${++seq}`);
    return tool(taskId, name, r?.hookSpecificOutput?.updatedInput ?? args);
  };
  const run = async (taskId: string, type: string, prompt: string) => {
    const token = /token "([^"]+)"/.exec(prompt)?.[1] ?? '';
    if (type === 'foundry-warden') {
      const toolUseId = tasks.get(taskId)!.toolUseId;
      io.emit({
        type: 'assistant',
        parent_tool_use_id: toolUseId,
        session_id: 'main',
        message: {
          role: 'assistant',
          model: 'claude-haiku-5-5',
          content: [{ type: 'text', text: '' }],
          usage: { input_tokens: 5, output_tokens: 1, cache_read_input_tokens: 100 },
        },
      });
      if (behavior.memberTool) {
        const r = await preTool(taskId, behavior.memberTool, {}, `toolu_${++seq}`);
        if (r?.hookSpecificOutput?.permissionDecision === 'deny') return end(taskId, 'completed');
      }
      let input: string;
      if (prompt.includes('Call mcp__foundry-wardens__moment')) {
        const moment = await memberTool(taskId, 'moment', {});
        if (!tasks.has(taskId)) return;
        if (moment?.startsWith('This standby is retired')) return end(taskId, 'completed');
        input = moment;
      } else input = prompt.split('\n\n---\n')[0]!.split('\n').at(-1)!;
      const text = behavior.answer ? behavior.answer(input) : `ANS:${input}`;
      if (text === undefined) return; // holds until stopped
      io.emit({
        type: 'assistant',
        parent_tool_use_id: toolUseId,
        session_id: 'main',
        message: {
          role: 'assistant',
          model: 'claude-haiku-5-5',
          content: [
            {
              type: 'tool_use',
              id: `toolu_${++seq}`,
              name: 'mcp__foundry-wardens__answer',
              input: {},
            },
          ],
          usage: { input_tokens: 2, output_tokens: 7, cache_read_input_tokens: 300 },
        },
      });
      await memberTool(taskId, 'answer', { text });
      return end(taskId, 'completed');
    }
    // A starter: next → spawn every line → next …
    for (;;) {
      if (!tasks.has(taskId)) return;
      const result = await tool(taskId, 'next', { token });
      if (!tasks.has(taskId)) return;
      if (!result || result.startsWith('Foundry is done') || result.startsWith('No agents')) {
        if (result?.startsWith('No agents')) errors.push(`${token}: ${result}`);
        return end(taskId, 'completed');
      }
      for (const line of result.split('\n')) {
        const [t, d] = line.split(' ');
        if (t === 'foundry-dispatch' && behavior.skipFirstDispatch && !skipped) {
          skipped = true;
          continue;
        }
        await spawn(taskId, t!, d!);
      }
    }
  };
  const spawnFn = (cmd: string[]) => {
    argv.push(cmd);
    const at = cmd.indexOf('--agents');
    if (at >= 0) agents.push(JSON.parse(readFileSync(cmd[at + 1]!, 'utf8')));
    const fake = fakeProcess((m, fio) => {
      io = fio;
      if (m.type === 'control_response') {
        const id = m.response.request_id;
        (hooks.get(id) ?? mcp.get(id))?.(m.response.response);
        hooks.delete(id);
        mcp.delete(id);
        return;
      }
      if (m.type === 'control_request') {
        const ok = (response: Record<string, unknown> = {}) =>
          fio.emit({
            type: 'control_response',
            response: { subtype: 'success', request_id: m.request_id, response },
          });
        if (m.request.subtype === 'initialize') {
          initialize.push(m.request);
          hookId = m.request.hooks.PreToolUse[0].hookCallbackIds[0];
          // Claude Code connects the SDK MCP server while `initialize` is still in flight.
          void control({
            subtype: 'mcp_message',
            server_name: 'foundry-wardens',
            message: {
              jsonrpc: '2.0',
              id: 0,
              method: 'initialize',
              params: { protocolVersion: 'p' },
            },
          }).then((r) => {
            earlyConnect.push(r);
          });
          return ok();
        }
        if (m.request.subtype === 'stop_task') {
          stopped.push(m.request.task_id);
          if (behavior.ignoreStop) return;
          ok();
          const after = behavior.stopEndsAfterMs;
          if (after === 'never') return;
          if (after === undefined) return end(m.request.task_id, 'stopped');
          setTimeout(() => end(m.request.task_id, 'stopped'), after);
          return;
        }
        return ok();
      }
      if (m.type !== 'user') return;
      const text = m.message.content[0].text as string;
      void (async () => {
        if (text.includes('internal Foundry setup') && !behavior.noRoot)
          // One builder per description the setup message lists, as the main model starts them.
          for (const [, token] of text
            .slice(text.indexOf('The descriptions:'))
            .matchAll(/"(root\d*)"/g))
            await spawn(undefined, 'foundry-root', token!);
        const reply = text.includes('internal Foundry setup') ? 'READY' : `re:${text}`;
        results.push(reply);
        fio.emit({
          type: 'assistant',
          session_id: 'main',
          message: { role: 'assistant', content: [{ type: 'text', text: reply }] },
        });
        fio.emit({
          type: 'result',
          subtype: 'success',
          result: reply,
          session_id: 'main',
          uuid: `r${++seq}`,
        });
      })();
    });
    io = fake.io;
    return fake.proc;
  };
  /** A task ending on its own (an agent that stopped, an API failure). */
  const endTask = (token: string) => {
    for (const [taskId, task] of tasks) if (task.token === token) end(taskId, 'completed');
  };
  return {
    earlyConnect,
    endTask,
    errors,
    spawn: spawnFn,
    argv,
    agents,
    initialize,
    hookOutputs,
    results,
    stopped,
    tasks,
    preTool,
    spawnAgent: spawn,
  };
}

const spec = (role: string, instructions = `be the ${role} warden`): PrimeSpec => ({
  key: `thread-1:aux:domain:${role}#x`,
  instructions,
  context: `## Domain cache (${role})\nknowledge\n`,
});

async function setup(
  behavior: Behavior = {},
  config: Partial<ConstructorParameters<typeof ClaudeInSessionDecisions>[0]> = {},
) {
  const cli = mainCli(behavior);
  const setups: InSessionSetup[] = [];
  const events: PrimedEvent[] = [];
  const host = new ClaudeInSessionDecisions({
    model: 'claude-haiku-5-5',
    effort: 'low',
    setupDeadlineMs: 2_000,
    onSetup: (s) => setups.push(s),
    onEvent: (e) => events.push(e),
    ...config,
  });
  const session = new ClaudeCodeSession({
    spawn: cli.spawn as never,
    maxTurns: null,
    toolGate: true,
  });
  const seen: SessionEvent[] = [];
  session.onEvent((e) => {
    seen.push(e);
  });
  session.onToolRequest(() => ({ behavior: 'allow' }));
  session.extend(host);
  cleanup.push(() => {
    void host.close();
    session.kill();
  });
  await session.start();
  return { cli, host, session, setups, events, seen };
}

const until = async (cond: () => boolean, ms = 3_000) => {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await tick(5);
  return cond();
};

describe('ClaudeInSessionDecisions', () => {
  afterEach(() => {});
  test('launch carries generic agents, the SDK server and per-task stop', async () => {
    const { cli } = await setup();
    expect(Object.keys(cli.agents[0]!)).toEqual([
      'foundry-root',
      'foundry-dispatch',
      'foundry-warden',
    ]);
    expect(cli.agents[0]!['foundry-warden'].tools).toEqual([
      'mcp__foundry-wardens__moment',
      'mcp__foundry-wardens__answer',
    ]);
    expect(cli.agents[0]!['foundry-warden'].omitClaudeMd).toBe(true);
    expect(cli.initialize[0]).toMatchObject({
      sdkMcpServers: ['foundry-wardens'],
      perTaskStopAffordance: true,
    });
    expect(cli.argv[0]!.join(' ')).not.toContain('--mcp-config');
    // The connect made before `initialize` is answered is answered too (unanswered, it costs a 30 s retry).
    await until(() => cli.earlyConnect.length === 1);
    expect(cli.earlyConnect[0]).toMatchObject({
      mcp_response: { result: { serverInfo: { name: 'foundry-wardens' } } },
    });
  });

  test('setup holds every Warden; decisions are served by spares; the main thread is never woken', async () => {
    const { cli, host, setups, seen } = await setup();
    host.prestart(
      't',
      ['a', 'b', 'c'].map((r) => ({ spec: spec(r), standby: '\n## Your understanding\nnone\n' })),
    );
    await host.ready(3_000);
    expect(host.setup.status).toBe('ready');
    expect(host.setup.wardens).toEqual({ expected: 3, held: 3, failed: [] });
    expect(setups[0]!.status).toBe('starting');
    const started = cli.hookOutputs.length;
    const results = await Promise.all(
      ['a', 'b', 'c'].map((r) =>
        host.decide(spec(r), {
          input: `## Message\nhello ${r}`,
          standby: '\n## Your understanding\nnone\n',
        }),
      ),
    );
    expect(results.map((r) => r.content)).toEqual([
      'ANS:## Message\nhello a',
      'ANS:## Message\nhello b',
      'ANS:## Message\nhello c',
    ]);
    expect(results.every((r) => r.prime === 'warm' && r.model === 'claude-haiku-5-5')).toBe(true);
    // Used spares were started again.
    await until(() => cli.hookOutputs.length >= started + 3);
    expect(cli.hookOutputs.length).toBe(started + 3);
    // One result: the setup turn. No Warden frame reached the session's handlers.
    expect(cli.results).toEqual(['READY']);
    expect(seen.some((e) => e.kind === 'subagent' || e.unattributedReason === 'subagent')).toBe(
      false,
    );
  });

  test('pinned prompts carry the composed text; spawns from elsewhere are denied', async () => {
    const { cli, host } = await setup();
    host.prestart('t', [{ spec: spec('a', 'UNIQUE-INSTRUCTIONS'), standby: 'SB' }]);
    await host.ready(3_000);
    const warden = cli.hookOutputs.find((h) => h.type === 'foundry-warden')!;
    expect(warden.output.updatedInput.prompt).toContain('UNIQUE-INSTRUCTIONS');
    expect(warden.output.updatedInput.prompt).toContain('knowledge\nSB');
    expect(warden.output.updatedInput.run_in_background).toBe(true);
    // The main agent starting a Warden or a dispatcher itself is refused.
    const main = await cli.preTool(
      undefined,
      'Agent',
      { subagent_type: 'foundry-warden', description: 'w1' },
      'toolu_x',
    );
    expect(main.hookSpecificOutput.permissionDecision).toBe('deny');
    // The main agent's own subagents go to the tool gate (no extension opinion).
    const own = await cli.preTool(
      undefined,
      'Agent',
      { subagent_type: 'general-purpose', description: 'x' },
      'toolu_y',
    );
    expect(own.hookSpecificOutput).toBeUndefined();
  });

  test('every spare of a role starts from the same bytes: no token in its prompt, the hook fills it into its calls', async () => {
    const { cli, host } = await setup();
    host.prestart('t', [{ spec: spec('a'), standby: 'SB' }]);
    await host.ready(3_000);
    // Use the held spare, so the role's replacement is started.
    await host.decide(spec('a'), { input: 'M', standby: 'SB' });
    await until(() => cli.hookOutputs.filter((h) => h.type === 'foundry-warden').length >= 2);
    const prompts = cli.hookOutputs
      .filter((h) => h.type === 'foundry-warden')
      .map((h) => h.output.updatedInput.prompt as string);
    expect(new Set(prompts).size).toBe(1);
    expect(prompts[0]).not.toMatch(/token/);
    // The member's own call carries no token; the hook's answer does.
    const live = [...cli.tasks.entries()].find(([, t]) => t.type === 'foundry-warden')!;
    const filled = await cli.preTool(live[0], 'mcp__foundry-wardens__moment', {}, 'toolu_m');
    expect(filled.hookSpecificOutput.updatedInput.token).toBe(live[1].token);
    expect(host.env.CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL).toBe('1h');
  });

  test('setup fans out: builders are the square root of the dispatchers, each starting its own share', async () => {
    const { cli, host } = await setup({}, { dispatchers: 9 });
    host.prestart(
      't',
      Array.from({ length: 9 }, (_, i) => ({ spec: spec(`r${i}`), standby: 'S' })),
    );
    await host.ready(3_000);
    expect(host.setup.status).toBe('ready');
    const roots = [...cli.tasks.values()].filter((t) => t.type === 'foundry-root');
    expect(roots.map((t) => t.token).sort()).toEqual(['root', 'root2', 'root3']);
    expect([...cli.tasks.values()].filter((t) => t.type === 'foundry-dispatch')).toHaveLength(9);
    expect(host.holding()).toEqual({ expected: 9, held: 9 });
    // Each builder started its own three dispatchers.
    const startedBy = new Map<string, number>();
    for (const h of cli.hookOutputs.filter((o) => o.type === 'foundry-dispatch'))
      startedBy.set(h.by ?? '', (startedBy.get(h.by ?? '') ?? 0) + 1);
    expect([...startedBy.values()]).toEqual([3, 3, 3]);
  });

  test('a builder that ends is rebuilt alone: the other builders, their dispatchers and their Wardens stay', async () => {
    const { cli, host } = await setup({}, { dispatchers: 4, maxSetups: 3 });
    host.prestart(
      't',
      Array.from({ length: 4 }, (_, i) => ({ spec: spec(`r${i}`), standby: 'S' })),
    );
    await host.ready(3_000);
    const dispatchersBefore = [...cli.tasks.entries()]
      .filter(([, t]) => t.type === 'foundry-dispatch')
      .map(([id]) => id);
    cli.endTask('root2');
    await until(() => cli.results.length === 2 && host.serving());
    const roots = [...cli.tasks.values()].filter((t) => t.type === 'foundry-root');
    // The first builder is the same task; the second was replaced under a new token.
    expect(roots.map((t) => t.token).sort()).toEqual(['root', 'root3']);
    const dispatchersAfter = [...cli.tasks.entries()]
      .filter(([, t]) => t.type === 'foundry-dispatch')
      .map(([id]) => id);
    // The surviving builder's two dispatchers were never restarted.
    expect(
      dispatchersBefore.filter((id) => dispatchersAfter.includes(id)).length,
    ).toBeGreaterThanOrEqual(2);
    await until(() => host.holding().held === 4);
    expect(host.holding()).toEqual({ expected: 4, held: 4 });
  });

  test('a decision with no spare starts its own member with the input inline', async () => {
    const { host } = await setup();
    host.prestart('t', []);
    await host.ready(3_000);
    const result = await host.decide(spec('z'), { input: 'MSG', standby: 'S' });
    expect(result.prime).toBe('cold');
    expect(result.content).toBe('ANS:SMSG');
  });

  test('a held-only decision is served by a held spare, and refused unsent with none', async () => {
    const { cli, host } = await setup();
    host.prestart('t', [{ spec: spec('a'), standby: 'S' }]);
    await host.ready(3_000);
    const r = await host.decide(spec('a'), { input: 'M', standby: 'S', heldOnly: true });
    expect(r).toMatchObject({ prime: 'warm', content: 'ANS:M' });
    const members = () => cli.hookOutputs.filter((h) => h.type === 'foundry-warden').length;
    await until(() => host.holding().held === 1);
    const before = members();
    // No spare for this role, and one held for another standby: both refused, nothing started.
    for (const [role, standby] of [
      ['z', 'S'],
      ['a', 'other'],
    ] as const) {
      const error = await host
        .decide(spec(role), { input: 'M', standby, heldOnly: true })
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(DecisionError);
      expect(error).toMatchObject({
        reason: 'not-held',
        dispatch: 'not-dispatched',
        settled: true,
      });
    }
    await tick(20);
    expect(members()).toBe(before);
  });

  test('a held-only decision for a role whose spare the CLI refused is refused at once, not started cold', async () => {
    const { cli, host } = await setup({ limit: 4 });
    host.prestart(
      't',
      ['a', 'b', 'c'].map((r) => ({ spec: spec(r), standby: 'S' })),
    );
    await until(() => host.holding().held === 2);
    // Spawned in order: the third member is the one the CLI refused.
    const unheld = 'c';
    const members = cli.hookOutputs.filter((h) => h.type === 'foundry-warden').length;
    const started = Date.now();
    const error = await host
      .decide(spec(unheld), { input: 'M', standby: 'S', heldOnly: true })
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ reason: 'not-held', dispatch: 'not-dispatched' });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(cli.hookOutputs.filter((h) => h.type === 'foundry-warden').length).toBe(members);
    // The spare stays free for its role: still expected, and served once it holds.
    expect(host.holding().expected).toBe(3);
  });

  test('a held-only decision whose held spare is lost before delivery is refused, not started cold', async () => {
    const { cli, host } = await setup();
    host.prestart('t', [{ spec: spec('a'), standby: 'S' }]);
    await host.ready(3_000);
    const member = [...cli.tasks.values()].find((t) => t.type === 'foundry-warden')!;
    const before = cli.hookOutputs.filter((h) => h.type === 'foundry-warden').length;
    // The spare's task ends while the decision is being admitted, before its input is delivered.
    const error = await host
      .decide(spec('a'), {
        input: 'M',
        standby: 'S',
        heldOnly: true,
        onAdmission: async () => {
          cli.endTask(member.token);
          await tick(20);
        },
      })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DecisionError);
    expect(error).toMatchObject({ reason: 'not-held', dispatch: 'not-dispatched', settled: true });
    // Only the replacement spare starts; no member is started for the refused decision.
    await tick(50);
    expect(cli.hookOutputs.filter((h) => h.type === 'foundry-warden').length).toBeLessThanOrEqual(
      before + 1,
    );
  });

  test('a stale standby is replaced, and the old spare retired once the new one holds', async () => {
    const { cli, host } = await setup();
    host.prestart('t', [{ spec: spec('a'), standby: 'v1' }]);
    await host.ready(3_000);
    host.prestart('t', [{ spec: spec('a'), standby: 'v2' }]);
    await until(() => cli.hookOutputs.filter((h) => h.type === 'foundry-warden').length === 2);
    // The v1 spare ends (retired), the v2 one serves.
    await until(
      () => [...cli.tasks.values()].filter((t) => t.type === 'foundry-warden').length === 1,
    );
    expect([...cli.tasks.values()].filter((t) => t.type === 'foundry-warden').length).toBe(1);
    const r = await host.decide(spec('a'), { input: 'M', standby: 'v2' });
    expect(r.prime).toBe('warm');
  });

  test('a member using another tool is denied and its decision fails as a violation', async () => {
    const { host } = await setup({ memberTool: 'Bash' });
    host.prestart('t', []);
    await host.ready(3_000);
    const error = await host.decide(spec('a'), { input: 'M' }).catch((e) => e);
    expect(error.reason).toBe('violation');
  });

  test('a deadline stops a running member through stop_task, never the main thread', async () => {
    const { cli, host } = await setup({ answer: () => undefined });
    host.prestart('t', [{ spec: spec('a'), standby: 'S' }]);
    await host.ready(3_000);
    const error = await host
      .decide(spec('a'), { input: 'M', standby: 'S', timeoutMs: 200 })
      .catch((e) => e);
    expect(error.reason).toBe('timeout');
    expect(error.dispatch).toBe('attempted');
    // Rejected once its task has ended after the stop, so nothing of it runs: settled.
    expect(error.settled).toBe(true);
    expect(cli.stopped.length).toBe(1);
    expect(cli.results).toEqual(['READY']);
  });

  test('a deadline whose stop_task is never acknowledged rejects unsettled', async () => {
    const { cli, host } = await setup({ answer: () => undefined, ignoreStop: true });
    host.prestart('t', [{ spec: spec('a'), standby: 'S' }]);
    await host.ready(3_000);
    const error = await host
      .decide(spec('a'), { input: 'M', standby: 'S', timeoutMs: 200 })
      .catch((e) => e);
    expect(error.reason).toBe('timeout');
    expect(error.dispatch).toBe('attempted');
    expect(error.settled).toBe(false);
    expect(cli.stopped.length).toBe(1);
  });

  test('an acknowledged stop settles only when the task ends, not at the ack', async () => {
    const { host } = await setup({ answer: () => undefined, stopEndsAfterMs: 400 });
    host.prestart('t', [{ spec: spec('a'), standby: 'S' }]);
    await host.ready(3_000);
    const started = Date.now();
    const error = await host
      .decide(spec('a'), { input: 'M', standby: 'S', timeoutMs: 200 })
      .catch((e) => e);
    // The deadline (200) plus the end that follows the ack (400).
    expect(Date.now() - started).toBeGreaterThanOrEqual(550);
    expect(error.reason).toBe('timeout');
    expect(error.settled).toBe(true);
  });

  test('an acknowledged stop whose task never ends rejects unsettled at the stop budget', async () => {
    const { cli, host } = await setup({ answer: () => undefined, stopEndsAfterMs: 'never' });
    host.prestart('t', [{ spec: spec('a'), standby: 'S' }]);
    await host.ready(3_000);
    const error = await host
      .decide(spec('a'), { input: 'M', standby: 'S', timeoutMs: 200 })
      .catch((e) => e);
    expect(error.reason).toBe('timeout');
    expect(error.settled).toBe(false);
    expect(error.message).toContain('its end never seen');
    expect(cli.stopped.length).toBe(1);
  });

  test('an abort after delivery stops the member and rejects settled', async () => {
    const { cli, host } = await setup({ answer: () => undefined });
    host.prestart('t', [{ spec: spec('a'), standby: 'S' }]);
    await host.ready(3_000);
    const controller = new AbortController();
    const decided = host
      .decide(spec('a'), { input: 'M', standby: 'S', timeoutMs: 400, signal: controller.signal })
      .catch((e) => e);
    await Bun.sleep(100);
    controller.abort();
    const error = await decided;
    expect(error.reason).toBe('aborted');
    expect(error.settled).toBe(true);
    expect(cli.stopped.length).toBe(1);
  });

  test('a deadline that passes while an abort stop is pending neither stops nor rejects again', async () => {
    const { cli, host } = await setup({ answer: () => undefined, ignoreStop: true });
    host.prestart('t', [{ spec: spec('a'), standby: 'S' }]);
    await host.ready(3_000);
    const controller = new AbortController();
    let rejections = 0;
    const decided = host
      .decide(spec('a'), { input: 'M', standby: 'S', timeoutMs: 300, signal: controller.signal })
      .catch((e) => {
        rejections++;
        return e;
      });
    await Bun.sleep(100);
    controller.abort();
    // The deadline fires at 300, inside the abort's unanswered stop.
    await Bun.sleep(400);
    expect(cli.stopped.length).toBe(1);
    const error = await decided;
    expect(rejections).toBe(1);
    expect(error.reason).toBe('aborted');
    expect(error.settled).toBe(false);
  });

  test('a main model that never starts the root degrades setup; decisions are refused unsent', async () => {
    const { host } = await setup({ noRoot: true });
    host.prestart('t', [{ spec: spec('a'), standby: 'S' }]);
    await host.ready(3_000);
    expect(host.setup.status).toBe('degraded');
    expect(host.setup.wardens.failed.length).toBe(1);
  });

  test('a dispatcher past its context bound is replaced by a new generation', async () => {
    const { cli, host, events } = await setup(
      { dispatcherContext: 6_000 },
      { recycleTokens: 10_000 },
    );
    host.prestart('t', [{ spec: spec('a'), standby: 'S' }]);
    await host.ready(3_000);
    // Its second member start passes the bound.
    expect((await host.decide(spec('a'), { input: 'M1', standby: 'S' })).content).toBe('ANS:M1');
    await until(() => cli.hookOutputs.filter((h) => h.type === 'foundry-dispatch').length >= 2);
    expect(cli.hookOutputs.filter((h) => h.type === 'foundry-dispatch').length).toBe(2);
    // The old generation retires its spare once the new one holds, then ends into the root.
    await until(() => ![...cli.tasks.values()].some((t) => t.token === 'g1'));
    expect([...cli.tasks.values()].some((t) => t.token === 'g1')).toBe(false);
    expect(events.some((e) => e.type === 'process-recycled')).toBe(true);
    const r = await host.decide(spec('a'), { input: 'M', standby: 'S' });
    expect(r.content).toBe('ANS:M');
    expect(cli.results).toEqual(['READY']);
  });

  test('roles split into fixed slices, one dispatcher each; a fan-out is refilled through every dispatcher at once', async () => {
    const { cli, host } = await setup({}, { dispatchers: 3 });
    const roles = ['a', 'b', 'c', 'd', 'e', 'f'];
    host.prestart(
      't',
      roles.map((r) => ({ spec: spec(r), standby: 'S' })),
    );
    await host.ready(3_000);
    expect(host.setup.status).toBe('ready');
    expect(cli.hookOutputs.filter((h) => h.type === 'foundry-dispatch').length).toBe(3);
    /** Which dispatcher started each member of a role, wave by wave. */
    const startedBy = () => {
      const by = new Map<string, string[]>();
      for (const h of cli.hookOutputs.filter((o) => o.type === 'foundry-warden')) {
        const role = /be the (\w) warden/.exec(h.output?.updatedInput?.prompt ?? '')?.[1];
        if (role) by.set(role, [...(by.get(role) ?? []), h.by!]);
      }
      return by;
    };
    const first = startedBy();
    // Two roles per dispatcher.
    const perDispatcher = new Map<string, number>();
    for (const [, [by]] of first) perDispatcher.set(by!, (perDispatcher.get(by!) ?? 0) + 1);
    expect([...perDispatcher.values()]).toEqual([2, 2, 2]);
    const results = await Promise.all(
      roles.map((r) => host.decide(spec(r), { input: `M ${r}`, standby: 'S' })),
    );
    expect(results.every((r) => r.prime === 'warm')).toBe(true);
    await until(
      () => host.holding().held === 6 && [...startedBy().values()].every((b) => b.length === 2),
    );
    // Each role's replacement came from the same dispatcher as its first member: its slice.
    for (const [role, by] of startedBy())
      expect(by).toEqual([first.get(role)![0]!, first.get(role)![0]!]);
    expect(cli.results).toEqual(['READY']);
  });

  test("a slice's dispatcher past its bound recycles alone; the other slices keep theirs", async () => {
    const { cli, host, events } = await setup(
      { dispatcherContext: 6_000 },
      { recycleTokens: 10_000, dispatchers: 2 },
    );
    host.prestart(
      't',
      ['a', 'b'].map((r) => ({ spec: spec(r), standby: 'S' })),
    );
    await host.ready(3_000);
    expect(cli.hookOutputs.filter((h) => h.type === 'foundry-dispatch').length).toBe(2);
    // Role a's replacement is its dispatcher's second member start: past the bound.
    expect((await host.decide(spec('a'), { input: 'M1', standby: 'S' })).content).toBe('ANS:M1');
    await until(() => cli.hookOutputs.filter((h) => h.type === 'foundry-dispatch').length >= 3);
    await tick(20);
    expect(cli.hookOutputs.filter((h) => h.type === 'foundry-dispatch').length).toBe(3);
    expect(events.filter((e) => e.type === 'process-recycled').length).toBe(1);
    await until(() => host.holding().held === 2);
    expect((await host.decide(spec('b'), { input: 'M2', standby: 'S' })).content).toBe('ANS:M2');
    expect((await host.decide(spec('a'), { input: 'M3', standby: 'S' })).content).toBe('ANS:M3');
    expect(cli.results).toEqual(['READY']);
  });

  test('a decision for a role in no slice starts its member through a live dispatcher', async () => {
    const { host } = await setup({}, { dispatchers: 2 });
    host.prestart('t', [{ spec: spec('a'), standby: 'S' }]);
    await host.ready(3_000);
    const r = await host.decide(spec('z'), { input: 'M', standby: 'S' });
    expect(r).toMatchObject({ prime: 'cold', content: 'ANS:SM' });
  });

  test('dispatchers must be a positive whole number', () => {
    expect(() => new ClaudeInSessionDecisions({ model: 'm', dispatchers: 0 })).toThrow(
      /Invalid in-session decision bounds/,
    );
  });

  test('spawns the CLI refuses go out again once a slot frees', async () => {
    const { cli, host } = await setup({ limit: 4 });
    // root + dispatcher + 2 members fit; the third member is refused.
    host.prestart(
      't',
      ['a', 'b', 'c'].map((r) => ({ spec: spec(r), standby: 'S' })),
    );
    await until(() => host.holding().held === 2);
    expect(host.holding()).toEqual({ expected: 3, held: 2 });
    expect(host.snapshot().capacity).toEqual({ awaitingSlot: 1, orphans: 0, orphanedOut: false });
    // Using a spare frees a slot; its replacement and the refused one are both asked for again.
    expect((await host.decide(spec('a'), { input: 'M', standby: 'S' })).content).toBe('ANS:M');
    await until(
      () =>
        host.holding().held >= 2 &&
        cli.hookOutputs.filter((h) => h.type === 'foundry-warden').length >= 4,
    );
    expect(
      cli.hookOutputs.filter((h) => h.type === 'foundry-warden').length,
    ).toBeGreaterThanOrEqual(4);
    expect(cli.results).toEqual(['READY']);
  });

  test('a dispatcher that dies leaves orphans that still serve but never end into the main thread', async () => {
    const { cli, host } = await setup();
    host.prestart(
      't',
      ['a', 'b'].map((r) => ({ spec: spec(r), standby: 'S' })),
    );
    await host.ready(3_000);
    const wardens = () => [...cli.tasks.values()].filter((t) => t.type === 'foundry-warden').length;
    expect(wardens()).toBe(2);
    cli.endTask('g1');
    // A new dispatcher starts; the orphans count as spares, so no new member is started.
    await until(() => cli.hookOutputs.filter((h) => h.type === 'foundry-dispatch').length === 2);
    await tick(20);
    expect(cli.hookOutputs.filter((h) => h.type === 'foundry-warden').length).toBe(2);
    expect(host.snapshot().capacity).toMatchObject({ orphans: 2, orphanedOut: false });
    // An orphan serves; its answer call is held, so it never ends.
    const r = await host.decide(spec('a'), { input: 'M', standby: 'S' });
    expect(r.content).toBe('ANS:M');
    // The used orphan stays (held in its answer) and the role gets a replacement.
    await until(() => wardens() === 3);
    expect(wardens()).toBe(3);
    // A stale standby retires nothing of an orphan: it stays held, and new spares start.
    host.prestart(
      't',
      ['a', 'b'].map((r) => ({ spec: spec(r), standby: 'S2' })),
    );
    // The replacement ends (retired); both orphans stay; two new spares hold.
    await until(() => host.holding().held === 2 && wardens() === 4);
    expect(wardens()).toBe(4);
    expect(cli.stopped).toEqual([]);
    expect(cli.results).toEqual(['READY']);
    expect(host.serving()).toBe(true);
  });

  test('too many orphans and the session stops serving in-session (its caller falls back)', async () => {
    const { cli, host, events } = await setup({}, { maxOrphans: 2 });
    host.prestart(
      't',
      ['a', 'b', 'c'].map((r) => ({ spec: spec(r), standby: 'S' })),
    );
    await host.ready(3_000);
    cli.endTask('g1');
    await until(() => !host.serving());
    expect(host.serving()).toBe(false);
    expect(host.setup.status).toBe('degraded');
    expect(host.snapshot().capacity).toMatchObject({ orphans: 3, orphanedOut: true });
    expect(events.some((e) => e.type === 'process-recycled' && /orphaned/.test(e.reason))).toBe(
      true,
    );
    expect(cli.results).toEqual(['READY']);
  });

  test('a root that dies is set up again, a bounded number of times', async () => {
    const { cli, host } = await setup({}, { maxSetups: 2 });
    host.prestart('t', [{ spec: spec('a'), standby: 'S' }]);
    await host.ready(3_000);
    cli.endTask('root');
    await until(() => cli.results.length === 2 && host.serving());
    expect(cli.results).toEqual(['READY', 'READY']);
    // The second death (the replacement never takes the first one's token): no third setup turn;
    // decisions are not served in-session.
    cli.endTask('root2');
    await tick(100);
    expect(cli.results).toEqual(['READY', 'READY']);
    expect(host.serving()).toBe(false);
    expect(host.setup.status).toBe('degraded');
  });

  test('close drains members and dispatchers but never ends the root', async () => {
    const { cli, host } = await setup();
    host.prestart(
      't',
      ['a', 'b'].map((r) => ({ spec: spec(r), standby: 'S' })),
    );
    await host.ready(3_000);
    await host.close();
    await until(() => ![...cli.tasks.values()].some((t) => t.type !== 'foundry-root'));
    expect([...cli.tasks.values()].map((t) => t.type)).toEqual(['foundry-root']);
    expect(cli.stopped).toEqual([]);
  });

  test('a skipped dispatcher goes out again; nothing is served until one runs', async () => {
    const { cli, host } = await setup({ skipFirstDispatch: true });
    host.prestart('t', [{ spec: spec('a'), standby: 'S' }]);
    await host.ready(3_000);
    expect(host.setup.status).toBe('ready');
    expect(cli.hookOutputs.filter((h) => h.type === 'foundry-dispatch').length).toBe(1);
    expect(host.serving()).toBe(true);
  });

  test("the main agent cannot stop or message Foundry's agents", async () => {
    const { cli, host } = await setup();
    host.prestart('t', [{ spec: spec('a'), standby: 'S' }]);
    await host.ready(3_000);
    const root = [...cli.tasks.entries()].find(([, t]) => t.type === 'foundry-root')![0];
    const stop = await cli.preTool(undefined, 'TaskStop', { task_id: root }, 'toolu_s');
    expect(stop.hookSpecificOutput.permissionDecision).toBe('deny');
    const other = await cli.preTool(undefined, 'TaskStop', { task_id: 'task_user' }, 'toolu_t');
    expect(other.hookSpecificOutput).toBeUndefined();
  });

  test('user turns run normally alongside held Wardens', async () => {
    const { host, session } = await setup();
    host.prestart('t', [{ spec: spec('a'), standby: 'S' }]);
    await host.ready(3_000);
    const r = await session.send('hello');
    expect(r.content).toBe('re:hello');
  });
});
