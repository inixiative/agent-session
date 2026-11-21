/**
 * Stand-in ACP v1 stdio agent for integration testing `AcpSession`.
 * Speaks JSON-RPC 2.0 over stdin/stdout (one JSON object per line).
 */

interface RpcMessage {
  jsonrpc?: string;
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: number; message: string };
}

const loadSession = process.env.FAKE_ACP_LOAD_SESSION !== '0';
const supportsImage = process.env.FAKE_ACP_IMAGE !== '0';
const supportsMcpHttp = process.env.FAKE_ACP_MCP_HTTP !== '0';
const supportsMcpSse = process.env.FAKE_ACP_MCP_SSE === '1';
const knownSessions = new Set(
  (process.env.FAKE_ACP_KNOWN_SESSIONS ?? 'existing-session')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
);
const modelMode = process.env.FAKE_ACP_MODEL_MODE ?? 'config_option';
const hasEffortOption = process.env.FAKE_ACP_EFFORT_OPTION !== '0';

if (process.env.FAKE_ACP_IGNORE_SIGTERM === '1') {
  process.on('SIGTERM', () => {
    // Deliberately ignore SIGTERM so tests can verify SIGKILL grace escalation.
  });
}

let sessionSeq = 0;
let activeSessionId = '';
let sessionCwd = '';
let sessionMcpServers: unknown[] = [];
let currentModel = 'default-model';
let currentEffort = 'medium';

const pendingClientRequests = new Map<string | number, { resolve: (msg: RpcMessage) => void }>();
const activeCancels = new Map<string, () => void>();

const send = (frame: Record<string, unknown>): void => {
  process.stdout.write(`${JSON.stringify(frame)}\n`);
};

const respond = (id: string | number, result: unknown): void => {
  send({ jsonrpc: '2.0', id, result });
};

const respondError = (id: string | number, code: number, message: string): void => {
  send({ jsonrpc: '2.0', id, error: { code, message } });
};

const notify = (method: string, params: Record<string, unknown>): void => {
  send({ jsonrpc: '2.0', method, params });
};

const clientRequest = (
  id: string | number,
  method: string,
  params: Record<string, unknown>,
): Promise<RpcMessage> =>
  new Promise((resolve) => {
    pendingClientRequests.set(id, { resolve });
    send({ jsonrpc: '2.0', id, method, params });
  });

function buildConfigOptions(): Array<Record<string, unknown>> {
  const options: Array<Record<string, unknown>> = [];
  if (modelMode === 'config_option') {
    options.push({
      id: 'model',
      name: 'Model',
      category: 'model',
      type: 'select',
      currentValue: currentModel,
      options: [
        { value: 'default-model', name: 'Default' },
        { value: 'gemini-3.1-pro', name: 'Gemini 3.1 Pro' },
      ],
    });
  }
  if (hasEffortOption) {
    options.push({
      id: 'effort',
      name: 'Effort',
      category: 'thought_level',
      type: 'select',
      currentValue: currentEffort,
      options: [
        { value: 'low', name: 'Low' },
        { value: 'medium', name: 'Medium' },
        { value: 'high', name: 'High' },
      ],
    });
  }
  return options;
}

function handleMessage(msg: RpcMessage): void {
  // Response to an agent->client request (e.g. session/request_permission).
  if (!msg.method && msg.id !== undefined) {
    const waiter = pendingClientRequests.get(msg.id);
    if (waiter) {
      pendingClientRequests.delete(msg.id);
      waiter.resolve(msg);
    }
    return;
  }

  const method = msg.method;
  const params = msg.params ?? {};

  if (method === 'session/cancel') {
    const sid = typeof params.sessionId === 'string' ? params.sessionId : '';
    const cancel = activeCancels.get(sid);
    if (cancel) {
      activeCancels.delete(sid);
      cancel();
    }
    return;
  }

  if (msg.id === undefined) return;
  const id = msg.id;

  if (method === 'initialize') {
    respond(id, {
      protocolVersion: 1,
      agentInfo: { name: 'fake-acp', title: 'Fake ACP', version: '1.0.0' },
      agentCapabilities: {
        loadSession,
        promptCapabilities: {
          image: supportsImage,
          audio: false,
          embeddedContext: true,
        },
        mcpCapabilities: {
          http: supportsMcpHttp,
          sse: supportsMcpSse,
          acp: false,
        },
      },
    });
    return;
  }

  if (method === 'session/new') {
    activeSessionId = `acp-sess-${++sessionSeq}`;
    sessionCwd = typeof params.cwd === 'string' ? params.cwd : '';
    sessionMcpServers = Array.isArray(params.mcpServers) ? params.mcpServers : [];
    knownSessions.add(activeSessionId);
    respond(id, {
      sessionId: activeSessionId,
      modes: { currentModeId: 'default', availableModes: [{ id: 'default', name: 'Default' }] },
      configOptions: buildConfigOptions(),
    });
    return;
  }

  if (method === 'session/load') {
    const sid = typeof params.sessionId === 'string' ? params.sessionId : '';
    if (!knownSessions.has(sid)) {
      respondError(id, -32002, `Session not found: ${sid}`);
      return;
    }
    activeSessionId = sid;
    sessionCwd = typeof params.cwd === 'string' ? params.cwd : '';
    sessionMcpServers = Array.isArray(params.mcpServers) ? params.mcpServers : [];
    // Replay a historical message before replying to verify replay does not pollute live turns.
    notify('session/update', {
      sessionId: sid,
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'replayed history' },
      },
    });
    respond(id, {
      modes: { currentModeId: 'default', availableModes: [{ id: 'default', name: 'Default' }] },
      configOptions: buildConfigOptions(),
    });
    return;
  }

  if (method === 'session/set_model') {
    if (modelMode === 'unsupported') {
      respondError(id, -32601, 'Method not found: session/set_model');
      return;
    }
    const modelId = typeof params.modelId === 'string' ? params.modelId : '';
    if (modelId === 'nonexistent-model') {
      respondError(id, -32602, `Unknown model: ${modelId}`);
      return;
    }
    currentModel = modelId;
    respond(id, {});
    return;
  }

  if (method === 'session/set_config_option') {
    const configId = typeof params.configId === 'string' ? params.configId : '';
    const value = typeof params.value === 'string' ? params.value : '';
    if (configId === 'model') {
      if (value === 'nonexistent-model') {
        respondError(id, -32602, `Unknown model: ${value}`);
        return;
      }
      currentModel = value;
      respond(id, { configOptions: buildConfigOptions() });
      return;
    }
    if (configId === 'effort') {
      currentEffort = value;
      respond(id, { configOptions: buildConfigOptions() });
      return;
    }
    respondError(id, -32602, `Unknown config option: ${configId}`);
    return;
  }

  if (method === 'session/prompt') {
    const sid = typeof params.sessionId === 'string' ? params.sessionId : activeSessionId;
    const blocks = Array.isArray(params.prompt)
      ? (params.prompt as Array<Record<string, unknown>>)
      : [];
    const text = blocks
      .filter((b) => b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text as string)
      .join('\n');

    void runPrompt(id, sid, text, blocks);
    return;
  }

  respondError(id, -32601, `Unknown method: ${String(method)}`);
}

async function runPrompt(
  id: string | number,
  sid: string,
  text: string,
  blocks: Array<Record<string, unknown>>,
): Promise<void> {
  if (text.includes('crash')) {
    notify('session/update', {
      sessionId: sid,
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'partial before crash' },
      },
    });
    await Bun.sleep(10);
    process.exit(1);
  }

  if (text.includes('rpc-error')) {
    respondError(id, -32000, 'upstream failure');
    return;
  }

  if (text.includes('hold')) {
    notify('session/update', {
      sessionId: sid,
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'working...' },
      },
    });
    await new Promise<void>((resolve) => {
      activeCancels.set(sid, resolve);
    });
    respond(id, { stopReason: 'cancelled' });
    return;
  }

  if (text.includes('env-check')) {
    const snapshot = {
      GEMINI_API_KEY: process.env.GEMINI_API_KEY ?? null,
      GOOGLE_API_KEY: process.env.GOOGLE_API_KEY ?? null,
      GOOGLE_APPLICATION_CREDENTIALS: process.env.GOOGLE_APPLICATION_CREDENTIALS ?? null,
      CUSTOM_VAR: process.env.CUSTOM_VAR ?? null,
    };
    notify('session/update', {
      sessionId: sid,
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: JSON.stringify(snapshot) },
      },
    });
    respond(id, { stopReason: 'end_turn' });
    return;
  }

  if (text.includes('inspect-launch')) {
    const snapshot = {
      cwd: sessionCwd,
      mcpServers: sessionMcpServers,
      model: currentModel,
      effort: currentEffort,
      promptBlocks: blocks,
    };
    notify('session/update', {
      sessionId: sid,
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: JSON.stringify(snapshot) },
      },
    });
    respond(id, { stopReason: 'end_turn' });
    return;
  }

  if (text.includes('ask-permission')) {
    const reply = await clientRequest('perm-1', 'session/request_permission', {
      sessionId: sid,
      toolCall: {
        toolCallId: 'call-perm-1',
        name: 'shell',
        title: 'Run shell command',
        kind: 'execute',
        rawInput: { command: 'rm -rf /tmp/test' },
      },
      options: [
        { optionId: 'allow_once', name: 'Allow', kind: 'allow_once' },
        { optionId: 'reject_once', name: 'Reject', kind: 'reject_once' },
      ],
    });
    const outcome = (reply.result as { outcome?: { outcome?: string; optionId?: string } })
      ?.outcome;
    const summary =
      outcome?.outcome === 'selected'
        ? `selected:${outcome.optionId}`
        : `outcome:${outcome?.outcome ?? 'unknown'}`;
    notify('session/update', {
      sessionId: sid,
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: summary },
      },
    });
    respond(id, { stopReason: 'end_turn' });
    return;
  }

  if (text.includes('unsupported-client-request')) {
    const reply = await clientRequest('fs-1', 'fs/read_text_file', {
      sessionId: sid,
      path: '/etc/passwd',
    });
    const summary = reply.error ? `refused:${reply.error.code}` : 'unexpected-ok';
    notify('session/update', {
      sessionId: sid,
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: summary },
      },
    });
    respond(id, { stopReason: 'end_turn' });
    return;
  }

  // Default rich streaming turn: thought -> plan -> tool_call -> tool_call_update -> usage -> text chunks.
  notify('session/update', {
    sessionId: sid,
    update: {
      sessionUpdate: 'agent_thought_chunk',
      content: { type: 'text', text: 'Let me inspect the file.' },
    },
  });
  notify('session/update', {
    sessionId: sid,
    update: {
      sessionUpdate: 'plan',
      entries: [{ content: 'Read file', priority: 'high', status: 'in_progress' }],
    },
  });
  notify('session/update', {
    sessionId: sid,
    update: {
      sessionUpdate: 'tool_call',
      toolCallId: 'tc-1',
      name: 'mcp__foundry__read_file',
      title: 'Read README',
      kind: 'read',
      status: 'in_progress',
      rawInput: { path: 'README.md' },
    },
  });
  notify('session/update', {
    sessionId: sid,
    update: {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'tc-1',
      status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text: 'file contents' } }],
    },
  });
  notify('session/update', {
    sessionId: sid,
    update: {
      sessionUpdate: 'usage_update',
      used: 4200,
      size: 200000,
    },
  });
  notify('session/update', {
    sessionId: sid,
    update: {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'Hello ' },
    },
  });
  notify('session/update', {
    sessionId: sid,
    update: {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: `world: ${text}` },
    },
  });
  respond(id, {
    stopReason: 'end_turn',
    usage: {
      totalTokens: 150,
      inputTokens: 100,
      outputTokens: 50,
      cachedReadTokens: 20,
      thoughtTokens: 10,
    },
  });
}

const decoder = new TextDecoder();
let buffer = '';
for await (const chunk of Bun.stdin.stream()) {
  buffer += decoder.decode(chunk, { stream: true });
  const lines = buffer.split('\n');
  buffer = lines.pop() ?? '';
  for (const line of lines) {
    if (!line.trim()) continue;
    handleMessage(JSON.parse(line) as RpcMessage);
  }
}
if (buffer.trim()) handleMessage(JSON.parse(buffer) as RpcMessage);
process.exit(0);
