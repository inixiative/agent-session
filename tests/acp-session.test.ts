import { afterEach, describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import {
  AcpSession,
  type AcpSessionConfig,
  AGY_COMPETING_ENV,
  agyAcpLaunch,
  GEMINI_CLI_COMPETING_ENV,
  geminiCliAcpLaunch,
  NativeBindingMissingError,
  NativeModelMissingError,
  nativeBindingMissing,
  type SessionEvent,
  SessionTurnError,
  type ToolRequest,
  TRANSPORTS,
} from '../src';
import { tick } from './helpers/fake-process';

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
      sessionCapabilities: { resume: false, fork: false, close: false },
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
    process.env.GEMINI_API_KEY = 'secret-gemini-key';
    process.env.GOOGLE_API_KEY = 'secret-google-key';
    process.env.GOOGLE_APPLICATION_CREDENTIALS = '/tmp/sa.json';
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
        CUSTOM_VAR: 'kept',
      });

      const launchSnapshot = JSON.parse((await session.send('inspect-launch')).content) as {
        mcpServers: Array<{ name: string; type?: string }>;
      };
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
});
