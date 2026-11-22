import { afterEach, describe, expect, test } from 'bun:test';
import { isAbsolute, resolve } from 'node:path';
import {
  AcpSession,
  type AcpSessionConfig,
  AGY_COMPETING_ENV,
  agyAcpLaunch,
  GEMINI_CLI_COMPETING_ENV,
  geminiCliAcpLaunch,
  JsonRpcConnection,
  NativeBindingMissingError,
  NativeModelMissingError,
  nativeBindingMissing,
  type SessionEvent,
  SessionTurnError,
  type ToolRequest,
  TRANSPORTS,
} from '../src';
import { fakeProcess, tick } from './helpers/fake-process';

const FAKE_SERVER = resolve(import.meta.dir, 'fixtures/fake-acp-server.ts');
const FAKE_CMD = [process.execPath, FAKE_SERVER] as const;

const sessions: AcpSession[] = [];
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((s) => s.close({ graceMs: 300 })));
});

function track(config: Omit<AcpSessionConfig, 'command'> & { command?: readonly string[] } = {}) {
  const session = new AcpSession({ command: FAKE_CMD, ...config });
  sessions.push(session);
  return session;
}

describe('AcpSession', () => {
  test('initialize -> session/new -> session/prompt streams thoughts, tool calls, plan, usage, and text', async () => {
    const events: SessionEvent[] = [];
    let readyId: string | undefined;
    const session = track({
      baseContext: 'BASE CONTEXT',
      onSessionReady: (id) => {
        readyId = id;
      },
    });
    session.onEvent((e) => events.push(e));
    session.onBeforeSend((msg) => `[wrapped] ${msg}`);

    expect(session.transport).toBe(TRANSPORTS.acp);
    expect(session.admissionProtocol).toBe('prewrite-v1');

    await session.start();
    expect(session.alive).toBe(true);
    expect(session.externalSessionId).toBe('acp-sess-1');
    expect(readyId).toBe('acp-sess-1');
    expect(session.serverCapabilities).toEqual({
      loadSession: true,
      promptCapabilities: { image: true, audio: false, embeddedContext: true },
      mcpCapabilities: { http: true, sse: false, acp: false },
      sessionCapabilities: { resume: false, fork: false, close: false, list: false },
      systemPromptAppend: false,
      promptSteering: false,
      agentInfo: { name: 'fake-acp', title: 'Fake ACP', version: '1.0.0' },
    });

    const result = await session.send('hello');
    expect(result.nativeOutcome).toBe('completed');
    expect(result.localOutcome).toBe('resolved');
    expect(result.terminal).toEqual({ type: 'session/prompt', subtype: 'end_turn' });
    expect(result.externalSessionId).toBe('acp-sess-1');
    expect(result.content).toBe('Hello world: BASE CONTEXT\n\n[wrapped] hello');
    // inputTokens=100 included cachedReadTokens=20 (totalTokens=150, output=50) -> input=80, cacheRead=20.
    expect(result.tokens).toMatchObject({
      input: 80,
      output: 50,
      cacheRead: 20,
      thinking: 10,
    });
    expect(session.turns).toBe(1);
    expect(session.totalTokens).toEqual({ input: 80, output: 50 });

    const kinds = result.events.map((e) => e.kind);
    expect(kinds).toEqual([
      'thinking',
      'native_status',
      'tool_use',
      'tool_result',
      'usage',
      'text_delta',
      'text_delta',
      'result',
    ]);

    const toolUse = result.events.find((e) => e.kind === 'tool_use');
    expect(toolUse).toMatchObject({
      callId: 'tc-1',
      toolName: 'mcp__foundry__read_file',
      toolServer: 'foundry',
      toolMethod: 'read_file',
      toolInput: { path: 'README.md' },
    });

    const toolResult = result.events.find((e) => e.kind === 'tool_result');
    expect(toolResult).toMatchObject({
      callId: 'tc-1',
      toolOutput: 'file contents',
      toolError: false,
    });

    const artifact = session.artifact();
    expect(artifact.turns).toBe(1);
    expect(artifact.toolCalls).toBe(1);
    expect(artifact.toolResults).toBe(1);
    expect(artifact.errors).toBe(0);
    expect(events.some((e) => e.kind === 'session_start')).toBe(true);
  });

  test('prewrite-v1 onAdmission rejection prevents dispatching session/prompt', async () => {
    const session = track();
    await session.start();
    const err = await session
      .send('should not run', {
        onAdmission: () => {
          throw new Error('admission denied');
        },
      })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SessionTurnError);
    expect((err as SessionTurnError).attempt).toMatchObject({
      dispatch: 'not-dispatched',
      localOutcome: 'rejected',
      localFailure: 'registration',
    });
    expect(session.turns).toBe(0);
    // Session remains usable after a prewrite refusal.
    const next = await session.send('runs fine');
    expect(next.nativeOutcome).toBe('completed');
    expect(session.turns).toBe(1);
  });

  test('send() forwards base64 images when supported and refuses before write when unsupported', async () => {
    const img = {
      mediaType: 'image/png' as const,
      data: Buffer.from('pngbytes').toString('base64'),
    };

    const withImages = track();
    await withImages.start();
    const res = await withImages.send('inspect-launch', { images: [img] });
    const parsed = JSON.parse(res.content) as {
      promptBlocks: Array<{ type: string; mimeType?: string; data?: string; text?: string }>;
    };
    expect(parsed.promptBlocks).toEqual([
      { type: 'text', text: 'inspect-launch' },
      { type: 'image', mimeType: 'image/png', data: img.data },
    ]);

    const noImages = track({ env: { FAKE_ACP_IMAGE: '0' } });
    await noImages.start();
    expect(noImages.serverCapabilities?.promptCapabilities.image).toBe(false);
    await expect(noImages.send('hi', { images: [img] })).rejects.toThrow('image prompt capability');
    expect(noImages.attempts).toHaveLength(0);
  });

  test('session/load cold resumes an existing session without polluting live turns', async () => {
    const events: SessionEvent[] = [];
    const session = track({ externalSessionId: 'existing-session' });
    session.onEvent((e) => events.push(e));
    await session.start();

    expect(session.externalSessionId).toBe('existing-session');
    // Replayed chunk during session/load stays unattributed session-configuration.
    const replayed = events.find(
      (e) =>
        e.unattributedReason === 'session-configuration' &&
        (e.raw as { sessionUpdate?: string })?.sessionUpdate === 'agent_message_chunk',
    );
    expect(replayed).toBeDefined();

    const result = await session.send('after resume');
    expect(result.content).toBe('Hello world: after resume');
    expect(result.content).not.toContain('replayed history');
  });

  test('session/load maps missing session (-32002) and missing loadSession capability to NativeBindingMissingError', async () => {
    const missing = track({ externalSessionId: 'gone-session' });
    const err1 = await missing.start().catch((e: unknown) => e);
    expect(err1).toBeInstanceOf(NativeBindingMissingError);
    expect(nativeBindingMissing(err1)).toMatchObject({
      runtime: 'acp',
      binding: 'gone-session',
    });
    expect(missing.alive).toBe(false);

    const unsupported = track({
      externalSessionId: 'existing-session',
      env: { FAKE_ACP_LOAD_SESSION: '0' },
    });
    const err2 = await unsupported.start().catch((e: unknown) => e);
    expect(err2).toBeInstanceOf(NativeBindingMissingError);
    expect((err2 as NativeBindingMissingError).runtime).toBe('acp');
    expect(unsupported.alive).toBe(false);
  });

  test('session/request_permission routes through ToolGates: allow, deny, fail-closed, and bypassPermissions', async () => {
    // 1. Gated allow
    const seen: ToolRequest[] = [];
    const allowSession = track({ permissionMode: 'default' });
    allowSession.onToolRequest((req) => {
      seen.push(req);
      return { behavior: 'allow' };
    });
    await allowSession.start();
    const allowRes = await allowSession.send('ask-permission');
    expect(allowRes.content).toBe('selected:allow_once');
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      stage: 'permission',
      toolName: 'shell',
      callId: 'call-perm-1',
      toolInput: { command: 'rm -rf /tmp/test' },
    });

    // 2. Gated deny
    const denySession = track({ permissionMode: 'default' });
    denySession.onToolRequest(() => ({ behavior: 'deny', message: 'not allowed' }));
    await denySession.start();
    const denyRes = await denySession.send('ask-permission');
    expect(denyRes.content).toBe('selected:reject_once');

    // 3. Fail-closed when gated with no handler registered
    const noHandlerSession = track({ permissionMode: 'default' });
    await noHandlerSession.start();
    const failClosedRes = await noHandlerSession.send('ask-permission');
    expect(failClosedRes.content).toBe('selected:reject_once');

    // 4. Auto-approve under bypassPermissions; onToolRequest throws
    const bypassSession = track({ permissionMode: 'bypassPermissions' });
    expect(() => bypassSession.onToolRequest(() => ({ behavior: 'allow' }))).toThrow(
      'bypassPermissions',
    );
    await bypassSession.start();
    const bypassRes = await bypassSession.send('ask-permission');
    expect(bypassRes.content).toBe('selected:allow_once');
  });

  test('unsupported inbound client requests are explicitly refused with -32601', async () => {
    const session = track();
    await session.start();
    const res = await session.send('unsupported-client-request');
    expect(res.content).toBe('refused:-32601');
  });

  test('interruptNative() sends session/cancel, returns acknowledged, and releases ownership for the next turn', async () => {
    const session = track();
    await session.start();
    expect(await session.interruptNative()).toBe('no-turn');

    const pending = session.send('hold');
    await tick(40);

    const outcome = await session.interruptNative({ timeoutMs: 2_000 });
    expect(outcome).toBe('acknowledged');

    const cancelled = await pending;
    expect(cancelled.nativeOutcome).toBe('failed');
    expect(cancelled.terminal).toEqual({ type: 'session/prompt', subtype: 'cancelled' });
    expect(cancelled.content).toBe('working...');

    const next = await session.send('after cancel');
    expect(next.nativeOutcome).toBe('completed');
    expect(next.content).toBe('Hello world: after cancel');
  });

  test('applies initial model and effort via session/set_config_option and session/set_model', async () => {
    // 1. config_option path (both model and effort)
    const viaConfig = track({
      model: 'gemini-3.1-pro',
      effort: 'high',
      env: { FAKE_ACP_MODEL_MODE: 'config_option', FAKE_ACP_EFFORT_OPTION: '1' },
    });
    await viaConfig.start();
    const cfgRes = JSON.parse((await viaConfig.send('inspect-launch')).content) as {
      model: string;
      effort: string;
    };
    expect(cfgRes).toMatchObject({ model: 'gemini-3.1-pro', effort: 'high' });

    // 2. session/set_model path when no model config option is advertised
    const viaSetModel = track({
      model: 'gemini-3.1-pro',
      effort: 'low',
      env: { FAKE_ACP_MODEL_MODE: 'set_model', FAKE_ACP_EFFORT_OPTION: '1' },
    });
    await viaSetModel.start();
    const smRes = JSON.parse((await viaSetModel.send('inspect-launch')).content) as {
      model: string;
      effort: string;
    };
    expect(smRes).toMatchObject({ model: 'gemini-3.1-pro', effort: 'low' });

    // 3. Unknown model maps to NativeModelMissingError
    const badModel = track({
      model: 'nonexistent-model',
      env: { FAKE_ACP_MODEL_MODE: 'set_model' },
    });
    await expect(badModel.start()).rejects.toBeInstanceOf(NativeModelMissingError);

    // 4. -32601 on session/set_model degrades cleanly without failing start()
    const unsupportedModel = track({
      model: 'gemini-3.1-pro',
      env: { FAKE_ACP_MODEL_MODE: 'unsupported', FAKE_ACP_EFFORT_OPTION: '0' },
    });
    await unsupportedModel.start();
    expect(unsupportedModel.alive).toBe(true);
  });

  test('mcpServers passthrough respects server mcpCapabilities and agyAcpLaunch strips competing env vars', async () => {
    const priorGemini = process.env.GEMINI_API_KEY;
    const priorGoogle = process.env.GOOGLE_API_KEY;
    const priorCreds = process.env.GOOGLE_APPLICATION_CREDENTIALS;
    const priorVertex = process.env.GOOGLE_GENAI_USE_VERTEXAI;
    const priorAuthOverride = process.env.GEMINI_CLI_AUTH_OVERRIDE;
    process.env.GEMINI_API_KEY = 'secret-gemini-key';
    process.env.GOOGLE_API_KEY = 'secret-google-key';
    process.env.GOOGLE_APPLICATION_CREDENTIALS = '/tmp/sa.json';
    process.env.GOOGLE_GENAI_USE_VERTEXAI = '1';
    process.env.GEMINI_CLI_AUTH_OVERRIDE = 'api-key';
    try {
      const agyCfg = agyAcpLaunch({
        bin: '/usr/local/bin/agy',
        permissionMode: 'bypassPermissions',
        sandbox: true,
        addDirs: ['/extra/a', '/extra/b'],
        appDataDir: '/tmp/agy-data',
        geminiDir: '/tmp/gemini-dir',
        agent: 'coder',
      });
      expect(agyCfg.command).toEqual([
        '/usr/local/bin/agy',
        'acp',
        '--stdio',
        '--dangerously-skip-permissions',
        '--sandbox',
        '--app-data-dir',
        '/tmp/agy-data',
        '--gemini-dir',
        '/tmp/gemini-dir',
        '--agent',
        'coder',
        '--add-dir',
        '/extra/a',
        '--add-dir',
        '/extra/b',
      ]);
      expect(agyCfg.stripEnv).toEqual(AGY_COMPETING_ENV);

      const geminiCfg = geminiCliAcpLaunch({
        permissionMode: 'acceptEdits',
        model: 'gemini-3.1-pro',
        sandbox: true,
        skipTrust: true,
        addDirs: ['/extra/g'],
      });
      expect(geminiCfg.command).toEqual([
        'gemini',
        '--acp',
        '--approval-mode',
        'auto_edit',
        '--model',
        'gemini-3.1-pro',
        '--sandbox',
        '--skip-trust',
        '--include-directories',
        '/extra/g',
      ]);
      expect(geminiCfg.stripEnv).toEqual(GEMINI_CLI_COMPETING_ENV);

      // Live subprocess verification: competing env vars are stripped, non-competing survive,
      // and mcpServers are filtered by mcpCapabilities (http: true, sse: false).
      const session = track({
        stripEnv: agyCfg.stripEnv,
        env: { CUSTOM_VAR: 'kept' },
        mcpServers: [
          {
            name: 'local-stdio',
            command: 'node',
            args: ['srv.js'],
            env: [{ name: 'A', value: '1' }],
          },
          {
            type: 'http',
            name: 'foundry-http',
            url: 'http://127.0.0.1:4500/mcp',
            headers: [{ name: 'Authorization', value: 'Bearer x' }],
          },
          {
            type: 'sse',
            name: 'dropped-sse',
            url: 'http://127.0.0.1:4500/sse',
            headers: [],
          },
        ],
      });
      await session.start();

      const envSnapshot = JSON.parse((await session.send('env-check')).content) as Record<
        string,
        string | null
      >;
      expect(envSnapshot).toEqual({
        GEMINI_API_KEY: null,
        GOOGLE_API_KEY: null,
        GOOGLE_APPLICATION_CREDENTIALS: null,
        GOOGLE_GENAI_USE_VERTEXAI: null,
        GEMINI_CLI_AUTH_OVERRIDE: null,
        CUSTOM_VAR: 'kept',
      });

      const launchSnapshot = JSON.parse((await session.send('inspect-launch')).content) as {
        cwd: string;
        mcpServers: Array<{ name: string; type?: string }>;
      };
      expect(isAbsolute(launchSnapshot.cwd)).toBe(true);
      expect(launchSnapshot.mcpServers.map((s) => s.name)).toEqual(['local-stdio', 'foundry-http']);

      // billing: 'api' preserves API keys when explicitly requested.
      const apiCfg = agyAcpLaunch({ billing: 'api' });
      expect(apiCfg.stripEnv).toBeUndefined();
    } finally {
      if (priorGemini === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = priorGemini;
      if (priorGoogle === undefined) delete process.env.GOOGLE_API_KEY;
      else process.env.GOOGLE_API_KEY = priorGoogle;
      if (priorCreds === undefined) delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
      else process.env.GOOGLE_APPLICATION_CREDENTIALS = priorCreds;
      if (priorVertex === undefined) delete process.env.GOOGLE_GENAI_USE_VERTEXAI;
      else process.env.GOOGLE_GENAI_USE_VERTEXAI = priorVertex;
      if (priorAuthOverride === undefined) delete process.env.GEMINI_CLI_AUTH_OVERRIDE;
      else process.env.GEMINI_CLI_AUTH_OVERRIDE = priorAuthOverride;
    }
  });

  test('child crash mid-turn settles in-flight and queued turns cleanly without hanging', async () => {
    const session = track();
    await session.start();

    const first = session.send('crash').catch((e: unknown) => e);
    const second = session.send('queued behind crash').catch((e: unknown) => e);

    const [err1, err2] = await Promise.all([first, second]);
    expect(err1).toBeInstanceOf(SessionTurnError);
    expect((err1 as SessionTurnError).attempt).toMatchObject({
      localOutcome: 'rejected',
      localFailure: 'transport',
      transportOutcome: 'failed',
      content: 'partial before crash',
    });
    expect(err2).toBeInstanceOf(SessionTurnError);
    expect((err2 as SessionTurnError).attempt).toMatchObject({
      localOutcome: 'rejected',
      localFailure: 'blocked',
      dispatch: 'not-dispatched',
    });
    expect(session.alive).toBe(false);
    expect(session.events.some((e) => e.kind === 'session_end')).toBe(true);
  });

  test('close() escalates SIGTERM -> SIGKILL when child ignores SIGTERM and settles pending turns', async () => {
    const session = track({ env: { FAKE_ACP_IGNORE_SIGTERM: '1' } });
    await session.start();

    const pending = session.send('hold').catch((e: unknown) => e);
    await tick(40);

    await session.close({ graceMs: 100 });
    const err = await pending;
    expect(err).toBeInstanceOf(SessionTurnError);
    expect((err as SessionTurnError).attempt).toMatchObject({
      localOutcome: 'rejected',
      localFailure: 'killed',
      transportOutcome: 'closed',
    });
    expect(session.alive).toBe(false);
  });

  test('session/prompt JSON-RPC error rejects with rpc failure and keeps session usable', async () => {
    const session = track();
    await session.start();

    const err = await session.send('rpc-error').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SessionTurnError);
    expect((err as SessionTurnError).attempt).toMatchObject({
      rpcOutcome: 'failed',
      nativeOutcome: 'failed',
      localOutcome: 'rejected',
      localFailure: 'rpc',
    });

    const next = await session.send('recover');
    expect(next.nativeOutcome).toBe('completed');
    expect(next.content).toBe('Hello world: recover');
  });

  test('interruptNative() aborts a pending async permission gate and replies cancelled', async () => {
    let gateAborted = false;
    const session = track({ permissionMode: 'default' });
    session.onToolRequest(
      (req) =>
        new Promise((resolve) => {
          req.signal?.addEventListener('abort', () => {
            gateAborted = true;
            resolve({ behavior: 'deny', message: 'aborted' });
          });
        }),
    );
    await session.start();

    const pending = session.send('ask-permission');
    await tick(40);
    const outcome = await session.interruptNative({ timeoutMs: 2_000 });
    expect(outcome).toBe('acknowledged');
    expect(gateAborted).toBe(true);
    const result = await pending;
    expect(result.content).toBe('outcome:cancelled');
  });

  test('baseContext survives a rejected first-turn admission and is prepended on the first dispatched turn', async () => {
    const session = track({ baseContext: 'STICKY BASE' });
    await session.start();

    await expect(
      session.send('rejected turn', {
        onAdmission: () => {
          throw new Error('blocked');
        },
      }),
    ).rejects.toBeInstanceOf(SessionTurnError);

    const second = await session.send('actual first turn');
    expect(second.content).toBe('Hello world: STICKY BASE\n\nactual first turn');

    const third = await session.send('second dispatched turn');
    expect(third.content).toBe('Hello world: second dispatched turn');
  });

  test('relative cwd is resolved to an absolute path and invalid model config option maps to NativeModelMissingError', async () => {
    const session = track({ cwd: '.' });
    await session.start();
    const snap = JSON.parse((await session.send('inspect-launch')).content) as { cwd: string };
    expect(isAbsolute(snap.cwd)).toBe(true);
    expect(snap.cwd).toBe(resolve('.'));

    const badConfigModel = track({
      model: 'nonexistent-model',
      env: { FAKE_ACP_MODEL_MODE: 'config_option' },
    });
    const events: SessionEvent[] = [];
    badConfigModel.onEvent((e) => events.push(e));
    await expect(badConfigModel.start()).rejects.toBeInstanceOf(NativeModelMissingError);
    // Failed start never emitted session_start, so it must not emit session_end.
    expect(events.some((e) => e.kind === 'session_start')).toBe(false);
    expect(events.some((e) => e.kind === 'session_end')).toBe(false);
  });

  test('cancel/permission race: permission ask arriving during interruptNative() is cancelled even under bypassPermissions', async () => {
    let promptId: number | undefined;
    const fake = fakeProcess((m: Record<string, unknown>, io) => {
      if (m.method === 'initialize') {
        io.emit({
          jsonrpc: '2.0',
          id: m.id,
          result: { protocolVersion: 1, agentCapabilities: {} },
        });
      } else if (m.method === 'session/new') {
        io.emit({ jsonrpc: '2.0', id: m.id, result: { sessionId: 'race-sess' } });
      } else if (m.method === 'session/prompt') {
        promptId = m.id as number;
      } else if (m.method === 'session/cancel') {
        // Agent had a permission ask in flight right as cancel arrived.
        io.emit({
          jsonrpc: '2.0',
          id: 'late-perm',
          method: 'session/request_permission',
          params: {
            sessionId: 'race-sess',
            toolCall: { toolCallId: 'tc-race', name: 'shell', rawInput: { command: 'echo hi' } },
            options: [{ optionId: 'allow_once', name: 'Allow', kind: 'allow_once' }],
          },
        });
      } else if (m.id === 'late-perm' && promptId !== undefined) {
        io.emit({ jsonrpc: '2.0', id: promptId, result: { stopReason: 'cancelled' } });
      }
    });

    const session = track({ permissionMode: 'bypassPermissions', spawn: () => fake.proc });
    await session.start();

    const pending = session.send('run');
    await tick(10);
    const outcome = await session.interruptNative({ timeoutMs: 1_000 });
    expect(outcome).toBe('acknowledged');
    const result = await pending;
    expect(result.nativeOutcome).toBe('failed');

    const permReply = fake.lines.find((line) => line.id === 'late-perm');
    expect(permReply?.result).toEqual({ outcome: { outcome: 'cancelled' } });
  });

  test('foreign-session, loading-session, and idle permission requests are cancelled without calling gates or bypassPermissions', async () => {
    let loadPromptResolve: (() => void) | undefined;
    const fake = fakeProcess((m: Record<string, unknown>, io) => {
      if (m.method === 'initialize') {
        io.emit({
          jsonrpc: '2.0',
          id: m.id,
          result: { protocolVersion: 1, agentCapabilities: { loadSession: true } },
        });
      } else if (m.method === 'session/load') {
        // Send a permission request while session/load is still in progress.
        io.emit({
          jsonrpc: '2.0',
          id: 'perm-loading',
          method: 'session/request_permission',
          params: {
            sessionId: 'sess-1',
            toolCall: { toolCallId: 'tc-load', name: 'shell' },
            options: [{ optionId: 'allow_once', name: 'Allow', kind: 'allow_once' }],
          },
        });
        loadPromptResolve = () => io.emit({ jsonrpc: '2.0', id: m.id, result: {} });
      } else if (m.id === 'perm-loading') {
        loadPromptResolve?.();
      } else if (m.method === 'session/prompt') {
        // Emit a foreign-session permission request during a real turn, then finish.
        io.emit({
          jsonrpc: '2.0',
          id: 'perm-foreign',
          method: 'session/request_permission',
          params: {
            sessionId: 'other-session',
            toolCall: { toolCallId: 'tc-foreign', name: 'shell' },
            options: [{ optionId: 'allow_once', name: 'Allow', kind: 'allow_once' }],
          },
        });
        setTimeout(() => {
          io.emit({ jsonrpc: '2.0', id: m.id, result: { stopReason: 'end_turn' } });
        }, 15);
      }
    });

    const events: SessionEvent[] = [];
    const session = track({
      externalSessionId: 'sess-1',
      permissionMode: 'bypassPermissions',
      spawn: () => fake.proc,
    });
    session.onEvent((e) => events.push(e));
    await session.start();

    // Idle permission request when no turn is in flight.
    fake.io.emit({
      jsonrpc: '2.0',
      id: 'perm-idle',
      method: 'session/request_permission',
      params: {
        sessionId: 'sess-1',
        toolCall: { toolCallId: 'tc-idle', name: 'shell' },
        options: [{ optionId: 'allow_once', name: 'Allow', kind: 'allow_once' }],
      },
    });
    await tick(10);

    await session.send('hello');

    expect(fake.lines.find((l) => l.id === 'perm-loading')?.result).toEqual({
      outcome: { outcome: 'cancelled' },
    });
    expect(fake.lines.find((l) => l.id === 'perm-idle')?.result).toEqual({
      outcome: { outcome: 'cancelled' },
    });
    expect(fake.lines.find((l) => l.id === 'perm-foreign')?.result).toEqual({
      outcome: { outcome: 'cancelled' },
    });
    expect(events.some((e) => e.unattributedReason === 'foreign-session')).toBe(true);
  });

  test('prewrite-v1: unsolicited session/update during pending onAdmission is unattributed and never pollutes turn evidence', async () => {
    const fake = fakeProcess((m: Record<string, unknown>, io) => {
      if (m.method === 'initialize') {
        io.emit({
          jsonrpc: '2.0',
          id: m.id,
          result: { protocolVersion: 1, agentCapabilities: {} },
        });
      } else if (m.method === 'session/new') {
        io.emit({ jsonrpc: '2.0', id: m.id, result: { sessionId: 'prewrite-sess' } });
      } else if (m.method === 'session/prompt') {
        io.emit({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: 'prewrite-sess',
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'real answer' },
            },
          },
        });
        io.emit({ jsonrpc: '2.0', id: m.id, result: { stopReason: 'end_turn' } });
      }
    });

    const events: SessionEvent[] = [];
    const session = track({ spawn: () => fake.proc });
    session.onEvent((e) => events.push(e));
    await session.start();

    const result = await session.send('hi', {
      onAdmission: async () => {
        // Unsolicited chunk arrives before session/prompt is written.
        fake.io.emit({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: 'prewrite-sess',
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'unsolicited noise' },
            },
          },
        });
        await tick(10);
      },
    });

    expect(result.content).toBe('real answer');
    expect(result.content).not.toContain('unsolicited noise');
    const unattributed = events.find((e) => e.unattributedReason === 'no-admission');
    expect(unattributed).toBeDefined();
  });

  test('JsonRpcConnection.respond(id, undefined) emits result: null and fast exit drains buffered stdout', async () => {
    const fake = fakeProcess((m: Record<string, unknown>, io) => {
      if (m.method === 'ping') {
        io.emit({ jsonrpc: '2.0', id: m.id, result: { ok: true } });
        io.exit(0);
      }
    });
    const rpc = new JsonRpcConnection(fake.proc, {
      onRequest: (id, method) => {
        if (method === 'notify_like') {
          rpc.respond(id, undefined);
          return true;
        }
        return false;
      },
    });

    fake.io.emit({ jsonrpc: '2.0', id: 'r-undef', method: 'notify_like', params: {} });
    await tick(10);
    const reply = fake.lines.find((l) => l.id === 'r-undef');
    expect(reply).toEqual({ jsonrpc: '2.0', id: 'r-undef', result: null });

    const res = await rpc.request('ping');
    expect(res).toEqual({ ok: true });
  });

  test('close() after kill() still awaits actual child termination', async () => {
    let exited = false;
    const fake = fakeProcess((m: Record<string, unknown>, io) => {
      if (m.method === 'initialize') {
        io.emit({
          jsonrpc: '2.0',
          id: m.id,
          result: { protocolVersion: 1, agentCapabilities: {} },
        });
      } else if (m.method === 'session/new') {
        io.emit({ jsonrpc: '2.0', id: m.id, result: { sessionId: 'close-after-kill' } });
      }
    });
    const proc = {
      ...fake.proc,
      kill() {
        setTimeout(() => {
          exited = true;
          fake.io.exit(0);
        }, 60);
      },
    };
    const session = track({ spawn: () => proc });
    await session.start();

    session.kill();
    expect(exited).toBe(false);
    await session.close();
    expect(exited).toBe(true);
    expect(session.alive).toBe(false);
  });

  test('Antigravity native systemPrompt append, session/resume preference, mode mapping, and session/close', async () => {
    const seenMethods: string[] = [];
    let receivedMeta: unknown;
    let receivedPromptText = '';
    const fake = fakeProcess((m: Record<string, unknown>, io) => {
      seenMethods.push(String(m.method));
      if (m.method === 'initialize') {
        io.emit({
          jsonrpc: '2.0',
          id: m.id,
          result: {
            protocolVersion: 1,
            agentInfo: { name: 'Antigravity ACP Server', version: '1.5.14' },
            agentCapabilities: {
              loadSession: true,
              sessionCapabilities: { resume: {}, close: {} },
              _meta: { antigravity: { systemPrompt: { append: true } } },
            },
          },
        });
      } else if (m.method === 'session/resume') {
        receivedMeta = (m.params as Record<string, unknown>)?._meta;
        io.emit({
          jsonrpc: '2.0',
          id: m.id,
          result: {
            modes: {
              currentModeId: 'default',
              availableModes: [
                { id: 'default', name: 'Default' },
                { id: 'accept-edits', name: 'Accept edits' },
                { id: 'plan', name: 'Plan' },
              ],
            },
            configOptions: [
              {
                id: 'mode',
                name: 'Mode',
                category: 'mode',
                type: 'select',
                currentValue: 'default',
                options: [
                  { value: 'default', name: 'Default' },
                  { value: 'accept-edits', name: 'Accept edits' },
                  { value: 'plan', name: 'Plan' },
                ],
              },
              {
                id: 'thought_level',
                name: 'Thinking Level',
                category: 'thought_level',
                type: 'select',
                currentValue: 'high',
                options: [
                  { value: 'low', name: 'Low' },
                  { value: 'medium', name: 'Medium' },
                  { value: 'high', name: 'High' },
                ],
              },
            ],
          },
        });
      } else if (m.method === 'session/set_config_option') {
        const p = m.params as { configId: string; value: string };
        io.emit({
          jsonrpc: '2.0',
          id: m.id,
          result: {
            configOptions: [
              {
                id: 'mode',
                name: 'Mode',
                category: 'mode',
                type: 'select',
                currentValue: p.configId === 'mode' ? p.value : 'default',
                options: [
                  { value: 'default', name: 'Default' },
                  { value: 'accept-edits', name: 'Accept edits' },
                  { value: 'plan', name: 'Plan' },
                ],
              },
              {
                id: 'thought_level',
                name: 'Thinking Level',
                category: 'thought_level',
                type: 'select',
                currentValue: 'high',
                options: [
                  { value: 'low', name: 'Low' },
                  { value: 'medium', name: 'Medium' },
                  { value: 'high', name: 'High' },
                ],
              },
            ],
          },
        });
      } else if (m.method === 'session/prompt') {
        const blocks = (m.params as { prompt: Array<{ text?: string }> }).prompt;
        receivedPromptText = blocks.map((b) => b.text ?? '').join('');
        io.emit({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: 'agy-sess-1',
            update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ok' } },
          },
        });
        io.emit({ jsonrpc: '2.0', id: m.id, result: { stopReason: 'end_turn' } });
      } else if (m.method === 'session/close') {
        io.emit({ jsonrpc: '2.0', id: m.id, result: {} });
      }
    });

    const events: SessionEvent[] = [];
    const session = track({
      externalSessionId: 'agy-sess-1',
      baseContext: 'STANDING LAYER',
      permissionMode: 'acceptEdits',
      // Model only offers low/medium/high: xhigh degrades gracefully instead of aborting start().
      effort: 'xhigh',
      spawn: () => fake.proc,
    });
    session.onEvent((e) => events.push(e));
    await session.start();

    expect(session.serverCapabilities?.systemPromptAppend).toBe(true);
    expect(seenMethods).toContain('session/resume');
    expect(seenMethods).not.toContain('session/load');
    expect(receivedMeta).toEqual({ antigravity: { systemPrompt: { append: 'STANDING LAYER' } } });
    expect(session.currentModeId).toBe('accept-edits');
    expect(
      events.some(
        (e) =>
          e.kind === 'native_status' && (e.raw as { type?: string })?.type === 'effort-unsupported',
      ),
    ).toBe(true);

    const res = await session.send('hello');
    expect(res.content).toBe('ok');
    // baseContext went through native systemPrompt append, never prepended to user text.
    expect(receivedPromptText).toBe('hello');

    await session.close();
    expect(seenMethods).toContain('session/close');
  });

  test('falls back to session/load when session/resume returns -32601', async () => {
    const seen: string[] = [];
    const fake = fakeProcess((m: Record<string, unknown>, io) => {
      seen.push(String(m.method));
      if (m.method === 'initialize') {
        io.emit({
          jsonrpc: '2.0',
          id: m.id,
          result: {
            protocolVersion: 1,
            agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {} } },
          },
        });
      } else if (m.method === 'session/resume') {
        io.emit({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'Method not found' } });
      } else if (m.method === 'session/load') {
        io.emit({ jsonrpc: '2.0', id: m.id, result: {} });
      }
    });
    const session = track({ externalSessionId: 'fallback-sess', spawn: () => fake.proc });
    await session.start();
    expect(seen).toEqual(['initialize', 'session/resume', 'session/load']);
  });

  test('interaction_* user-input requests are cancelled even under bypassPermissions, and MCP/combinedOutput normalize', async () => {
    const fake = fakeProcess((m: Record<string, unknown>, io) => {
      if (m.method === 'initialize') {
        io.emit({
          jsonrpc: '2.0',
          id: m.id,
          result: { protocolVersion: 1, agentCapabilities: {} },
        });
      } else if (m.method === 'session/new') {
        io.emit({ jsonrpc: '2.0', id: m.id, result: { sessionId: 'agy-proto' } });
      } else if (m.method === 'session/prompt') {
        io.emit({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: 'agy-proto',
            update: {
              sessionUpdate: 'tool_call',
              toolCallId: 'mcp-1',
              title: 'Run call_mcp_tool',
              rawInput: { ServerName: 'foundry', ToolName: 'set_plan' },
              status: 'in_progress',
            },
          },
        });
        io.emit({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: 'agy-proto',
            update: {
              sessionUpdate: 'tool_call_update',
              toolCallId: 'mcp-1',
              status: 'completed',
              rawOutput: { combinedOutput: 'plan saved', exitCode: 0 },
            },
          },
        });
        io.emit({
          jsonrpc: '2.0',
          id: 'ask-q1',
          method: 'session/request_permission',
          params: {
            sessionId: 'agy-proto',
            toolCall: { toolCallId: 'interaction_abc', title: 'Pick an option', rawInput: {} },
            options: [
              { optionId: '1', name: 'Option A', kind: 'allow_once' },
              { optionId: '2', name: 'Option B', kind: 'allow_once' },
            ],
          },
        });
      } else if (m.id === 'ask-q1') {
        const prompt = fake.lines.find((l) => l.method === 'session/prompt');
        io.emit({ jsonrpc: '2.0', id: prompt.id, result: { stopReason: 'max_tokens' } });
      }
    });

    const session = track({ permissionMode: 'bypassPermissions', spawn: () => fake.proc });
    await session.start();
    const res = await session.send('work');

    // max_tokens is a non-end_turn stop -> failed nativeOutcome.
    expect(res.nativeOutcome).toBe('failed');
    expect(res.terminal).toEqual({ type: 'session/prompt', subtype: 'max_tokens' });

    // interaction_* was cancelled instead of auto-selecting option 1.
    const reply = fake.lines.find((l) => l.id === 'ask-q1');
    expect(reply?.result).toEqual({ outcome: { outcome: 'cancelled' } });

    // call_mcp_tool normalized to mcp__foundry__set_plan and combinedOutput extracted.
    const use = res.events.find((e) => e.kind === 'tool_use');
    expect(use).toMatchObject({
      toolName: 'mcp__foundry__set_plan',
      toolServer: 'foundry',
      toolMethod: 'set_plan',
    });
    const out = res.events.find((e) => e.kind === 'tool_result');
    expect(out?.toolOutput).toBe('plan saved');
  });

  test('startup fails fast on Antigravity auth URL prompt instead of hanging for startupTimeout', async () => {
    const fake = fakeProcess((m: Record<string, unknown>, io) => {
      if (m.method === 'initialize') {
        io.emitRaw(
          'Open the following link to authenticate the ACP server: https://accounts.google.com/o/oauth2/v2/auth',
        );
      }
    });
    const session = track({ startupTimeout: 10_000, spawn: () => fake.proc });
    const started = Date.now();
    await expect(session.start()).rejects.toThrow(/sign-in required/i);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  test('agyAcpLaunch disables auto-update by default and strips competing GCP/Antigravity env vars', () => {
    const cfg = agyAcpLaunch();
    expect(cfg.env?.AGY_CLI_DISABLE_AUTO_UPDATE).toBe('1');
    expect(cfg.env).toHaveProperty('CHROME_CRASHPAD_PIPE_NAME', undefined);
    expect(AGY_COMPETING_ENV).toContain('GOOGLE_CLOUD_PROJECT');
    expect(AGY_COMPETING_ENV).toContain('AGY_ACP_CCPA_PROJECT');
    expect(GEMINI_CLI_COMPETING_ENV).toContain('GOOGLE_CLOUD_PROJECT');
    const override = agyAcpLaunch({ env: { AGY_CLI_DISABLE_AUTO_UPDATE: '0' } });
    expect(override.env?.AGY_CLI_DISABLE_AUTO_UPDATE).toBe('0');
  });

  test('close() races cleanly: flips closing before session/close, refuses concurrent send, and never emits transportOutcome failed', async () => {
    let closeCalls = 0;
    const fake = fakeProcess((m: Record<string, unknown>, io) => {
      if (m.method === 'initialize') {
        io.emit({
          jsonrpc: '2.0',
          id: m.id,
          result: { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { close: {} } } },
        });
      } else if (m.method === 'session/new') {
        io.emit({
          jsonrpc: '2.0',
          id: m.id,
          result: {
            sessionId: 'close-race',
            configOptions: [
              {
                id: 'mode',
                name: 'Mode',
                category: 'mode',
                type: 'select',
                currentValue: 'default',
                options: [{ value: 'default', name: 'Default' }],
              },
              {
                id: 'thinking',
                name: 'Thinking',
                category: 'thinking',
                type: 'boolean',
                currentValue: true,
              },
            ],
          },
        });
      } else if (m.method === 'session/close') {
        closeCalls++;
        // Child exits immediately upon receiving session/close without replying.
        setTimeout(() => io.exit(0), 15);
      }
    });

    const events: SessionEvent[] = [];
    const session = track({ effort: 'high', spawn: () => fake.proc });
    session.onEvent((e) => events.push(e));
    await session.start();
    // Mode populated from configOptions even without legacy `modes`; boolean `thinking` ignored.
    expect(session.currentModeId).toBe('default');

    const c1 = session.close();
    const c2 = session.close();
    await expect(session.send('too late')).rejects.toThrow();
    await Promise.all([c1, c2]);

    expect(closeCalls).toBe(1);
    const ends = events.filter((e) => e.kind === 'session_end');
    expect(ends).toHaveLength(1);
    expect(ends[0]?.transportOutcome).toBeUndefined();
  });

  test('tool_call_update repeating call_mcp_tool preserves normalized MCP name and missing stopReason fails closed', async () => {
    const fake = fakeProcess((m: Record<string, unknown>, io) => {
      if (m.method === 'initialize') {
        io.emit({
          jsonrpc: '2.0',
          id: m.id,
          result: { protocolVersion: 1, agentCapabilities: {} },
        });
      } else if (m.method === 'session/new') {
        io.emit({ jsonrpc: '2.0', id: m.id, result: { sessionId: 'mcp-keep' } });
      } else if (m.method === 'session/prompt') {
        io.emit({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: 'mcp-keep',
            update: {
              sessionUpdate: 'tool_call',
              toolCallId: 'mcp-2',
              name: 'call_mcp_tool',
              rawInput: { ServerName: 'foundry', ToolName: 'set_plan' },
              status: 'in_progress',
            },
          },
        });
        io.emit({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: 'mcp-keep',
            update: {
              sessionUpdate: 'tool_call_update',
              toolCallId: 'mcp-2',
              name: 'call_mcp_tool',
              status: 'completed',
              rawOutput: { combinedOutput: 'done' },
            },
          },
        });
        // Omitted stopReason must fail closed.
        io.emit({ jsonrpc: '2.0', id: m.id, result: {} });
      }
    });

    const session = track({ spawn: () => fake.proc });
    await session.start();
    const res = await session.send('go');
    expect(res.nativeOutcome).toBe('failed');
    expect(res.terminal).toEqual({ type: 'session/prompt', subtype: 'missing' });
    const resultEvt = res.events.find((e) => e.kind === 'tool_result');
    expect(resultEvt).toMatchObject({
      toolName: 'mcp__foundry__set_plan',
      toolServer: 'foundry',
      toolMethod: 'set_plan',
      toolOutput: 'done',
    });
  });

  test('calling close() before start() does not poison later close() teardown', async () => {
    const fake = fakeProcess((m: Record<string, unknown>, io) => {
      if (m.method === 'initialize') {
        io.emit({
          jsonrpc: '2.0',
          id: m.id,
          result: { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { close: {} } } },
        });
      } else if (m.method === 'session/new') {
        io.emit({ jsonrpc: '2.0', id: m.id, result: { sessionId: 'pre-close' } });
      } else if (m.method === 'session/close') {
        io.emit({ jsonrpc: '2.0', id: m.id, result: {} });
      }
    });

    const session = track({ spawn: () => fake.proc });
    // Pre-start close is a no-op and must not cache a resolved _exitPromise.
    await session.close();
    await session.start();
    expect(session.alive).toBe(true);
    await session.close();
    expect(session.alive).toBe(false);
    expect(fake.killed).toBe(true);
    expect(fake.lines.some((m: Record<string, unknown>) => m.method === 'session/close')).toBe(
      true,
    );
  });

  test('agy >= 1.5.0 steers mid-turn via concurrent session/prompt and sums token usage across prompts', async () => {
    const prompts: Array<{ id: unknown; text: string }> = [];
    const fake = fakeProcess((m: Record<string, unknown>, io) => {
      if (m.method === 'initialize') {
        io.emit({
          jsonrpc: '2.0',
          id: m.id,
          result: {
            protocolVersion: 1,
            agentInfo: { name: 'Antigravity ACP Server', version: '1.5.14' },
            agentCapabilities: {
              loadSession: true,
              sessionCapabilities: { resume: {}, close: {}, list: {} },
              _meta: { antigravity: { systemPrompt: { append: true } } },
            },
          },
        });
      } else if (m.method === 'session/new') {
        io.emit({ jsonrpc: '2.0', id: m.id, result: { sessionId: 'agy-steer-1' } });
      } else if (m.method === 'session/prompt') {
        const blocks = (m.params as { prompt: Array<{ text?: string }> }).prompt;
        const text = blocks.map((b) => b.text ?? '').join('');
        prompts.push({ id: m.id, text });
        if (prompts.length === 1) {
          io.emit({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: 'agy-steer-1',
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: 'first-' },
              },
            },
          });
        } else if (prompts.length === 2) {
          // Prompt #1 is superseded (cancelled) by the steer; prompt #2 finishes the turn.
          io.emit({
            jsonrpc: '2.0',
            id: prompts[0]!.id,
            result: { stopReason: 'cancelled', usage: { inputTokens: 100, outputTokens: 20 } },
          });
          io.emit({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: 'agy-steer-1',
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: 'steered' },
              },
            },
          });
          io.emit({
            jsonrpc: '2.0',
            id: m.id,
            result: { stopReason: 'end_turn', usage: { inputTokens: 50, outputTokens: 30 } },
          });
        }
      }
    });

    const events: SessionEvent[] = [];
    const session = track({ spawn: () => fake.proc });
    session.onEvent((e) => events.push(e));
    await session.start();
    expect(session.serverCapabilities?.promptSteering).toBe(true);
    expect(session.serverCapabilities?.sessionCapabilities.list).toBe(true);
    // No active turn yet -> ignored.
    expect(await session.push({ kind: 'steer', text: 'too early' })).toMatchObject({
      outcome: 'ignored',
    });

    const turnPromise = session.send('start working');
    while (prompts.length < 1) await Bun.sleep(5);

    const pushOutcome = await session.push({ kind: 'steer', text: 'actually do B' });
    expect(pushOutcome).toEqual({ outcome: 'steered' });

    const res = await turnPromise;
    expect(prompts.map((p) => p.text)).toEqual(['start working', 'actually do B']);
    expect(res.nativeOutcome).toBe('completed');
    expect(res.content).toBe('first-steered');
    expect(res.tokens).toMatchObject({ input: 150, output: 50 });
    expect(
      events.some(
        (e) => e.kind === 'native_status' && (e.raw as { type?: string })?.type === 'push-steered',
      ),
    ).toBe(true);
  });

  test('usage_update is not double-counted when superseded prompt #1 settles without response.usage', async () => {
    const prompts: Array<{ id: unknown }> = [];
    const fake = fakeProcess((m: Record<string, unknown>, io) => {
      if (m.method === 'initialize') {
        io.emit({
          jsonrpc: '2.0',
          id: m.id,
          result: {
            protocolVersion: 1,
            agentInfo: { name: 'Antigravity ACP Server', version: 'v1.5.14' },
            agentCapabilities: { _meta: { antigravity: {} } },
          },
        });
      } else if (m.method === 'session/new') {
        io.emit({ jsonrpc: '2.0', id: m.id, result: { sessionId: 'agy-usage' } });
      } else if (m.method === 'session/prompt') {
        prompts.push({ id: m.id });
        if (prompts.length === 2) {
          // Steer emits a usage_update, then prompt #1 cancels without response.usage, then prompt #2 returns response.usage.
          io.emit({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: 'agy-usage',
              update: { sessionUpdate: 'usage_update', used: 50 },
            },
          });
          io.emit({ jsonrpc: '2.0', id: prompts[0]!.id, result: { stopReason: 'cancelled' } });
          io.emit({
            jsonrpc: '2.0',
            id: prompts[1]!.id,
            result: { stopReason: 'end_turn', usage: { inputTokens: 50, outputTokens: 30 } },
          });
        }
      }
    });

    const session = track({ spawn: () => fake.proc });
    await session.start();
    expect(session.serverCapabilities?.promptSteering).toBe(true);
    const turnPromise = session.send('go');
    while (prompts.length < 1) await Bun.sleep(5);
    expect(await session.push({ kind: 'steer', text: 'redirect' })).toEqual({ outcome: 'steered' });
    const res = await turnPromise;
    expect(res.tokens).toMatchObject({ input: 50, output: 30 });
  });

  test('prompt-steer settles cleanly when steer prompt resolves before original prompt, and surfaces steer RPC errors', async () => {
    const prompts: Array<{ id: unknown; text: string }> = [];
    const fake = fakeProcess((m: Record<string, unknown>, io) => {
      if (m.method === 'initialize') {
        io.emit({
          jsonrpc: '2.0',
          id: m.id,
          result: {
            protocolVersion: 1,
            agentInfo: { name: 'Antigravity ACP Server', version: '1.5.0' },
            agentCapabilities: { _meta: { antigravity: {} } },
          },
        });
      } else if (m.method === 'session/new') {
        io.emit({ jsonrpc: '2.0', id: m.id, result: { sessionId: 'agy-steer-order' } });
      } else if (m.method === 'session/prompt') {
        const blocks = (m.params as { prompt: Array<{ text?: string }> }).prompt;
        prompts.push({ id: m.id, text: blocks.map((b) => b.text ?? '').join('') });
        if (prompts.length === 2) {
          // Out-of-order: steer (#2) resolves end_turn BEFORE original (#1) resolves cancelled.
          io.emit({ jsonrpc: '2.0', id: prompts[1]!.id, result: { stopReason: 'end_turn' } });
          io.emit({ jsonrpc: '2.0', id: prompts[0]!.id, result: { stopReason: 'cancelled' } });
        } else if (prompts.length === 4) {
          // Turn 2: steer (#4) fails with an RPC error while original (#3) resolves end_turn.
          io.emit({
            jsonrpc: '2.0',
            id: prompts[3]!.id,
            error: { code: -32000, message: 'steer rejected' },
          });
          io.emit({ jsonrpc: '2.0', id: prompts[2]!.id, result: { stopReason: 'end_turn' } });
        }
      }
    });

    const session = track({ spawn: () => fake.proc });
    await session.start();

    const t1 = session.send('one');
    while (prompts.length < 1) await Bun.sleep(5);
    expect(await session.push({ kind: 'steer', text: 'steer-one' })).toEqual({
      outcome: 'steered',
    });
    const r1 = await t1;
    expect(r1.nativeOutcome).toBe('completed');

    const t2 = session.send('two');
    while (prompts.length < 3) await Bun.sleep(5);
    expect(await session.push({ kind: 'steer', text: 'steer-two' })).toEqual({
      outcome: 'steered',
    });
    await expect(t2).rejects.toThrow('steer rejected');
  });

  test('agy < 1.5.0, non-Antigravity ACP agents, and steerMode=none return ignored on push()', async () => {
    const makeAgent = (agentInfo: Record<string, string>, meta?: Record<string, unknown>) =>
      fakeProcess((m: Record<string, unknown>, io) => {
        if (m.method === 'initialize') {
          io.emit({
            jsonrpc: '2.0',
            id: m.id,
            result: {
              protocolVersion: 1,
              agentInfo,
              agentCapabilities: { ...(meta ? { _meta: meta } : {}) },
            },
          });
        } else if (m.method === 'session/new') {
          io.emit({ jsonrpc: '2.0', id: m.id, result: { sessionId: 'no-steer' } });
        } else if (m.method === 'session/prompt') {
          setTimeout(() => {
            io.emit({ jsonrpc: '2.0', id: m.id, result: { stopReason: 'end_turn' } });
          }, 40);
        }
      });

    // agy 1.4.9 cannot prompt-steer.
    const oldAgy = makeAgent(
      { name: 'Antigravity ACP Server', version: '1.4.9' },
      { antigravity: {} },
    );
    const s1 = track({ spawn: () => oldAgy.proc });
    await s1.start();
    expect(s1.serverCapabilities?.promptSteering).toBe(false);
    const p1 = s1.send('hi');
    await Bun.sleep(5);
    expect(await s1.push({ kind: 'steer', text: 'nope' })).toMatchObject({ outcome: 'ignored' });
    await p1;

    // agy 1.5.14 with steerMode: 'none' also refuses push().
    const disabled = makeAgent(
      { name: 'Antigravity ACP Server', version: '1.5.14' },
      { antigravity: {} },
    );
    const s2 = track({ steerMode: 'none', spawn: () => disabled.proc });
    await s2.start();
    expect(s2.serverCapabilities?.promptSteering).toBe(true);
    const p2 = s2.send('hi');
    await Bun.sleep(5);
    expect(await s2.push({ kind: 'steer', text: 'nope' })).toMatchObject({ outcome: 'ignored' });
    await p2;
  });

  test('interruptNative cancels a steered turn cleanly and blocks further steers while cancelling', async () => {
    const prompts: Array<{ id: unknown }> = [];
    const fake = fakeProcess((m: Record<string, unknown>, io) => {
      if (m.method === 'initialize') {
        io.emit({
          jsonrpc: '2.0',
          id: m.id,
          result: {
            protocolVersion: 1,
            agentInfo: { name: 'Antigravity ACP Server', version: '1.5.14' },
            agentCapabilities: { _meta: { antigravity: {} } },
          },
        });
      } else if (m.method === 'session/new') {
        io.emit({ jsonrpc: '2.0', id: m.id, result: { sessionId: 'agy-cancel' } });
      } else if (m.method === 'session/prompt') {
        prompts.push({ id: m.id });
      } else if (m.method === 'session/cancel') {
        for (const p of prompts.splice(0))
          io.emit({ jsonrpc: '2.0', id: p.id, result: { stopReason: 'cancelled' } });
      }
    });

    const session = track({ spawn: () => fake.proc });
    await session.start();
    const turnPromise = session.send('work');
    while (prompts.length < 1) await Bun.sleep(5);
    expect(await session.push({ kind: 'steer', text: 'change course' })).toEqual({
      outcome: 'steered',
    });
    while (prompts.length < 2) await Bun.sleep(5);
    const outcome = await session.interruptNative();
    expect(outcome).toBe('acknowledged');
    const res = await turnPromise;
    expect(res.nativeOutcome).toBe('failed');
    expect(res.terminal).toEqual({ type: 'session/prompt', subtype: 'cancelled' });
  });
});
