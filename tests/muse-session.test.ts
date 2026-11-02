import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  createSession,
  MUSE_SDK_VERSION,
  MuseSession,
  type MuseSessionConfig,
  museLimitSnapshot,
  musePermissions,
  NativeBindingMissingError,
  nativeBindingMissing,
  type SessionEvent,
  type ToolRequest,
  TRANSPORTS,
} from '../src';
import {
  FakeMspError,
  type FakeMuse,
  type Frame,
  fakeMuse,
  INITIALIZE,
  type Params,
  SESSION_ID,
  TURN_ID,
} from './helpers/fake-muse';

const sessions: MuseSession[] = [];
afterEach(() => {
  for (const session of sessions.splice(0)) session.kill();
});
const open = (fake: FakeMuse, config: MuseSessionConfig = {}) => {
  const session = new MuseSession({ cwd: '/workspace', connect: fake.connect, ...config });
  sessions.push(session);
  return session;
};
const kinds = (events: readonly SessionEvent[]) => events.map((e) => e.kind);

// ---------------------------------------------------------------------------
// The live recording (muse 1.4.14, 2026-11-01): a supervised turn that ran
// `echo probe-ok; curl -sI https://example.com | head -1` through three shell
// stages and a network approval. Replayed frame by frame; an approval frame
// waits for this client's decision, as the host did.
// ---------------------------------------------------------------------------

type Recorded =
  | { type: 'initialize' | 'start' | 'usage' | 'read'; result: Params }
  | { type: 'notify'; frame: Frame };
const recording = readFileSync(
  new URL('../fixtures/muse/shell-approval.jsonl', import.meta.url),
  'utf8',
)
  .trim()
  .split('\n')
  .map((line) => JSON.parse(line) as Recorded);
const result = (type: 'initialize' | 'start' | 'usage' | 'read') =>
  (recording.find((r) => r.type === type) as { result: Params }).result;
const frames = recording.flatMap((r) => (r.type === 'notify' ? [r.frame] : []));

function replayHost() {
  const fake = fakeMuse({ initialize: result('initialize') as never });
  const decided = new Set<string>();
  fake.handlers['session/start'] = (p) => {
    fake.state.profile = p.permissionProfile as string;
    fake.state.mode = p.approvalMode as string;
    for (const f of frames.slice(0, 2)) fake.send(f); // session/started, approvalModeChanged
    return result('start');
  };
  fake.handlers['session/read'] = () => result('read');
  fake.handlers['usage/read'] = () => result('usage');
  const decide = fake.handlers['approval/decide']!;
  fake.handlers['approval/decide'] = (p) => {
    const requirement = p.requirementId as { approvalId: string; sourceIndex: number };
    decided.add(`${requirement.approvalId}:${requirement.sourceIndex}`);
    // Not terminal: the shell approval has later stages, and approval/resolved closes it.
    return { ...(decide(p) as Params), terminal: false };
  };
  fake.handlers['turn/start'] = (p) => {
    void (async () => {
      for (const f of frames.slice(2)) {
        fake.send(f);
        if (f.method !== 'approval/requested' && f.method !== 'approval/updated') continue;
        const current = (f.params?.currentRequirementId ?? {}) as {
          approvalId: string;
          sourceIndex: number;
        };
        const key = `${current.approvalId}:${current.sourceIndex}`;
        while (!decided.has(key)) await Bun.sleep(1);
      }
    })();
    return {
      commandId: p.commandId,
      disposition: 'started',
      startedNewTurn: true,
      status: 'accepted',
      turnId: TURN_ID,
    };
  };
  return fake;
}

describe('MuseSession on the recorded supervised turn', () => {
  test('launch: serve args, explicit profile, a child env without metered credentials', async () => {
    const fake = replayHost();
    const prior = { ...process.env };
    Object.assign(process.env, {
      META_API_KEY: 'meta-key',
      LLM_API_KEY: 'llm-key',
      MODEL_API_KEY: 'model-key',
      MODEL_URL: 'https://elsewhere.example',
      MUSE_PERMISSION_PROFILE_FAIL_OPEN: '1',
      TBH_AUTH_BASE_URL: 'https://elsewhere.example',
      OPENROUTER_API_KEY: 'router-key',
      MUSE_MODEL: 'other-model',
      MUSE_DISABLE_APPROVAL_JUDGE: '1',
      MUSE_EXPERIMENTAL_ACP: '1',
    });
    try {
      const session = open(fake, {
        env: { XDG_CONFIG_HOME: '/profiles/muse/config', XDG_DATA_HOME: '/profiles/muse/data' },
      });
      await session.start();
      const launch = fake.launches[0]!;
      expect(launch.museBin).toBe('muse');
      expect(launch.args).toEqual(['serve', '--trust-workspace']);
      expect(launch.cwd).toBe('/workspace');
      expect(launch.env.MUSE_NO_AUTO_UPDATE).toBe('1');
      expect(launch.env.XDG_CONFIG_HOME).toBe('/profiles/muse/config');
      expect(launch.env.XDG_DATA_HOME).toBe('/profiles/muse/data');
      for (const key of [
        'META_API_KEY',
        'LLM_API_KEY',
        'MODEL_API_KEY',
        'MODEL_URL',
        'MUSE_PERMISSION_PROFILE_FAIL_OPEN',
        'TBH_AUTH_BASE_URL',
        'OPENROUTER_API_KEY',
        'MUSE_MODEL',
        'MUSE_DISABLE_APPROVAL_JUDGE',
        'MUSE_EXPERIMENTAL_ACP',
      ])
        expect(launch.env[key]).toBeUndefined();
      expect(launch.initialize.capabilities).toEqual({
        experimentalApi: true,
        userInputDialogs: true,
      });
      expect(session.durability).toEqual({ kind: 'durable' });
      expect(session.transport).toBe(TRANSPORTS['muse-serve']);
    } finally {
      for (const key of Object.keys(process.env)) if (!(key in prior)) delete process.env[key];
    }
  });

  test('a turn: gates decide every approval stage; events, tokens and limits fold', async () => {
    const fake = replayHost();
    const session = open(fake, { effort: 'low' });
    const gated: ToolRequest[] = [];
    session.onToolRequest((request) => {
      gated.push(request);
      return { behavior: 'allow' };
    });
    await session.start();
    const done = await session.send('Run the two probes.', {
      onAdmission: (attempt) => {
        expect(attempt.dispatch).toBe('not-dispatched');
      },
    });

    const start = fake.requests.find((r) => r.method === 'session/start')!.params!;
    expect(start).toMatchObject({
      workspaceRoot: '/workspace',
      providerId: 'meta',
      approvalMode: 'promptUnmatched',
      permissionProfile: ':ask-me',
    });
    expect(fake.requests.find((r) => r.method === 'turn/start')!.params).toMatchObject({
      sessionId: SESSION_ID,
      reasoningEffort: 'low',
      input: [{ type: 'text', text: 'Run the two probes.' }],
    });

    // Three shell stages, then the network target the command reached.
    expect(gated.map((g) => [g.stage, g.toolName])).toEqual([
      ['permission', 'bash'],
      ['permission', 'bash'],
      ['permission', 'bash'],
      ['permission', 'network'],
    ]);
    expect(gated[0]!.toolInput).toMatchObject({
      command: 'echo probe-ok; curl -sI https://example.com | head -1',
      approval: { kind: 'shell', argv: ['echo', 'probe-ok'], position: 1, totalStages: 3 },
    });
    expect(gated[3]!.toolInput).toMatchObject({
      approval: { kind: 'network', host: 'example.com', port: 443, protocol: 'https' },
    });
    expect(gated.every((g) => g.admissionId === done.admissionId)).toBe(true);
    expect(gated[0]!.callId).toBe('call_01a199f85a767348bbec7596d82a10c0');
    const decisions = fake.requests.filter((r) => r.method === 'approval/decide');
    expect(decisions.map((d) => d.params!.choiceId)).toEqual([
      'allow_once',
      'allow_once',
      'allow_once',
      'allow_once',
    ]);

    expect(done.content).toBe('probe-ok\nHTTP/1.1 200 Connection Established');
    expect(done.nativeOutcome).toBe('completed');
    expect(done.terminal).toMatchObject({
      type: 'turn/completed',
      turnId: TURN_ID,
      subtype: 'completed',
    });
    expect(done.externalSessionId).toBe(SESSION_ID);
    expect(done.turnId).toBe(TURN_ID);
    expect(done.rpcOutcome).toBe('resolved');
    const turnKinds = kinds(done.events).filter((k) => k !== 'native_status');
    expect(turnKinds).toEqual([
      'usage',
      'tool_use',
      'tool_result',
      'text_delta',
      'text_delta',
      'text',
      'usage',
      'result',
    ]);
    const use = done.events.find((e) => e.kind === 'tool_use')!;
    expect(use).toMatchObject({
      toolName: 'bash',
      callId: 'call_01a199f85a767348bbec7596d82a10c0',
      toolInput: { command: 'echo probe-ok; curl -sI https://example.com | head -1' },
    });
    const toolResult = done.events.find((e) => e.kind === 'tool_result')!;
    expect(toolResult.toolError).toBe(false);
    expect(toolResult.toolOutput).toContain('"exit_code": 0');
    // Input excludes cache reads; the turn total is the sum of both requests.
    expect(done.events.filter((e) => e.kind === 'usage').map((e) => e.tokens)).toEqual([
      expect.objectContaining({ input: 30733, output: 120, cacheRead: 0, thinking: 17 }),
      expect.objectContaining({ input: 244, output: 27, cacheRead: 30708, thinking: 6 }),
    ]);
    expect(done.tokens).toEqual({
      input: 30977,
      output: 147,
      cacheRead: 30708,
      cacheWrite: 0,
      thinking: 23,
    });
    expect(session.totalTokens).toEqual({ input: 30977, output: 147 });
    expect(session.turns).toBe(1);

    // usage/changed after the turn: account limits, never part of the admission.
    await Bun.sleep(5);
    const limit = session.events.find((e) => e.kind === 'rate_limit')!;
    expect(limit.unattributedReason).toBe('account-status');
    expect(limit.limits).toMatchObject({
      runtime: 'muse',
      windows: [
        { id: 'window', usedPercent: 5, windowMinutes: 300 },
        { id: 'weekly', usedPercent: 1, windowMinutes: 10_080 },
      ],
    });
    expect(limit.limits?.plan).toBeUndefined();
    // Muse's own reminder agents ran beside the turn: tasks, outside the admission.
    const reminders = session.events.filter((e) => e.task?.taskType === 'muse-reminder');
    expect(reminders.map((e) => [e.task?.phase, e.task?.description])).toContainEqual([
      'started',
      'goal-reminder',
    ]);
    expect(reminders.every((e) => e.unattributedReason === 'task' && !e.admissionId)).toBe(true);
    expect(done.events.some((e) => e.kind === 'task')).toBe(false);
    const configured = session.events.find(
      (e) => (e.raw as { type?: string } | undefined)?.type === 'session-configured',
    )!;
    expect(configured.raw).toMatchObject({
      method: 'session/start',
      provider: 'meta',
      permissionProfile: ':ask-me',
      reviewerAuthority: 'human',
    });
  });

  test('a denying gate rejects the stage with its reason; the reject choice carries the feedback', async () => {
    const fake = replayHost();
    const session = open(fake);
    session.onToolRequest(() => ({ behavior: 'deny', message: 'no network from here' }));
    await session.start();
    const send = session.send('Run the two probes.');
    await fake.waitFor('approval/decide');
    const decision = fake.requests.find((r) => r.method === 'approval/decide')!.params!;
    expect(decision).toMatchObject({ choiceId: 'abort', feedback: 'no network from here' });
    session.kill();
    await expect(send).rejects.toThrow();
  });

  test('readLimits reads usage/read without a turn', async () => {
    const fake = replayHost();
    const session = open(fake);
    await session.start();
    expect(await session.readLimits()).toMatchObject({
      runtime: 'muse',
      source: 'poll',
      windows: [{ id: 'window', usedPercent: 5, resetsAt: 1793601827000 }, { id: 'weekly' }],
    });
    fake.handlers['usage/read'] = () => ({});
    expect(await session.readLimits()).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Synthetic hosts for the paths a live run did not exercise.
// ---------------------------------------------------------------------------

/** A turn that answers with one message after turn/start, or holds until told. */
function textHost(opts: { hold?: boolean; text?: string } = {}) {
  const fake = fakeMuse();
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  fake.handlers['turn/start'] = (p) => {
    void (async () => {
      await Bun.sleep(0);
      fake.notify('turn/started', { turnId: TURN_ID });
      if (opts.hold) await held;
      fake.notify('item/started', {
        item: {
          itemId: 'm1',
          kind: 'agentMessage',
          turnId: TURN_ID,
          revision: 1,
          status: 'inProgress',
          text: '',
        },
      });
      fake.notify('item/completed', {
        item: {
          itemId: 'm1',
          kind: 'agentMessage',
          turnId: TURN_ID,
          revision: 2,
          status: 'completed',
          text: opts.text ?? 'ok',
        },
      });
      fake.notify('turn/completed', { turnId: TURN_ID, terminal: 'completed' });
    })();
    return {
      commandId: p.commandId,
      disposition: 'started',
      startedNewTurn: true,
      status: 'accepted',
      turnId: TURN_ID,
    };
  };
  return { fake, release };
}

describe('MuseSession contract', () => {
  test('refuses a served CLI that is not the pinned SDK version, and closes it', async () => {
    const fake = fakeMuse({
      initialize: { ...INITIALIZE, serverInfo: { name: 'muse', version: '1.4.15' } },
    });
    const session = open(fake);
    await expect(session.start()).rejects.toThrow(
      `Muse Code 1.4.15 does not match the pinned @muse-code/sdk ${MUSE_SDK_VERSION}`,
    );
    expect(fake.closed).toBe(true);
    expect(session.alive).toBe(false);
  });

  test('the pinned version is the installed SDK', () => {
    const pkg = JSON.parse(
      readFileSync(new URL('../node_modules/@muse-code/sdk/package.json', import.meta.url), 'utf8'),
    ) as { version: string };
    expect(pkg.version).toBe(MUSE_SDK_VERSION);
  });

  test('bypassPermissions: no sandbox, allowAll + :unrestricted, and no gates to register', async () => {
    const { fake } = textHost();
    const session = open(fake, { permissionMode: 'bypassPermissions' });
    expect(() => session.onToolRequest(() => ({ behavior: 'allow' }))).toThrow('promptUnmatched');
    await session.start();
    expect(fake.launches[0]!.args).toEqual(['serve', '--trust-workspace', '--disable-sandbox']);
    const done = await session.send('hi');
    expect(done.content).toBe('ok');
    expect(fake.requests.find((r) => r.method === 'session/start')!.params).toMatchObject({
      approvalMode: 'allowAll',
      permissionProfile: ':unrestricted',
    });
    expect(musePermissions('plan')).toEqual({
      approvalMode: 'promptUnmatched',
      permissionProfile: ':read-only',
      disableSandbox: false,
    });
  });

  test('resume sets the approval mode again and proves the profile before the turn', async () => {
    const { fake } = textHost();
    const ready: string[] = [];
    const session = open(fake, {
      externalSessionId: SESSION_ID,
      onSessionReady: (id) => {
        ready.push(id);
      },
    });
    const done = await session.send('again');
    expect(done.content).toBe('ok');
    expect(ready).toEqual([SESSION_ID]);
    const methods = fake.requests.map((r) => r.method);
    expect(methods.slice(0, 4)).toEqual([
      'session/resume',
      'session/setApprovalMode',
      'session/read',
      'turn/start',
    ]);
    expect(fake.requests[0]!.params).toMatchObject({
      sessionId: SESSION_ID,
      excludeItems: true,
      permissionProfile: ':ask-me',
    });
    expect(fake.requests[1]!.params).toMatchObject({ mode: 'promptUnmatched' });
  });

  test('resume refuses a session whose committed profile is not the one asked for', async () => {
    const { fake } = textHost();
    fake.handlers['session/read'] = () => ({
      session: {
        sessionId: SESSION_ID,
        activeTurnId: null,
        permissionState: { profileId: ':auto-review' },
        approvalMode: { mode: 'promptUnmatched' },
      },
    });
    const session = open(fake, { externalSessionId: SESSION_ID });
    const error = await session.send('again').catch((e: Error) => e);
    expect(String(error)).toContain('permission-profile-not-applied (:auto-review)');
    expect(fake.requests.some((r) => r.method === 'turn/start')).toBe(false);
    expect(session.attempts[0]!.localFailure).toBe('validation');
  });

  test('a missing session is NativeBindingMissingError; no turn was dispatched', async () => {
    const { fake } = textHost();
    fake.handlers['session/resume'] = (p) => {
      throw new FakeMspError(-32020, 'sessionNotFound', `session ${p.sessionId} not found`);
    };
    const session = open(fake, { externalSessionId: 'gone' });
    const error = await session.send('again').catch((e: unknown) => e);
    const missing = nativeBindingMissing(error);
    expect(missing).toBeInstanceOf(NativeBindingMissingError);
    expect(missing?.runtime).toBe('muse');
    expect(missing?.binding).toBe('gone');
    expect(missing?.cwd).toBe('/workspace');
    expect(session.attempts[0]!.dispatch).toBe('not-dispatched');
  });

  test('fork runs session/fork on its own host, then resumes the new session with the gates', async () => {
    const { fake } = textHost();
    fake.handlers['session/fork'] = () => ({
      session: { sessionId: 'forked-1' },
      viewCursor: 'v4:forked-1:0',
      history: { mode: 'none' },
      pendingRequests: [],
    });
    const parent = open(fake, { externalSessionId: SESSION_ID });
    const gate = () => ({ behavior: 'allow' as const });
    parent.onToolRequest(gate);
    const child = parent.fork() as MuseSession;
    sessions.push(child);
    expect(child.externalSessionId).toBeUndefined();
    fake.state.sessionId = 'forked-1';
    fake.handlers['turn/start'] = (p) => {
      queueMicrotask(() => {
        fake.notify('turn/started', { turnId: 'forked-turn' });
        fake.notify('turn/completed', { turnId: 'forked-turn', terminal: 'completed' });
      });
      return {
        commandId: p.commandId,
        disposition: 'started',
        startedNewTurn: true,
        status: 'accepted',
        turnId: 'forked-turn',
      };
    };
    const done = await child.send('branch');
    expect(done.nativeOutcome).toBe('completed');
    expect(child.externalSessionId).toBe('forked-1');
    expect(fake.requests.map((r) => r.method).slice(0, 4)).toEqual([
      'session/fork',
      'session/resume',
      'session/setApprovalMode',
      'session/read',
    ]);
    expect(fake.requests[0]!.params).toMatchObject({ sessionId: SESSION_ID });
    expect(fake.requests[1]!.params).toMatchObject({
      sessionId: 'forked-1',
      permissionProfile: ':ask-me',
    });
    expect(() => new MuseSession({ connect: fake.connect }).fork()).toThrow('no native id');
  });

  test('interruptNative sends turn/interrupt and is acknowledged by the cancelled terminal', async () => {
    const { fake } = textHost({ hold: true });
    fake.handlers['turn/interrupt'] = (p) => {
      queueMicrotask(() =>
        fake.notify('turn/completed', { turnId: TURN_ID, terminal: 'cancelled' }),
      );
      return { commandId: p.commandId, status: 'accepted', turnId: p.turnId };
    };
    const session = open(fake);
    await session.start();
    expect(await session.interruptNative()).toBe('no-turn');
    const send = session.send('long');
    await fake.waitFor('turn/start');
    await Bun.sleep(5);
    expect(await session.interruptNative({ timeoutMs: 1_000 })).toBe('acknowledged');
    const done = await send;
    expect(done.nativeOutcome).toBe('failed');
    expect(done.terminal?.subtype).toBe('cancelled');
    expect(fake.requests.find((r) => r.method === 'turn/interrupt')!.params).toMatchObject({
      sessionId: SESSION_ID,
      turnId: TURN_ID,
    });
  });

  test('push steers the owned turn; without one it is recorded as ignored', async () => {
    const { fake, release } = textHost({ hold: true });
    const session = open(fake);
    await session.start();
    await session.push({ kind: 'guard', text: 'idle' });
    expect(session.events.at(-1)?.text).toContain('push_ignored: kind=guard');
    const send = session.send('long');
    await fake.waitFor('turn/start');
    await Bun.sleep(5);
    await session.push({ kind: 'guard', text: 'use the existing lock' });
    expect(fake.requests.find((r) => r.method === 'turn/steer')!.params).toMatchObject({
      expectedTurnId: TURN_ID,
      input: [{ type: 'text', text: 'use the existing lock' }],
    });
    expect(session.events.some((e) => (e.raw as { type?: string })?.type === 'push-steered')).toBe(
      true,
    );
    release();
    await send;
  });

  test('questions go to onUserInput; unanswered ones are cancelled with a reason', async () => {
    const { fake, release } = textHost({ hold: true });
    const session = open(fake);
    const asked: string[] = [];
    session.onUserInput((request) => {
      asked.push(request.questions[0]!.question);
      return [{ questionId: request.questions[0]!.id, selectedLabel: 'Yes' }];
    });
    await session.start();
    const send = session.send('ask me');
    await fake.waitFor('turn/start');
    await Bun.sleep(5);
    const question = (userInputId: string) => ({
      userInputId,
      turnId: TURN_ID,
      itemId: `item-${userInputId}`,
      toolCallId: `call-${userInputId}`,
      toolName: 'ask_user',
      questions: [
        {
          id: 'q1',
          header: 'Proceed',
          question: 'Proceed?',
          options: [{ label: 'Yes' }, { label: 'No' }],
          selection: { mode: 'single' },
        },
      ],
    });
    fake.notify('userInput/requested', question('u1'));
    expect(await fake.waitFor('userInput/answer')).toMatchObject({
      userInputId: 'u1',
      answers: [{ questionId: 'q1', selectedLabel: 'Yes' }],
    });
    expect(asked).toEqual(['Proceed?']);

    session.onUserInput(() => undefined);
    fake.notify('userInput/requested', question('u2'));
    expect(await fake.waitFor('userInput/cancel')).toMatchObject({
      userInputId: 'u2',
      reason: 'The client declined to answer',
    });
    release();
    await send;
  });

  test('a host that dies mid-turn rejects the turn; an ephemeral one names the lost binding', async () => {
    const fake = fakeMuse({ initialize: { ...INITIALIZE, sessionDurability: 'ephemeral' } });
    fake.handlers['turn/start'] = (p) => ({
      commandId: p.commandId,
      disposition: 'started',
      startedNewTurn: true,
      status: 'accepted',
      turnId: TURN_ID,
    });
    const session = open(fake);
    await session.start();
    expect(session.durability).toEqual({ kind: 'ephemeral' });
    const send = session.send('then die');
    await fake.waitFor('turn/start');
    await Bun.sleep(5);
    fake.exit();
    const error = await send.catch((e: unknown) => e);
    expect(nativeBindingMissing(error)?.runtime).toBe('muse');
    expect(session.alive).toBe(false);
    expect(session.events.at(-1)).toMatchObject({
      kind: 'session_end',
      transportOutcome: 'failed',
    });
  });

  test('resume refuses a session on another provider or with a non-human reviewer', async () => {
    for (const [patch, reason] of [
      [{ providerId: 'openrouter' }, 'provider-not-meta (openrouter)'],
      [
        {
          permissionState: {
            profileId: ':ask-me',
            reviewerAuthority: 'autoReview',
            axes: { reviewer: 'autoReview' },
          },
        },
        'reviewer-not-human (autoReview)',
      ],
    ] as const) {
      const { fake } = textHost();
      const read = fake.handlers['session/read']!;
      fake.handlers['session/read'] = async (p) => {
        const answer = (await read(p)) as { session: Params };
        return { ...answer, session: { ...answer.session, ...patch } };
      };
      const session = open(fake, { externalSessionId: SESSION_ID });
      expect(String(await session.send('again').catch((e: Error) => e))).toContain(reason);
      expect(fake.requests.some((r) => r.method === 'turn/start')).toBe(false);
      // Nothing was written, so a refusal never leaves the session blocked.
      expect(session.attempts[0]!.dispatch).toBe('not-dispatched');
      expect(String(await session.send('again').catch((e: Error) => e))).toContain(reason);
    }
  });

  test('createSession builds a MuseSession by transport kind', () => {
    const { fake } = textHost();
    expect(createSession('muse-serve', { connect: fake.connect })).toBeInstanceOf(MuseSession);
  });
});

describe('museLimitSnapshot', () => {
  test('reads usage/read and usage/changed shapes; nothing reported is undefined', () => {
    const usage = {
      window: { usedPercent: 120, windowDurationMins: 300, resetsAtMs: 2_000 },
      weekly: { usedPercent: 1, resetsAtMs: 3_000 },
      tier: '123',
      observedAtMs: 1_000,
    };
    expect(museLimitSnapshot({ usage }, 'poll', 9)).toEqual({
      runtime: 'muse',
      source: 'poll',
      observedAt: 1_000,
      windows: [
        { id: 'window', usedPercent: 100, resetsAt: 2_000, windowMinutes: 300 },
        { id: 'weekly', usedPercent: 1, resetsAt: 3_000, windowMinutes: 10_080 },
      ],
      blocked: true,
    });
    expect(museLimitSnapshot(usage, 'stream', 9)?.source).toBe('stream');
    expect(museLimitSnapshot({}, 'poll')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Work Muse starts itself: cron firings, monitor feeds, goals. Nothing is
// dropped outside a send; it is marked as a task (`unattributedReason: 'task'`).
// ---------------------------------------------------------------------------

describe('MuseSession surfaces Muse-initiated work', () => {
  const cronTurn = (fake: FakeMuse, turnId: string) => {
    fake.notify('turn/started', { turnId, commandId: turnId });
    fake.notify('item/completed', {
      item: {
        itemId: `${turnId}-fire`,
        kind: 'scheduledFire',
        turnId,
        revision: 1,
        status: 'completed',
        jobId: 'job-7',
      },
    });
    fake.notify('item/completed', {
      item: {
        itemId: `${turnId}-msg`,
        kind: 'agentMessage',
        turnId,
        revision: 1,
        status: 'completed',
        text: 'The build is green.',
      },
    });
    fake.notify('session/tokenUsage', {
      turnId,
      modelId: 'muse-wonder-1.0',
      usage: { inputTokens: 100, outputTokens: 10, cachedTokens: 0, reasoningTokens: 0 },
      promptTokens: 100,
      totalTokens: 110,
      cumulative: { promptTokens: 100, outputTokens: 10, totalTokens: 110 },
    });
    fake.notify('turn/completed', { turnId, terminal: 'completed' });
  };

  test('a cron firing between sends folds into task-marked events and a muse-cron task', async () => {
    const { fake } = textHost();
    const session = open(fake);
    await session.start();
    await session.send('hi');
    const before = session.events.length;
    cronTurn(fake, 'cron-turn-1');
    await Bun.sleep(10);
    const fired = session.events.slice(before);
    expect(fired.every((e) => e.unattributedReason === 'task' && !e.admissionId)).toBe(true);
    expect(fired.filter((e) => e.kind === 'task').map((e) => e.task)).toEqual([
      { phase: 'started', taskId: 'cron-turn-1', taskType: 'muse-turn' },
      {
        phase: 'updated',
        taskId: 'cron-turn-1',
        taskType: 'muse-cron',
        description: 'cron job job-7',
      },
      {
        phase: 'ended',
        taskId: 'cron-turn-1',
        taskType: 'muse-cron',
        status: 'completed',
        summary: 'The build is green.',
      },
    ]);
    expect(fired.find((e) => e.kind === 'text')).toMatchObject({
      text: 'The build is green.',
      turnId: 'cron-turn-1',
    });
    expect(fired.find((e) => e.kind === 'usage')?.tokens).toMatchObject({ input: 100, output: 10 });
    expect(session.turns).toBe(1);
  });

  test('a Muse turn that starts before our turn/start answer is not mistaken for ours', async () => {
    const fake = fakeMuse();
    fake.handlers['turn/start'] = async (p) => {
      // Muse's own turn is under way when our answer comes back.
      fake.notify('turn/started', { turnId: 'cron-turn-2', commandId: 'cron-turn-2' });
      fake.notify('item/completed', {
        item: {
          itemId: 'c2',
          kind: 'agentMessage',
          turnId: 'cron-turn-2',
          revision: 1,
          status: 'completed',
          text: 'cron says hi',
        },
      });
      fake.notify('turn/started', { turnId: TURN_ID, commandId: p.commandId });
      await Bun.sleep(5);
      queueMicrotask(() => {
        fake.notify('item/completed', {
          item: {
            itemId: 'm1',
            kind: 'agentMessage',
            turnId: TURN_ID,
            revision: 1,
            status: 'completed',
            text: 'ours',
          },
        });
        fake.notify('turn/completed', { turnId: TURN_ID, terminal: 'completed' });
        fake.notify('turn/completed', { turnId: 'cron-turn-2', terminal: 'completed' });
      });
      return {
        commandId: p.commandId,
        disposition: 'started',
        startedNewTurn: true,
        status: 'accepted',
        turnId: TURN_ID,
      };
    };
    const session = open(fake);
    await session.start();
    const done = await session.send('mine');
    expect(done.content).toBe('ours');
    expect(done.events.some((e) => e.text === 'cron says hi')).toBe(false);
    await Bun.sleep(10);
    expect(session.events.find((e) => e.text === 'cron says hi')).toMatchObject({
      unattributedReason: 'task',
      turnId: 'cron-turn-2',
    });
    expect(
      session.events.find((e) => e.task?.taskId === 'cron-turn-2' && e.task.phase === 'ended')
        ?.task,
    ).toMatchObject({ summary: 'cron says hi', status: 'completed' });
  });

  test('a monitor feed outside any turn and a goal change surface as tasks', async () => {
    const { fake } = textHost();
    const session = open(fake);
    await session.start();
    await session.send('hi');
    const before = session.events.length;
    fake.notify('item/completed', {
      item: {
        itemId: 'feed-1',
        kind: 'monitorFeed',
        turnId: null,
        revision: 1,
        status: 'completed',
        monitorId: 'monitor-call-1',
        monitorDescription: 'CI on main',
        text: 'CI failed on main',
      },
    });
    fake.notify('session/goalChanged', {
      goal: {
        objective: 'Ship the release',
        percentComplete: 40,
        status: 'active',
        currentWork: 'tests',
      },
    });
    await Bun.sleep(10);
    const tasks = session.events.slice(before).filter((e) => e.kind === 'task');
    expect(tasks.map((e) => e.task)).toEqual([
      {
        phase: 'progress',
        taskId: 'monitor-call-1',
        taskType: 'muse-monitor',
        description: 'CI on main',
        summary: 'CI failed on main',
      },
      {
        phase: 'updated',
        taskId: 'goal',
        taskType: 'muse-goal',
        status: 'active',
        description: 'Ship the release',
        summary: 'tests',
      },
    ]);
    expect(tasks.every((e) => e.unattributedReason === 'task')).toBe(true);
  });
});
