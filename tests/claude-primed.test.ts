import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  CLAUDE_DECISION_CACHE_ENV,
  CLAUDE_TEXT_ONLY_ARGS,
  ClaudePrimedSessions,
  nativeModelMissing,
  type PrimedEvent,
} from '../src';
import { type FakeIo, fakeProcess, tick } from './helpers/fake-process';

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn();
});

/** Claude CLI double: each process is one conversation with its own session id. */
function claudeCli(
  opts: {
    behavior?: (input: string) => 'answer' | 'tool' | 'hold' | 'limited' | 'missing';
    usage?: () => number;
  } = {},
) {
  const spawns: string[][] = [];
  const environments: Record<string, string | undefined>[] = [];
  /** Each spawn's appended system prompt, read while its file exists. */
  const systemPrompts: (string | undefined)[] = [];
  const processes: ReturnType<typeof fakeProcess>[] = [];
  const spawn = (argv: string[], options: { env: Record<string, string | undefined> }) => {
    spawns.push(argv);
    environments.push(options.env);
    const file = argv.indexOf('--append-system-prompt-file');
    systemPrompts.push(file >= 0 ? readFileSync(argv[file + 1]!, 'utf8') : undefined);
    const sid = `sid-${spawns.length}`;
    const fake = fakeProcess((m, io) => {
      if (m.type === 'control_request') {
        if (m.request.subtype === 'get_usage')
          io.emit({
            type: 'control_response',
            response: {
              subtype: 'success',
              request_id: m.request_id,
              response: {
                rate_limits_available: true,
                rate_limits: {
                  five_hour: {
                    utilization: opts.usage?.() ?? 10,
                    resets_at: '2099-01-01T00:00:00Z',
                  },
                },
              },
            },
          });
        if (m.request.subtype === 'interrupt') {
          io.emit({
            type: 'control_response',
            response: { subtype: 'success', request_id: m.request_id, response: {} },
          });
          io.emit({
            type: 'result',
            subtype: 'error_during_execution',
            is_error: true,
            uuid: `int-${sid}`,
            session_id: sid,
            result: '',
          });
        }
        return;
      }
      if (m.type !== 'user') return;
      respond(m, io);
    });
    const respond = (m: any, io: FakeIo) => {
      const input = m.message.content[0].text as string;
      io.emit({ type: 'system', subtype: 'init', session_id: sid, model: 'claude-test' });
      const behavior = opts.behavior?.(input) ?? 'answer';
      if (behavior === 'hold') return;
      if (behavior === 'tool')
        io.emit({
          type: 'assistant',
          session_id: sid,
          message: {
            id: 't',
            model: 'claude-test',
            role: 'assistant',
            content: [{ type: 'tool_use', id: 'tu', name: 'Bash', input: {} }],
          },
        });
      if (behavior === 'missing') {
        // Recorded from Claude Code 2.1.325 for a retired model.
        const text =
          "There's an issue with the selected model (claude-3-opus-20240229). It may not exist or you may not have access to it. Run --model to pick a different model.";
        io.emit({
          type: 'assistant',
          session_id: sid,
          error: 'model_not_found',
          is_api_error_message: true,
          api_error_status: 404,
          api_error_type: 'not_found_error',
          message: {
            id: `m-${sid}`,
            model: '<synthetic>',
            role: 'assistant',
            content: [{ type: 'text', text }],
            usage: { input_tokens: 0, output_tokens: 0 },
          },
        });
        io.emit({
          type: 'result',
          subtype: 'success',
          is_error: true,
          terminal_reason: 'api_error',
          api_error_status: 404,
          api_error_type: 'not_found_error',
          uuid: `r-${sid}`,
          session_id: sid,
          result: text,
        });
        return;
      }
      if (behavior === 'limited') {
        io.emit({
          type: 'rate_limit_event',
          session_id: sid,
          rate_limit_info: {
            status: 'rejected',
            rateLimitType: 'five_hour',
            utilization: 1,
            resetsAt: 4_000_000_000,
          },
        });
        io.emit({
          type: 'result',
          subtype: 'error_during_execution',
          is_error: true,
          api_error_status: 429,
          uuid: `r-${sid}`,
          session_id: sid,
          result: 'rate limit',
        });
        return;
      }
      const text = `decided: ${input}`;
      io.emit({
        type: 'assistant',
        session_id: sid,
        message: {
          id: `m-${sid}`,
          model: 'claude-test',
          role: 'assistant',
          content: [{ type: 'text', text }],
          usage: { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 8000 },
        },
      });
      io.emit({
        type: 'result',
        subtype: 'success',
        uuid: `r-${sid}`,
        session_id: sid,
        result: text,
        usage: {
          input_tokens: 10,
          output_tokens: 2,
          cache_read_input_tokens: 8000,
          cache_creation_input_tokens: 0,
        },
      });
    };
    processes.push(fake);
    return fake.proc;
  };
  return { spawn, spawns, environments, systemPrompts, processes };
}

function host(
  cli: ReturnType<typeof claudeCli>,
  extra: Partial<ConstructorParameters<typeof ClaudePrimedSessions>[0]> = {},
) {
  const events: PrimedEvent[] = [];
  const h = new ClaudePrimedSessions({
    model: 'haiku',
    cwd: '/private/claude-decisions',
    spawn: cli.spawn,
    baseInstructions: 'BASE',
    onEvent: (e) => events.push(e),
    timeoutMs: 2_000,
    ...extra,
  });
  cleanup.push(() => h.close());
  return { h, events };
}

const spec = { key: 't1:aux:domain:api', instructions: 'ROLE', context: 'DOMAIN CACHE' };
const specSystemPrompt =
  'BASE\n\nROLE\n\nStanding context for the decisions that follow:\n\nDOMAIN CACHE';

describe('ClaudePrimedSessions', () => {
  test("holds a key's stable text in the system prompt and runs each decision in a fresh non-persisted session", async () => {
    const cli = claudeCli();
    const { h } = host(cli);
    const first = await h.decide(spec, { input: 'q1' });
    expect(first).toMatchObject({
      content: 'decided: q1',
      prime: 'cold',
      model: 'claude-test',
      tokens: { cacheRead: 8000 },
    });
    const argv = cli.spawns[0]!;
    for (const flag of CLAUDE_TEXT_ONLY_ARGS) expect(argv).toContain(flag);
    expect(argv).toContain('--no-session-persistence');
    expect(argv).not.toContain('--resume');
    expect(argv).toEqual(expect.arrayContaining(['--max-turns', '1']));
    expect(cli.systemPrompts[0]).toBe(specSystemPrompt);
    // Nothing but the decision's input is sent as a message.
    const sent = cli.processes[0]!.lines.filter((l) => l.type === 'user');
    expect(sent.map((l) => l.message.content[0].text)).toEqual(['q1']);
  });

  test('every decision process caches its system prompt for an hour and its messages for five minutes', async () => {
    const cli = claudeCli();
    const { h } = host(cli, {
      env: { CLAUDE_CODE_PROMPT_CACHE_TTL: '5m', CLAUDE_CONFIG_DIR: '/private/profile' },
    });
    await h.decide(spec, { input: 'q1' });
    await tick(10);
    expect(cli.environments).toHaveLength(2); // the decision and its spare
    for (const env of cli.environments) {
      expect(env).toMatchObject({
        ...CLAUDE_DECISION_CACHE_ENV,
        CLAUDE_CONFIG_DIR: '/private/profile',
      });
    }
    expect(CLAUDE_DECISION_CACHE_ENV).toEqual({
      CLAUDE_CODE_PROMPT_CACHE_TTL: '1h',
      CLAUDE_CODE_MESSAGES_PROMPT_CACHE_TTL: '5m',
    });
  });

  test('a warm spare is spawned after each decision, so the next decision pays no start', async () => {
    const cli = claudeCli();
    const { h } = host(cli);
    await h.decide(spec, { input: 'q1' });
    await tick(10);
    expect(cli.spawns).toHaveLength(2); // the first decision, then its spare
    const second = await h.decide(spec, { input: 'q2' });
    expect(second).toMatchObject({ prime: 'warm', content: 'decided: q2' });
    expect(cli.processes[1]!.lines[0].message.content[0].text).toBe('q2');
    expect(cli.systemPrompts[1]).toBe(specSystemPrompt);
    expect(cli.processes[0]!.killed).toBe(true);
  });

  test('a changed hash starts the key again; a key with no context holds only its instructions', async () => {
    const cli = claudeCli();
    const { h, events } = host(cli, { spare: false });
    await h.decide(spec, { input: 'q1' });
    expect((await h.decide({ ...spec, context: 'NEW' }, { input: 'q2' })).prime).toBe('cold');
    expect(events.some((e) => e.type === 'evicted' && e.reason === 'reprime')).toBe(true);
    expect(cli.systemPrompts[1]).toEndWith('\n\nNEW');
    const plain = await h.decide(
      { key: 't1:aux:agent:router', instructions: 'ROUTE' },
      { input: 'hi' },
    );
    expect(plain.content).toBe('decided: hi');
    expect(cli.systemPrompts.at(-1)).toBe('BASE\n\nROUTE');
  });

  test('admission refusal dispatches nothing; tool activity is a violation', async () => {
    const cli = claudeCli({ behavior: (input) => (input === 'bad' ? 'tool' : 'answer') });
    const { h } = host(cli, { spare: false });
    const refused = await h
      .decide(spec, {
        input: 'q1',
        onAdmission: () => {
          throw Error('no');
        },
      })
      .catch((e) => e);
    expect(refused).toMatchObject({ reason: 'admission', dispatch: 'not-dispatched' });
    expect(cli.processes.flatMap((p) => p.lines).some((l) => l.type === 'user')).toBe(false);
    await expect(h.decide(spec, { input: 'bad' })).rejects.toMatchObject({
      reason: 'violation',
      dispatch: 'attempted',
    });
  });

  test('deadline interrupts through the control protocol and reports settlement', async () => {
    const cli = claudeCli({ behavior: (input) => (input === 'slow' ? 'hold' : 'answer') });
    const { h } = host(cli, { spare: false });
    await h.decide(spec, { input: 'q1' });
    const error = await h.decide(spec, { input: 'slow', timeoutMs: 150 }).catch((e) => e);
    expect(error).toMatchObject({ reason: 'timeout', dispatch: 'attempted', settled: true });
  });

  test('a rejected rate limit fails the decision and blocks the next one until a poll shows capacity', async () => {
    const used = 100;
    const cli = claudeCli({
      behavior: (input) => (input === 'limited' ? 'limited' : 'answer'),
      usage: () => used,
    });
    const { h } = host(cli, { spare: false });
    await h.decide(spec, { input: 'q1' });
    await expect(h.decide(spec, { input: 'limited' })).rejects.toMatchObject({
      reason: 'rate-limited',
      dispatch: 'attempted',
    });
    expect(h.limits()?.blocked).toBe(true);
    await expect(h.decide(spec, { input: 'q2' })).rejects.toMatchObject({
      reason: 'rate-limited',
      dispatch: 'not-dispatched',
    });
    expect(
      cli.processes.some((p) =>
        p.lines.some((l) => l.type === 'control_request' && l.request.subtype === 'get_usage'),
      ),
    ).toBe(true); // the poll
  });

  test('a model the runtime does not serve fails as model-missing with a typed cause', async () => {
    const cli = claudeCli({ behavior: (input) => (input === 'missing' ? 'missing' : 'answer') });
    const { h } = host(cli);
    const error = await h.decide(spec, { input: 'missing' }).catch((e) => e);
    expect(error).toMatchObject({ reason: 'model-missing', dispatch: 'attempted' });
    expect(nativeModelMissing(error)).toMatchObject({
      name: 'NativeModelMissingError',
      runtime: 'claude-code',
    });
  });

  test('a rejection without utilization still carries its reset and never blocks forever', async () => {
    const { claudeRateLimitSnapshot } = await import('../src');
    expect(
      claudeRateLimitSnapshot({ status: 'rejected', rateLimitType: 'five_hour', resetsAt: 1 }),
    ).toMatchObject({
      blocked: true,
      windows: [{ id: 'five_hour', usedPercent: 100, resetsAt: 1000 }],
    });
  });

  test('work waiting on a key is refused after close and live branches are stopped', async () => {
    const cli = claudeCli({ behavior: (input) => (input === 'slow' ? 'hold' : 'answer') });
    const { h } = host(cli, { spare: false, timeoutMs: 5_000 });
    await h.decide(spec, { input: 'q1' });
    const slow = h.decide(spec, { input: 'slow' }).catch((e) => e);
    const queued = h.decide(spec, { input: 'after-close' }).catch((e) => e);
    await tick(20);
    await h.close();
    expect((await queued).reason).toBe('closed');
    expect(await slow).toBeInstanceOf(Error);
    expect(
      cli.processes
        .flatMap((p) => p.lines)
        .some((l) => l.type === 'user' && l.message.content[0].text === 'after-close'),
    ).toBe(false);
    expect(cli.processes.every((p) => p.killed || p.closed)).toBe(true);
  });

  test('overlapping decisions on one key run beside each other on one key', async () => {
    const cli = claudeCli({ behavior: (input) => (input === 'slow' ? 'hold' : 'answer') });
    const { h, events } = host(cli, { maxConcurrent: 4 });
    const order: string[] = [];
    const slow = h
      .decide(spec, { input: 'slow', timeoutMs: 400 })
      .catch((e) => e)
      .finally(() => order.push('slow'));
    await tick(20);
    // The second phase is not queued behind the first: it starts its own session for the key.
    const quick = await h.decide(spec, { input: 'quick' });
    order.push('quick');
    expect(quick).toMatchObject({ content: 'decided: quick', prime: 'warm' });
    expect((await slow).reason).toBe('timeout');
    expect(order).toEqual(['quick', 'slow']);
    expect(events.filter((e) => e.type === 'primed')).toHaveLength(1);
    await tick(20);
    // One idle spare per key once both have finished.
    const live = cli.processes.filter((p) => !p.killed && !p.closed);
    expect(live).toHaveLength(1);
    expect(h.snapshot()).toMatchObject({ sessions: 1, active: 0 });
  });

  test('a key replaced while a decision runs is reported evicted when that decision finishes', async () => {
    const cli = claudeCli({ behavior: (input) => (input === 'slow' ? 'hold' : 'answer') });
    const { h, events } = host(cli, { maxConcurrent: 4, spare: false });
    await h.decide(spec, { input: 'q1' });
    const slow = h.decide(spec, { input: 'slow', timeoutMs: 300 }).catch((e) => e);
    await tick(20);
    await h.decide({ ...spec, context: 'NEW' }, { input: 'q2' });
    expect(events.some((e) => e.type === 'evicted')).toBe(false);
    expect((await slow).reason).toBe('timeout');
    await tick(20);
    expect(events.filter((e) => e.type === 'evicted' && e.reason === 'reprime')).toHaveLength(1);
  });

  test('close retires a re-primed session whose decision is still running', async () => {
    const cli = claudeCli({ behavior: (input) => (input === 'slow' ? 'hold' : 'answer') });
    const { h, events } = host(cli, { maxConcurrent: 4, spare: false, timeoutMs: 5_000 });
    await h.decide(spec, { input: 'q1' });
    const slow = h.decide(spec, { input: 'slow' }).catch((e) => e);
    await tick(20);
    await h.decide({ ...spec, context: 'NEW' }, { input: 'q2' });
    await h.close();
    expect(
      events.filter((e) => e.type === 'evicted').map((e) => e.type === 'evicted' && e.reason),
    ).toEqual(expect.arrayContaining(['reprime', 'close']));
    expect(await slow).toBeInstanceOf(Error);
  });

  test('close kills spares and refuses further decisions', async () => {
    const cli = claudeCli();
    const { h } = host(cli);
    await h.decide(spec, { input: 'q1' });
    await tick(10);
    await h.close();
    expect(cli.processes.at(-1)!.killed).toBe(true);
    await expect(h.decide(spec, { input: 'q2' })).rejects.toMatchObject({ reason: 'closed' });
  });
});

describe('ClaudePrimedSessions cancellation', () => {
  test('an abort interrupts the running decision through the control protocol', async () => {
    const cli = claudeCli({ behavior: (input) => (input === 'slow' ? 'hold' : 'answer') });
    const { h } = host(cli, { spare: false, timeoutMs: 5_000 });
    await h.decide(spec, { input: 'q1' });
    const controller = new AbortController();
    const running = h.decide(spec, { input: 'slow', signal: controller.signal }).catch((e) => e);
    await tick(20);
    controller.abort();
    expect(await running).toMatchObject({
      reason: 'aborted',
      dispatch: 'attempted',
      settled: true,
    });
    await expect(
      h.decide(spec, { input: 'q2', signal: AbortSignal.abort() }),
    ).rejects.toMatchObject({ reason: 'aborted', dispatch: 'not-dispatched' });
  });
});
