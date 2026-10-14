import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { ClaudeSubagentSessions, type PrimedEvent } from '../src';
import { fakeProcess, tick } from './helpers/fake-process';

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn();
});

type Behavior = {
  /** Members the dispatcher leaves out of its calls (by agent name), per fan-out index. */
  skip?: (name: string, fanOut: number) => boolean;
  /** The prompt the dispatcher writes into its Agent call (the hook replaces it). */
  prompt?: string;
  /** A subagent that never answers. */
  hold?: (input: string) => boolean;
  /** A subagent that uses a tool. */
  tool?: (input: string) => boolean;
  /** An extra Agent call for a name nobody listed. */
  stray?: boolean;
  /** A pre-started subagent that uses a tool before its moment. */
  standbyTool?: boolean;
  /** A pre-started subagent calls its moment tool this late. */
  standbyDelayMs?: number;
};

/** A Claude CLI double for the dispatcher: Agent calls through the PreToolUse hook, foreground subagents. */
function dispatcherCli(behavior: Behavior = {}) {
  const spawns: string[][] = [];
  const agents: Record<string, unknown>[] = [];
  const processes: ReturnType<typeof fakeProcess>[] = [];
  const userMessages: { text: string; uuid: string }[] = [];
  const controls: Record<string, unknown>[] = [];
  const subagentInputs: string[] = [];
  const standbyPrompts: string[] = [];
  const momentInputs: string[] = [];
  let fanOuts = 0;
  const spawn = (argv: string[]) => {
    spawns.push(argv);
    agents.push(JSON.parse(readFileSync(argv[argv.indexOf('--agents') + 1]!, 'utf8')));
    const sid = `side-${spawns.length}`;
    let seq = 0;
    const hookWaiters = new Map<string, (response: any) => void>();
    const running = new Map<string, { toolUseId: string }>();
    /** Pre-started subagents holding a moment call. */
    const waiting = new Map<string, { toolUseId: string }>();
    let turnOpen = false;
    const fake = fakeProcess((m, io) => {
      if (m.type === 'control_response') {
        hookWaiters.get(m.response.request_id)?.(m.response.response);
        return;
      }
      if (m.type === 'control_request') {
        controls.push(m.request);
        const ok = (response: Record<string, unknown> = {}) =>
          io.emit({
            type: 'control_response',
            response: { subtype: 'success', request_id: m.request_id, response },
          });
        if (m.request.subtype === 'rewind_conversation') return ok({ rewound: true });
        if (m.request.subtype === 'interrupt') {
          ok();
          for (const [taskId, task] of waiting) {
            waiting.delete(taskId);
            io.emit({
              type: 'system',
              subtype: 'task_notification',
              task_id: taskId,
              tool_use_id: task.toolUseId,
              status: 'killed',
              session_id: sid,
            });
          }
          if (turnOpen) {
            turnOpen = false;
            io.emit({
              type: 'result',
              subtype: 'error_during_execution',
              session_id: sid,
              uuid: `r${++seq}`,
            });
          }
          return;
        }
        if (m.request.subtype === 'stop_task') {
          ok();
          const task = running.get(m.request.task_id);
          if (task) {
            running.delete(m.request.task_id);
            io.emit({
              type: 'system',
              subtype: 'task_notification',
              task_id: m.request.task_id,
              tool_use_id: task.toolUseId,
              status: 'stopped',
              session_id: sid,
            });
          }
          return;
        }
        return ok();
      }
      if (m.type !== 'user') return;
      const fanOut = fanOuts++;
      userMessages.push({ text: m.message.content, uuid: m.uuid });
      turnOpen = true;
      const lines = (m.message.content as string).split('\n').map((l) => l.split(' '));
      const calls = lines.filter(([name]) => !behavior.skip?.(name!, fanOut));
      if (behavior.stray) calls.push(['d-nobody', 'mzzz']);
      void (async () => {
        let pending = calls.length;
        const done = () => {
          if (--pending === 0 && turnOpen) {
            turnOpen = false;
            io.emit({
              type: 'assistant',
              session_id: sid,
              message: { role: 'assistant', content: [{ type: 'text', text: 'DONE' }] },
            });
            io.emit({ type: 'result', subtype: 'success', session_id: sid, uuid: `r${++seq}` });
          }
        };
        if (!calls.length) {
          pending = 1;
          done();
        }
        for (const [name, token] of calls) {
          const toolUseId = `toolu_${++seq}`;
          const input = { subagent_type: name, description: token, prompt: behavior.prompt ?? '-' };
          io.emit({
            type: 'assistant',
            session_id: sid,
            message: {
              role: 'assistant',
              content: [{ type: 'tool_use', id: toolUseId, name: 'Agent', input }],
            },
          });
          const requestId = `hook-${seq}`;
          const response = await new Promise<any>((resolve) => {
            hookWaiters.set(requestId, resolve);
            io.emit({
              type: 'control_request',
              request_id: requestId,
              request: {
                subtype: 'hook_callback',
                callback_id: 'members',
                input: { tool_name: 'Agent', tool_input: input, tool_use_id: toolUseId },
              },
            });
          });
          const out = response.hookSpecificOutput;
          if (out.permissionDecision !== 'allow') {
            io.emit({
              type: 'user',
              session_id: sid,
              message: {
                role: 'user',
                content: [
                  {
                    type: 'tool_result',
                    tool_use_id: toolUseId,
                    content: 'denied',
                    is_error: true,
                  },
                ],
              },
            });
            done();
            continue;
          }
          const prompt = out.updatedInput.prompt as string;
          subagentInputs.push(prompt);
          const taskId = `task-${seq}`;
          io.emit({
            type: 'system',
            subtype: 'task_started',
            task_id: taskId,
            tool_use_id: toolUseId,
            subagent_type: name,
            prompt,
            session_id: sid,
          });
          const standby = /Call the mcp__foundry__moment tool now with token "([^"]+)"/.exec(
            prompt,
          );
          if (standby) {
            standbyPrompts.push(prompt);
            io.emit({
              type: 'assistant',
              parent_tool_use_id: toolUseId,
              session_id: sid,
              message: {
                role: 'assistant',
                content: [
                  behavior.standbyTool
                    ? { type: 'tool_use', id: 'b', name: 'Bash', input: {} }
                    : {
                        type: 'tool_use',
                        id: `mc${seq}`,
                        name: 'mcp__foundry__moment',
                        input: { token: standby[1] },
                      },
                ],
              },
            });
            waiting.set(taskId, { toolUseId });
            const rpc = `mcp-${++seq}`;
            void new Promise<any>((resolve) => {
              hookWaiters.set(rpc, resolve);
              const call = () =>
                io.emit({
                  type: 'control_request',
                  request_id: rpc,
                  request: {
                    subtype: 'mcp_message',
                    server_name: 'foundry',
                    message: {
                      jsonrpc: '2.0',
                      id: seq,
                      method: 'tools/call',
                      params: { name: 'moment', arguments: { token: standby[1] } },
                    },
                  },
                });
              if (behavior.standbyDelayMs) setTimeout(call, behavior.standbyDelayMs);
              else call();
            }).then((response) => {
              if (!waiting.has(taskId)) return;
              waiting.delete(taskId);
              const moment = response.mcp_response.result.content[0].text as string;
              momentInputs.push(moment);
              io.emit({
                type: 'assistant',
                parent_tool_use_id: toolUseId,
                session_id: sid,
                message: {
                  role: 'assistant',
                  model: 'claude-test',
                  content: [{ type: 'text', text: `decided: ${moment}` }],
                  usage: {
                    input_tokens: 2,
                    output_tokens: 3,
                    cache_read_input_tokens: 5000,
                    cache_creation_input_tokens: 0,
                  },
                },
              });
              io.emit({
                type: 'system',
                subtype: 'task_notification',
                task_id: taskId,
                tool_use_id: toolUseId,
                status: 'completed',
                session_id: sid,
              });
              io.emit({
                type: 'user',
                session_id: sid,
                message: {
                  role: 'user',
                  content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'hand-back' }],
                },
              });
              done();
            });
            continue;
          }
          if (behavior.hold?.(prompt)) {
            running.set(taskId, { toolUseId });
            continue;
          }
          setTimeout(() => {
            const content = behavior.tool?.(prompt)
              ? [{ type: 'tool_use', id: 'x', name: 'Bash', input: {} }]
              : [{ type: 'text', text: `decided: ${prompt}` }];
            io.emit({
              type: 'assistant',
              parent_tool_use_id: toolUseId,
              session_id: sid,
              message: {
                role: 'assistant',
                model: 'claude-test',
                content,
                usage: {
                  input_tokens: 2,
                  output_tokens: 3,
                  cache_read_input_tokens: 4000,
                  cache_creation_input_tokens: 100,
                },
              },
            });
            io.emit({
              type: 'system',
              subtype: 'task_notification',
              task_id: taskId,
              tool_use_id: toolUseId,
              status: 'completed',
              session_id: sid,
            });
            io.emit({
              type: 'user',
              session_id: sid,
              message: {
                role: 'user',
                content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'hand-back' }],
              },
            });
            done();
          }, 5);
        }
      })();
    });
    processes.push(fake);
    return fake.proc;
  };
  return {
    spawn,
    spawns,
    agents,
    processes,
    userMessages,
    controls,
    subagentInputs,
    standbyPrompts,
    momentInputs,
  };
}

function host(
  cli: ReturnType<typeof dispatcherCli>,
  extra: Partial<ConstructorParameters<typeof ClaudeSubagentSessions>[0]> = {},
) {
  const events: PrimedEvent[] = [];
  const h = new ClaudeSubagentSessions({
    model: 'haiku',
    cwd: '/private/claude-decisions',
    spawn: cli.spawn,
    baseInstructions: 'BASE',
    onEvent: (e) => events.push(e),
    timeoutMs: 2_000,
    batchWindowMs: 10,
    ...extra,
  });
  cleanup.push(() => h.close());
  return { h, events };
}

const role = (domain: string) => ({
  key: `k-${domain}`,
  instructions: `ROLE ${domain}`,
  context: `CACHE ${domain}`,
});

describe('ClaudeSubagentSessions', () => {
  test('decisions of one group fan out in one turn; each subagent receives exactly its input', async () => {
    const cli = dispatcherCli({ prompt: 'the dispatcher wrote this' });
    const { h } = host(cli);
    const [a, b, c] = await Promise.all(
      ['api', 'docs', 'tests'].map((d) =>
        h.decide(role(d), { input: `moment for ${d}`, group: 'T1' }),
      ),
    );
    expect([a!.content, b!.content, c!.content]).toEqual([
      'decided: moment for api',
      'decided: moment for docs',
      'decided: moment for tests',
    ]);
    expect(a).toMatchObject({ model: 'claude-test', prime: 'warm', tokens: { cacheRead: 4000 } });
    expect(cli.spawns).toHaveLength(1);
    expect(cli.userMessages).toHaveLength(1);
    expect(cli.subagentInputs.sort()).toEqual([
      'moment for api',
      'moment for docs',
      'moment for tests',
    ]);
    // Each role is an agent whose system prompt is the base, its instructions and its stable context.
    expect(
      Object.values(cli.agents[0]! as Record<string, any>)
        .filter((a) => a.tools.length === 0)
        .map((a: any) => a.prompt)
        .sort(),
    ).toEqual([
      'BASE\n\nROLE api\n\nCACHE api',
      'BASE\n\nROLE docs\n\nCACHE docs',
      'BASE\n\nROLE tests\n\nCACHE tests',
    ]);
    const defs = Object.values(cli.agents[0]!) as any[];
    // Each role also has a pre-started variant whose only tool is the moment.
    expect(defs.filter((d) => d.tools.length === 0)).toHaveLength(3);
    expect(defs.filter((d) => d.tools[0] === 'mcp__foundry__moment')).toHaveLength(3);
    const argv = cli.spawns[0]!;
    expect(argv).toEqual(expect.arrayContaining(['--tools', 'Agent', '--no-session-persistence']));
    // The dispatcher's wrap-up is cut short and its turn rewound to before the fan-out.
    await tick(30);
    expect(cli.controls.find((c) => c.subtype === 'rewind_conversation')).toMatchObject({
      target_message_uuid: cli.userMessages[0]!.uuid,
    });
  });

  test('groups get their own side sessions; a large batch splits evenly across side sessions', async () => {
    const cli = dispatcherCli();
    const { h } = host(cli, { maxMembers: 2 });
    await Promise.all([
      ...['a', 'b', 'c', 'd', 'e'].map((d) => h.decide(role(d), { input: d, group: 'T1' })),
      h.decide(role('a'), { input: 'other thread', group: 'T2' }),
    ]);
    expect(cli.spawns).toHaveLength(4); // T1: 5 members as 2 + 2 + 1, T2: 1
    expect(cli.userMessages.map((m) => m.text.split('\n').length).sort()).toEqual([1, 1, 2, 2]);
    await tick(30);
    expect(h.snapshot()).toMatchObject({ sessions: 4, active: 0 });
  });

  test('a side session is reused while it holds the definitions, and replaced when they change', async () => {
    const cli = dispatcherCli();
    const { h } = host(cli, { maxSessionsPerGroup: 1 });
    await h.decide(role('api'), { input: 'one', group: 'T1' });
    await h.decide(role('api'), { input: 'two', group: 'T1' });
    expect(cli.spawns).toHaveLength(1);
    await h.decide({ ...role('api'), context: 'CACHE api v2' }, { input: 'three', group: 'T1' });
    expect(cli.spawns).toHaveLength(2);
    expect(cli.processes[0]!.killed).toBe(true);
  });

  test('a member the dispatcher skipped is sent once more, then refused unsent', async () => {
    const cli = dispatcherCli({
      skip: (name, fanOut) => fanOut === 0 && name.length > 0 && name === skipName,
    });
    let skipName = '';
    const { h } = host(cli);
    const once = role('once');
    skipName = `d-${new Bun.CryptoHasher('sha256').update(`BASE\n\n${once.instructions}\n\n${once.context}`).digest('hex').slice(0, 16)}`;
    const [skipped, kept] = await Promise.all([
      h.decide(once, { input: 'retried', group: 'T1' }),
      h.decide(role('kept'), { input: 'kept', group: 'T1' }),
    ]);
    expect(skipped.content).toBe('decided: retried');
    expect(kept.content).toBe('decided: kept');
    expect(cli.userMessages).toHaveLength(2);

    const never = dispatcherCli({ skip: () => true });
    const { h: h2 } = host(never);
    await expect(h2.decide(role('x'), { input: 'x', group: 'T1' })).rejects.toMatchObject({
      reason: 'transport',
      dispatch: 'not-dispatched',
    });
    expect(never.userMessages).toHaveLength(2);
  });

  test('calls nobody listed are denied; admission refusal sends nothing for that member', async () => {
    const cli = dispatcherCli({ stray: true });
    const { h } = host(cli);
    const [refused, ok] = await Promise.all([
      h
        .decide(role('refused'), {
          input: 'no',
          group: 'T1',
          onAdmission: () => {
            throw Error('no');
          },
        })
        .catch((e) => e),
      h.decide(role('ok'), { input: 'yes', group: 'T1' }),
    ]);
    expect(refused).toMatchObject({ reason: 'admission', dispatch: 'not-dispatched' });
    expect(ok.content).toBe('decided: yes');
    expect(cli.userMessages[0]!.text).not.toContain('refused');
    expect(cli.subagentInputs).toEqual(['yes']);
  });

  test('deadlines: unsent members are refused; a running subagent is rejected on time and stopped', async () => {
    const cli = dispatcherCli({ hold: (input) => input === 'slow' });
    const { h } = host(cli);
    const error = await h
      .decide(role('slow'), { input: 'slow', group: 'T1', timeoutMs: 150 })
      .catch((e) => e);
    // Rejected at its deadline, not after the stop: the stop follows.
    expect(error).toMatchObject({ reason: 'timeout', dispatch: 'attempted', settled: false });
    await tick(30);
    expect(cli.controls.some((c) => c.subtype === 'stop_task')).toBe(true);
    const unsent = await h
      .decide(role('late'), { input: 'late', group: 'T1', timeoutMs: 1 })
      .catch((e) => e);
    expect(unsent).toMatchObject({ reason: 'timeout', dispatch: 'not-dispatched' });
  });

  test('tool activity in a subagent is a violation', async () => {
    const cli = dispatcherCli({ tool: (input) => input === 'bad' });
    const { h, events } = host(cli);
    await expect(h.decide(role('bad'), { input: 'bad', group: 'T1' })).rejects.toMatchObject({
      reason: 'violation',
    });
    expect(events.some((e) => e.type === 'violation')).toBe(true);
  });

  test('a hung admission does not hold the other members past their deadlines', async () => {
    const cli = dispatcherCli();
    const { h } = host(cli);
    const started = Date.now();
    const [hung, ok] = await Promise.all([
      h
        .decide(role('hung'), {
          input: 'hung',
          group: 'T1',
          timeoutMs: 200,
          onAdmission: () => new Promise(() => {}),
        })
        .catch((e) => e),
      h.decide(role('ok'), { input: 'ok', group: 'T1' }),
    ]);
    expect(ok.content).toBe('decided: ok');
    expect(hung).toMatchObject({ reason: 'timeout', dispatch: 'not-dispatched' });
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  test('a side session that fails to start is stopped; a launcher that throws refuses the chunk', async () => {
    let fail = true;
    const cli = dispatcherCli();
    const silent = (argv: string[]) => {
      if (!fail) return cli.spawn(argv);
      fail = false;
      return fakeProcess(() => {}).proc; // never answers initialize
    };
    const { h, events } = host({ ...cli, spawn: silent }, { timeoutMs: 300 });
    await expect(h.decide(role('a'), { input: 'a', group: 'T1' })).rejects.toBeInstanceOf(Error);
    const { h: h2 } = host(cli, {
      spawn: () => {
        throw Error('no claude binary');
      },
    });
    await expect(h2.decide(role('b'), { input: 'b', group: 'T1' })).rejects.toMatchObject({
      reason: 'transport',
      dispatch: 'not-dispatched',
    });
    expect(events.filter((e) => e.type === 'process-started')).toHaveLength(0);
  });

  test('pre-started members answer at once: the decision only answers their held moment call', async () => {
    const cli = dispatcherCli();
    const { h, events } = host(cli);
    const roles = ['api', 'docs', 'tests'].map(role);
    h.prestart(
      'T1',
      roles.map((spec) => ({ spec, standby: 'THREAD v1\n' })),
    );
    await tick(60);
    // One standby turn per copy of the roles, each in its own side session, off any decision's path.
    expect(cli.userMessages).toHaveLength(2);
    expect(cli.processes).toHaveLength(2);
    expect(cli.standbyPrompts.every((p) => p.startsWith('THREAD v1\n'))).toBe(true);
    // Every role is a standby variant whose only tool is the moment.
    const defs = cli.agents[0]! as Record<string, any>;
    expect(Object.values(defs).filter((d) => d.tools[0] === 'mcp__foundry__moment')).toHaveLength(
      3,
    );
    const results = await Promise.all(
      roles.map((spec, i) =>
        h.decide(spec, { input: `moment ${i}`, group: 'T1', standby: 'THREAD v1\n' }),
      ),
    );
    expect(results.map((r) => r.content)).toEqual([
      'decided: moment 0',
      'decided: moment 1',
      'decided: moment 2',
    ]);
    expect(cli.momentInputs.sort()).toEqual(['moment 0', 'moment 1', 'moment 2']);
    expect(cli.subagentInputs.filter((p) => p.startsWith('moment'))).toEqual([]); // no fan-out for them
    // The decisions emptied one side session's standby turn, which is rewound and pre-started again;
    // the other copy kept holding.
    await tick(80);
    expect(cli.controls.some((c) => c.subtype === 'rewind_conversation')).toBe(true);
    expect(cli.standbyPrompts).toHaveLength(9);
    // The emptied side session is reused for its refill: no process is started for it.
    expect(cli.processes).toHaveLength(2);
    expect(events.filter((e) => e.type === 'process-started')).toHaveLength(2);
  });

  test('a decision whose standby context differs fans out with the standby in front of its input', async () => {
    const cli = dispatcherCli();
    const { h } = host(cli);
    h.prestart('T1', [{ spec: role('api'), standby: 'THREAD v1\n' }]);
    await tick(60);
    const r = await h.decide(role('api'), { input: 'moment', group: 'T1', standby: 'THREAD v2\n' });
    expect(r.content).toBe('decided: THREAD v2\nmoment');
    expect(cli.momentInputs).toEqual([]);
  });

  test('new standby context replaces the spares; the old standby turn ends', async () => {
    const cli = dispatcherCli();
    const { h } = host(cli);
    h.prestart('T1', [{ spec: role('api'), standby: 'THREAD v1\n' }]);
    await tick(60);
    h.prestart('T1', [{ spec: role('api'), standby: 'THREAD v2\n' }]);
    await tick(120);
    expect(cli.controls.some((c) => c.subtype === 'interrupt')).toBe(true);
    const r = await h.decide(role('api'), { input: 'moment', group: 'T1', standby: 'THREAD v2\n' });
    expect(r.content).toBe('decided: moment');
    expect(cli.momentInputs).toEqual(['moment']);
  });

  test('a reserved spare whose decision expires before its moment stays pre-started', async () => {
    const cli = dispatcherCli({ standbyDelayMs: 100 });
    const { h } = host(cli);
    h.prestart('T1', [{ spec: role('api'), standby: 'S\n' }]);
    // Reserved immediately, while the spare is still starting; it expires unsent.
    const late = await h
      .decide(role('api'), { input: 'late', group: 'T1', standby: 'S\n', timeoutMs: 30 })
      .catch((e) => e);
    expect(late).toMatchObject({ reason: 'timeout', dispatch: 'not-dispatched' });
    await tick(150);
    const r = await h.decide(role('api'), { input: 'next', group: 'T1', standby: 'S\n' });
    expect(r.content).toBe('decided: next');
    expect(cli.momentInputs).toEqual(['next']);
  });

  test('a pre-started member that acts before its moment is never used', async () => {
    const cli = dispatcherCli({ standbyTool: true });
    const { h } = host(cli);
    h.prestart('T1', [{ spec: role('api'), standby: 'S\n' }]);
    await tick(60);
    const r = await h.decide(role('api'), { input: 'moment', group: 'T1', standby: 'S\n' });
    expect(r.content).toBe('decided: S\nmoment'); // served by a fan-out instead
  });

  test('releasing a group stops its pre-started members and side sessions', async () => {
    const cli = dispatcherCli();
    const { h } = host(cli);
    h.prestart('T1', [{ spec: role('api'), standby: 'S\n' }]);
    await tick(60);
    await h.releaseGroup('T1');
    expect(cli.processes.every((p) => p.killed || p.closed)).toBe(true);
    expect(h.snapshot().sessions).toBe(0);
  });

  test('a held moment is answered only after admission; a refused admission sends nothing', async () => {
    const cli = dispatcherCli();
    const { h } = host(cli);
    h.prestart('T1', [{ spec: role('api'), standby: 'S\n' }]);
    await tick(60);
    let admitted = false;
    const ok = h.decide(role('api'), {
      input: 'slow admission',
      group: 'T1',
      standby: 'S\n',
      onAdmission: async () => {
        await Bun.sleep(60);
        expect(cli.momentInputs).toEqual([]);
        admitted = true;
      },
    });
    expect((await ok).content).toBe('decided: slow admission');
    expect(admitted).toBe(true);
    await tick(80);
    const refused = await h
      .decide(role('api'), {
        input: 'refused',
        group: 'T1',
        standby: 'S\n',
        onAdmission: () => {
          throw Error('no');
        },
      })
      .catch((e) => e);
    expect(refused).toMatchObject({ reason: 'admission', dispatch: 'not-dispatched' });
    expect(cli.momentInputs).toEqual(['slow admission']);
  });

  test('a reserved spare that never calls in hands its decision to a fan-out, standby included', async () => {
    const cli = dispatcherCli({ standbyDelayMs: 10_000 });
    const { h } = host(cli, { timeoutMs: 5_000 });
    h.prestart('T1', [{ spec: role('api'), standby: 'S\n' }]);
    await tick(40);
    const r = await h.decide(role('api'), { input: 'moment', group: 'T1', standby: 'S\n' });
    expect(r.content).toBe('decided: S\nmoment');
  });

  test('decisions without a spare do not start duplicate pre-starts', async () => {
    const cli = dispatcherCli({ standbyDelayMs: 200 });
    const { h } = host(cli);
    h.prestart(
      'T1',
      ['a', 'b'].map((d) => ({ spec: role(d), standby: 'S\n' })),
    );
    await Promise.all(
      ['x', 'y', 'z'].map((d) => h.decide(role(d), { input: d, group: 'T1', standby: 'S\n' })),
    );
    await tick(50);
    expect(cli.standbyPrompts).toHaveLength(4); // two copies of each pre-started role, no more
  });

  test('copies of a role sit in different side sessions; a trigger empties one copy, the other serves while it refills', async () => {
    const cli = dispatcherCli();
    const { h } = host(cli);
    const roles = ['api', 'docs', 'tests'].map(role);
    h.prestart(
      'T1',
      roles.map((spec) => ({ spec, standby: 'S\n' })),
    );
    await tick(60);
    expect(cli.processes).toHaveLength(2);
    // Each standby turn lists every role once: copies never share a side session.
    for (const m of cli.userMessages) expect(m.text.split('\n')).toHaveLength(3);
    // A guard on one role takes one spare; its side session is released and pre-started again.
    expect((await h.decide(roles[0]!, { input: 'g1', group: 'T1', standby: 'S\n' })).content).toBe(
      'decided: g1',
    );
    // The next guard right away is served by the other copy, not a fan-out.
    expect((await h.decide(roles[0]!, { input: 'g2', group: 'T1', standby: 'S\n' })).content).toBe(
      'decided: g2',
    );
    expect(cli.momentInputs.sort()).toEqual(['g1', 'g2']);
    expect(cli.subagentInputs.filter((p) => p.startsWith('g'))).toEqual([]);
    await tick(150);
    // Used copies refill in a side session of their own while the partly used ones keep serving,
    // within the cap: both copy sets plus two refill side sessions.
    expect(cli.processes.length).toBeLessThanOrEqual(4);
    // Staggered: api is held again, so a third guard is served at once too.
    expect((await h.decide(roles[0]!, { input: 'g3', group: 'T1', standby: 'S\n' })).content).toBe(
      'decided: g3',
    );
    expect(cli.momentInputs.sort()).toEqual(['g1', 'g2', 'g3']);
  });

  test('fan-outs run in their own side sessions and never take a standby one', async () => {
    const cli = dispatcherCli();
    const { h } = host(cli);
    h.prestart('T1', [{ spec: role('api'), standby: 'S\n' }]);
    await tick(60);
    expect(cli.processes).toHaveLength(2);
    // A role with no spare fans out: a third process, while both standby turns keep holding.
    const r = await h.decide(role('review'), { input: 'after the turn', group: 'T1' });
    expect(r.content).toBe('decided: after the turn');
    expect(cli.processes).toHaveLength(3);
    const held = await h.decide(role('api'), { input: 'moment', group: 'T1', standby: 'S\n' });
    expect(held.content).toBe('decided: moment');
    expect(cli.momentInputs).toEqual(['moment']);
  });

  test('close refuses waiting decisions and stops the side sessions', async () => {
    const cli = dispatcherCli({ hold: () => true });
    const { h } = host(cli, { timeoutMs: 5_000 });
    const running = h.decide(role('a'), { input: 'a', group: 'T1' }).catch((e) => e);
    await tick(40);
    await h.close();
    expect(await running).toBeInstanceOf(Error);
    expect(cli.processes.every((p) => p.killed || p.closed)).toBe(true);
    await expect(h.decide(role('a'), { input: 'a', group: 'T1' })).rejects.toMatchObject({
      reason: 'closed',
    });
  });
});
