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
};

/** A Claude CLI double for the dispatcher: Agent calls through the PreToolUse hook, foreground subagents. */
function dispatcherCli(behavior: Behavior = {}) {
  const spawns: string[][] = [];
  const agents: Record<string, unknown>[] = [];
  const processes: ReturnType<typeof fakeProcess>[] = [];
  const userMessages: { text: string; uuid: string }[] = [];
  const controls: Record<string, unknown>[] = [];
  const subagentInputs: string[] = [];
  let fanOuts = 0;
  const spawn = (argv: string[]) => {
    spawns.push(argv);
    agents.push(JSON.parse(readFileSync(argv[argv.indexOf('--agents') + 1]!, 'utf8')));
    const sid = `side-${spawns.length}`;
    let seq = 0;
    const hookWaiters = new Map<string, (response: any) => void>();
    const running = new Map<string, { toolUseId: string }>();
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
  return { spawn, spawns, agents, processes, userMessages, controls, subagentInputs };
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
      Object.values(cli.agents[0]!)
        .map((a: any) => a.prompt)
        .sort(),
    ).toEqual([
      'BASE\n\nROLE api\n\nCACHE api',
      'BASE\n\nROLE docs\n\nCACHE docs',
      'BASE\n\nROLE tests\n\nCACHE tests',
    ]);
    for (const def of Object.values(cli.agents[0]!) as any[]) expect(def.tools).toEqual([]);
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

  test('deadlines: unsent members are refused; a running subagent is stopped and settles', async () => {
    const cli = dispatcherCli({ hold: (input) => input === 'slow' });
    const { h } = host(cli);
    const error = await h
      .decide(role('slow'), { input: 'slow', group: 'T1', timeoutMs: 150 })
      .catch((e) => e);
    expect(error).toMatchObject({ reason: 'timeout', dispatch: 'attempted', settled: true });
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
