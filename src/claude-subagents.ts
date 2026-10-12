// ---------------------------------------------------------------------------
// ClaudeSubagentSessions — decision roles as subagents of one side session
// ---------------------------------------------------------------------------
//
// One Claude CLI process per group (a Foundry thread) serves every decision
// role of that group as a subagent: each role is a custom agent whose system
// prompt is its instructions plus its stable context, so the subagent reads it
// from the prompt cache. Decisions that arrive together are fanned out in one
// turn of a dispatcher session:
//
//   dispatch  one user message lists the members (agent name + token); the
//             dispatcher calls the Agent tool once per member, in the
//             foreground. A PreToolUse hook answers every call: it replaces
//             the call's prompt with that member's exact input, so what a
//             subagent sees never depends on the dispatcher model. Calls it
//             cannot match are denied.
//   settle    each member settles on its own task frames (its subagent text,
//             usage and model), without waiting for the dispatcher's turn.
//   reset     the dispatcher's turn is rewound once it ends, so every
//             fan-out starts from the same empty conversation. A member the
//             dispatcher skipped is sent again in one more fan-out.
//
// Every member is a fresh subagent conversation: nothing of one decision
// reaches another. Groups above `maxMembers` split evenly across more side
// sessions of the group, which also serve overlapping fan-outs.
// ---------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PipedSubprocess } from './claude-code-session';
import { claudeRateLimitSnapshot, type LimitSnapshot, mergeLimits } from './limits';
import {
  DecisionError,
  type DecisionRequest,
  type DecisionResult,
  type PrimedEvent,
  type PrimedSessions,
  type PrimedSnapshot,
  type PrimeSpec,
} from './primed';

const DISPATCHER =
  'You dispatch work to subagents and never answer anything yourself. Each user message lists ' +
  'members as `<agent name> <token>`. Call the Agent tool once for every listed member, all calls ' +
  'in one single message: subagent_type = the agent name, description = the token, prompt = "-". ' +
  'After the results return, reply with exactly DONE.';

export interface ClaudeSubagentConfig {
  bin?: string;
  model: string;
  effort?: string;
  /** Private working directory for the side sessions. */
  cwd: string;
  /** Prepended to every member's system prompt. */
  baseInstructions?: string;
  /** Merged over process.env. API keys are always removed. */
  env?: Record<string, string | undefined>;
  spawn?: (
    argv: string[],
    options: { cwd: string; env: Record<string, string | undefined> },
  ) => PipedSubprocess;
  /** Members per fan-out; a larger batch splits evenly across side sessions. Default 12. */
  maxMembers?: number;
  /** Side sessions per group. Default 4. */
  maxSessionsPerGroup?: number;
  /** Decisions arriving within this window of each other fan out together. Default 25 ms. */
  batchWindowMs?: number;
  /** Close a side session idle this long. Default 30 min. */
  idleMs?: number;
  /** Default decision deadline. Default 30 s. */
  timeoutMs?: number;
  onEvent?: (event: PrimedEvent) => void;
}

interface Member {
  readonly spec: PrimeSpec;
  readonly request: DecisionRequest;
  readonly name: string;
  readonly token: string;
  readonly started: number;
  readonly deadline: number;
  admissionId?: string;
  toolUseId?: string;
  taskId?: string;
  dispatchedAt?: number;
  texts: string[];
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
  model?: string;
  violation?: string;
  settled: boolean;
  resolve(result: DecisionResult): void;
  reject(error: DecisionError): void;
}

interface Side {
  readonly group: string;
  readonly names: ReadonlySet<string>;
  readonly proc: PipedSubprocess;
  readonly dir: string;
  readonly generation: number;
  alive: boolean;
  ready: Promise<void>;
  busy: boolean;
  lastUsed: number;
  sessionId?: string;
  /** Members of the fan-out in flight, by token. */
  members: Map<string, Member>;
  onResult?: () => void;
  control: Map<string, { resolve(r: Record<string, unknown>): void; reject(e: Error): void }>;
}

interface Group {
  readonly id: string;
  /** Agent definitions seen for this group, by name. */
  defs: Map<string, { prompt: string; lastUsed: number }>;
  sides: Side[];
  batch: Member[];
  timer?: ReturnType<typeof setTimeout>;
  firstAt?: number;
  /** Chunks waiting for a free side session. */
  waiting: Member[][];
}

const hash = (value: string) => createHash('sha256').update(value).digest('hex');

export class ClaudeSubagentSessions implements PrimedSessions {
  readonly runtime = 'claude' as const;
  private readonly _config: ClaudeSubagentConfig &
    Required<
      Pick<
        ClaudeSubagentConfig,
        'maxMembers' | 'maxSessionsPerGroup' | 'batchWindowMs' | 'idleMs' | 'timeoutMs'
      >
    >;
  private _groups = new Map<string, Group>();
  private _limits?: LimitSnapshot;
  private _closed = false;
  private _generation = 0;
  private _idleTimer?: ReturnType<typeof setInterval>;

  constructor(config: ClaudeSubagentConfig) {
    if (!config.cwd?.startsWith('/'))
      throw Error('Claude subagent sessions require an absolute private working directory');
    this._config = {
      ...config,
      maxMembers: config.maxMembers ?? 12,
      maxSessionsPerGroup: config.maxSessionsPerGroup ?? 4,
      batchWindowMs: config.batchWindowMs ?? 25,
      idleMs: config.idleMs ?? 30 * 60_000,
      timeoutMs: config.timeoutMs ?? 30_000,
    };
    if (this._config.maxMembers < 1 || this._config.maxSessionsPerGroup < 1)
      throw Error('Invalid subagent session bounds');
  }

  limits(): LimitSnapshot | undefined {
    return this._limits;
  }

  snapshot(): PrimedSnapshot {
    const sides = [...this._groups.values()].flatMap((g) => g.sides);
    return {
      runtime: 'claude',
      closed: this._closed,
      generation: this._generation,
      processAlive: sides.some((s) => s.alive),
      sessions: sides.length,
      active: sides.reduce(
        (n, s) => n + [...s.members.values()].filter((m) => !m.settled).length,
        0,
      ),
      waiting: [...this._groups.values()].reduce(
        (n, g) => n + g.batch.length + g.waiting.reduce((m, c) => m + c.length, 0),
        0,
      ),
      ...(this._limits ? { limits: this._limits } : {}),
    };
  }

  /** Nothing is primed per key: a member's definition lives with its group's side sessions. */
  async evict(_key: string): Promise<void> {}

  decide(spec: PrimeSpec, request: DecisionRequest): Promise<DecisionResult> {
    if (this._closed)
      return Promise.reject(
        new DecisionError('Subagent sessions closed', 'closed', 'not-dispatched', true),
      );
    if (!spec.key || typeof spec.instructions !== 'string' || typeof request.input !== 'string')
      return Promise.reject(
        new DecisionError('Invalid decision request', 'admission', 'not-dispatched', true),
      );
    if (request.signal?.aborted)
      return Promise.reject(
        new DecisionError('Decision aborted before dispatch', 'aborted', 'not-dispatched', true),
      );
    this._idleTimer ??= setInterval(() => this._closeIdle(), Math.min(this._config.idleMs, 60_000));
    (this._idleTimer as { unref?: () => void }).unref?.();
    const prompt = [this._config.baseInstructions, spec.instructions, spec.context]
      .filter(Boolean)
      .join('\n\n');
    const name = `d-${hash(prompt).slice(0, 16)}`;
    const group = this._group(request.group ?? 'default');
    group.defs.set(name, { prompt, lastUsed: Date.now() });
    const started = Date.now();
    return new Promise<DecisionResult>((resolve, reject) => {
      const member: Member = {
        spec,
        request,
        name,
        token: `m${crypto.randomUUID().slice(0, 8)}`,
        started,
        deadline: started + (request.timeoutMs ?? this._config.timeoutMs),
        texts: [],
        tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        settled: false,
        resolve: (result) => {
          if (member.settled) return;
          member.settled = true;
          clearTimeout(timer);
          resolve(result);
        },
        reject: (error) => {
          if (member.settled) return;
          member.settled = true;
          clearTimeout(timer);
          reject(error);
        },
      };
      // Past its deadline a member is withdrawn: refused unsent, or its subagent is stopped.
      const timer = setTimeout(
        () => void this._withdraw(member, 'timeout'),
        member.deadline - started,
      );
      request.signal?.addEventListener('abort', () => void this._withdraw(member, 'aborted'), {
        once: true,
      });
      group.batch.push(member);
      group.firstAt ??= Date.now();
      clearTimeout(group.timer);
      const wait = Math.max(
        0,
        Math.min(
          this._config.batchWindowMs,
          group.firstAt + 4 * this._config.batchWindowMs - Date.now(),
        ),
      );
      group.timer = setTimeout(() => this._flush(group), wait);
    });
  }

  async readLimits(): Promise<LimitSnapshot | undefined> {
    return this._limits;
  }

  async close(): Promise<void> {
    if (this._closed) return;
    this._closed = true;
    clearInterval(this._idleTimer);
    const closed = () =>
      new DecisionError('Subagent sessions closed', 'closed', 'not-dispatched', true);
    for (const group of this._groups.values()) {
      clearTimeout(group.timer);
      for (const m of group.batch.splice(0)) m.reject(closed());
      for (const m of group.waiting.splice(0).flat()) m.reject(closed());
    }
    await Promise.all(
      [...this._groups.values()]
        .flatMap((g) => g.sides.splice(0))
        .map((s) => this._kill(s, 'close')),
    );
  }

  // -------------------------------------------------------------------------

  private _emit(event: PrimedEvent): void {
    try {
      this._config.onEvent?.(event);
    } catch {
      /* observers only */
    }
  }

  private _group(id: string): Group {
    let group = this._groups.get(id);
    if (!group) {
      group = { id, defs: new Map(), sides: [], batch: [], waiting: [] };
      this._groups.set(id, group);
    }
    return group;
  }

  /** Split the batch evenly into fan-outs of at most `maxMembers`, one per side session. */
  private _flush(group: Group): void {
    group.timer = undefined;
    group.firstAt = undefined;
    const members = group.batch.splice(0).filter((m) => !m.settled);
    if (!members.length) return;
    const chunks = Math.ceil(members.length / this._config.maxMembers);
    const size = Math.ceil(members.length / chunks);
    for (let i = 0; i < members.length; i += size) group.waiting.push(members.slice(i, i + size));
    this._drain(group);
  }

  private _drain(group: Group): void {
    while (group.waiting.length && !this._closed) {
      const chunk = group.waiting[0]!.filter((m) => !m.settled);
      if (!chunk.length) {
        group.waiting.shift();
        continue;
      }
      const needs = new Set(chunk.map((m) => m.name));
      let side = group.sides.find(
        (s) => s.alive && !s.busy && [...needs].every((n) => s.names.has(n)),
      );
      if (!side) {
        const idleLacking = group.sides.find((s) => !s.busy);
        if (group.sides.length >= this._config.maxSessionsPerGroup) {
          if (!idleLacking) return; // every side session is busy: the chunk waits
          // A side session without these definitions is replaced by one that has them all.
          group.sides.splice(group.sides.indexOf(idleLacking), 1);
          void this._kill(idleLacking, 'definitions changed');
        }
        side = this._spawn(group);
      }
      group.waiting.shift();
      side.busy = true;
      void this._fanOut(side, chunk).finally(() => {
        side!.busy = false;
        side!.lastUsed = Date.now();
        this._drain(group);
      });
    }
  }

  private _spawn(group: Group): Side {
    const generation = ++this._generation;
    const dir = mkdtempSync(join(tmpdir(), 'agent-session-agents-'));
    chmodSync(dir, 0o700);
    const agents: Record<string, unknown> = {};
    for (const [name, def] of group.defs)
      agents[name] = {
        description: 'decision role',
        prompt: def.prompt,
        model: this._config.model,
        tools: [],
      };
    const file = join(dir, 'agents.json');
    writeFileSync(file, JSON.stringify(agents), { mode: 0o600 });
    const argv = [
      this._config.bin ?? 'claude',
      '--print',
      '--verbose',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--model',
      this._config.model,
      ...(this._config.effort ? ['--effort', this._config.effort] : []),
      '--system-prompt',
      DISPATCHER,
      '--tools',
      'Agent',
      '--agents',
      file,
      '--strict-mcp-config',
      '--mcp-config',
      '{"mcpServers":{}}',
      '--disable-slash-commands',
      '--no-chrome',
      '--no-session-persistence',
      '--permission-mode',
      'bypassPermissions',
      '--max-turns',
      String(2 * this._config.maxMembers + 4),
      '--forward-subagent-text',
    ];
    const env: Record<string, string | undefined> = {
      ...process.env,
      ...this._config.env,
      DISABLE_AUTOUPDATER: '1',
    };
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_AUTH_TOKEN;
    for (const key of Object.keys(env)) if (env[key] === undefined) delete env[key];
    const t0 = performance.now();
    const proc = this._config.spawn
      ? this._config.spawn(argv, { cwd: this._config.cwd, env })
      : (Bun.spawn(argv, {
          cwd: this._config.cwd,
          env,
          stdin: 'pipe',
          stdout: 'pipe',
          stderr: 'pipe',
        }) as unknown as PipedSubprocess);
    const side: Side = {
      group: group.id,
      names: new Set(group.defs.keys()),
      proc,
      dir,
      generation,
      alive: true,
      ready: Promise.resolve(),
      busy: false,
      lastUsed: Date.now(),
      members: new Map(),
      control: new Map(),
    };
    group.sides.push(side);
    void this._read(side);
    void proc.exited.then(
      () => this._lost(side),
      () => this._lost(side),
    );
    side.ready = this._control(side, {
      subtype: 'initialize',
      hooks: { PreToolUse: [{ matcher: 'Agent', hookCallbackIds: ['members'] }] },
    }).then(() => {
      this._emit({ type: 'process-started', generation, ms: Math.round(performance.now() - t0) });
    });
    side.ready.catch(() => undefined);
    return side;
  }

  private _write(side: Side, message: unknown): void {
    side.proc.stdin.write(`${JSON.stringify(message)}\n`);
    side.proc.stdin.flush();
  }

  private _control(side: Side, request: Record<string, unknown>, timeoutMs = 30_000) {
    const id = `c-${crypto.randomUUID()}`;
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        side.control.delete(id);
        reject(Error(`${String(request.subtype)} unanswered`));
      }, timeoutMs);
      side.control.set(id, {
        resolve: (r) => {
          clearTimeout(timer);
          resolve(r);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      try {
        this._write(side, { type: 'control_request', request_id: id, request });
      } catch (error) {
        side.control.delete(id);
        clearTimeout(timer);
        reject(error as Error);
      }
    });
  }

  private async _read(side: Side): Promise<void> {
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for await (const chunk of side.proc.stdout) {
        buffer += decoder.decode(chunk, { stream: true });
        for (let n = buffer.indexOf('\n'); n >= 0; n = buffer.indexOf('\n')) {
          const line = buffer.slice(0, n);
          buffer = buffer.slice(n + 1);
          if (!line.trim()) continue;
          let frame: Record<string, unknown>;
          try {
            frame = JSON.parse(line);
          } catch {
            continue;
          }
          this._frame(side, frame);
        }
      }
    } catch {
      /* the exit handler settles what is left */
    }
  }

  private _byToolUse(side: Side, id: unknown): Member | undefined {
    if (typeof id !== 'string') return undefined;
    for (const m of side.members.values()) if (m.toolUseId === id) return m;
    return undefined;
  }

  private _frame(side: Side, frame: Record<string, unknown>): void {
    const type = frame.type;
    if (typeof frame.session_id === 'string') side.sessionId ??= frame.session_id;
    if (type === 'control_response') {
      const response = frame.response as Record<string, unknown> | undefined;
      const id = response?.request_id as string | undefined;
      const pending = id ? side.control.get(id) : undefined;
      if (!pending) return;
      side.control.delete(id!);
      if (response?.subtype === 'error')
        pending.reject(Error(String(response.error ?? 'control error')));
      else pending.resolve((response?.response as Record<string, unknown>) ?? {});
      return;
    }
    if (type === 'control_request') {
      const request = frame.request as Record<string, unknown> | undefined;
      const requestId = frame.request_id as string;
      if (request?.subtype === 'hook_callback' && request.callback_id === 'members') {
        this._answerHook(side, requestId, request.input as Record<string, unknown> | undefined);
        return;
      }
      // No other request is ours to grant.
      this._write(side, {
        type: 'control_response',
        response: {
          subtype: 'error',
          request_id: requestId,
          error: 'not supported by a decision host',
        },
      });
      return;
    }
    if (type === 'rate_limit_event') {
      const snapshot = claudeRateLimitSnapshot(frame.rate_limit_info);
      if (snapshot) {
        this._limits = mergeLimits(this._limits, snapshot);
        this._emit({ type: 'limits', limits: this._limits });
      }
      return;
    }
    if (type === 'system' && frame.subtype === 'task_started') {
      const member = this._byToolUse(side, frame.tool_use_id);
      if (!member) return;
      member.taskId = frame.task_id as string;
      // The hook decides what a subagent receives; anything else is a violation.
      if (frame.prompt !== member.request.input)
        member.violation = 'member input was not the composed input';
      return;
    }
    if (type === 'assistant' && frame.parent_tool_use_id) {
      const member = this._byToolUse(side, frame.parent_tool_use_id);
      if (!member) return;
      const message = frame.message as Record<string, unknown> | undefined;
      for (const block of (message?.content as Array<Record<string, unknown>>) ?? []) {
        if (block.type === 'text' && typeof block.text === 'string') member.texts.push(block.text);
        if (block.type === 'tool_use') member.violation = 'tool activity';
      }
      if (typeof message?.model === 'string') member.model = message.model;
      const usage = message?.usage as Record<string, number> | undefined;
      if (usage) {
        member.tokens.input += usage.input_tokens ?? 0;
        member.tokens.output += usage.output_tokens ?? 0;
        member.tokens.cacheRead += usage.cache_read_input_tokens ?? 0;
        member.tokens.cacheWrite += usage.cache_creation_input_tokens ?? 0;
      }
      return;
    }
    if (type === 'system' && frame.subtype === 'task_notification') {
      const member = this._byToolUse(side, frame.tool_use_id);
      if (member) this._settle(side, member, String(frame.status ?? 'unknown'));
      return;
    }
    if (type === 'result') side.onResult?.();
  }

  private _answerHook(
    side: Side,
    requestId: string,
    input: Record<string, unknown> | undefined,
  ): void {
    const toolInput = (input?.tool_input ?? {}) as Record<string, unknown>;
    const member = side.members.get(String(toolInput.description ?? ''));
    const usable =
      member &&
      !member.settled &&
      !member.toolUseId &&
      member.name === toolInput.subagent_type &&
      Date.now() < member.deadline;
    const output = usable
      ? {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
          updatedInput: {
            subagent_type: member.name,
            description: member.token,
            prompt: member.request.input,
            run_in_background: false,
          },
        }
      : {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: 'not a member of this fan-out',
        };
    if (usable) {
      member.toolUseId = input?.tool_use_id as string;
      member.dispatchedAt = Date.now();
    }
    this._write(side, {
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: requestId,
        response: { hookSpecificOutput: output },
      },
    });
  }

  private _settle(side: Side, member: Member, status: string): void {
    if (member.settled) return;
    if (member.violation) {
      this._emit({ type: 'violation', key: member.spec.key, detail: member.violation });
      member.reject(
        new DecisionError(
          `Decision violated the decision policy (${member.violation})`,
          'violation',
          'attempted',
          true,
          member.admissionId,
        ),
      );
      return;
    }
    if (status !== 'completed') {
      member.reject(
        new DecisionError(
          `Claude subagent ${status}`,
          'native-failed',
          'attempted',
          true,
          member.admissionId,
        ),
      );
      return;
    }
    const ms = Date.now() - member.started;
    this._emit({
      type: 'decision',
      key: member.spec.key,
      prime: 'warm',
      ms,
      cacheRead: member.tokens.cacheRead,
    });
    member.resolve({
      key: member.spec.key,
      admissionId: member.admissionId!,
      content: member.texts.join(''),
      tokens: {
        input: member.tokens.input,
        output: member.tokens.output,
        cacheRead: member.tokens.cacheRead,
        cacheWrite: member.tokens.cacheWrite,
      },
      ...(member.model ? { model: member.model } : {}),
      ...(side.sessionId ? { threadId: side.sessionId } : {}),
      ...(member.toolUseId ? { turnId: member.toolUseId } : {}),
      prime: 'warm',
      timing: {
        waitMs: (member.dispatchedAt ?? Date.now()) - member.started,
        primeMs: 0,
        branchMs: 0,
        turnMs: Date.now() - (member.dispatchedAt ?? member.started),
      },
    });
  }

  /** A member past its deadline or aborted: refused unsent, or its running subagent stopped. */
  private async _withdraw(member: Member, reason: 'timeout' | 'aborted'): Promise<void> {
    if (member.settled) return;
    const message = reason === 'timeout' ? 'Decision deadline passed' : 'Decision aborted';
    if (!member.toolUseId) {
      member.reject(
        new DecisionError(
          `${message} before dispatch`,
          reason,
          'not-dispatched',
          true,
          member.admissionId,
        ),
      );
      return;
    }
    const side = [...this._groups.values()]
      .flatMap((g) => g.sides)
      .find((s) => [...s.members.values()].includes(member));
    let settled = false;
    if (side?.alive && member.taskId)
      settled = await this._control(
        side,
        { subtype: 'stop_task', task_id: member.taskId },
        2_000,
      ).then(
        () => true,
        () => false,
      );
    member.reject(
      new DecisionError(
        `${message}; subagent stopped`,
        reason,
        'attempted',
        settled,
        member.admissionId,
      ),
    );
  }

  private async _fanOut(side: Side, chunk: Member[], retry = false): Promise<void> {
    try {
      await side.ready;
    } catch (error) {
      for (const m of chunk)
        m.reject(
          new DecisionError(
            `Side session start failed: ${(error as Error).message}`,
            'transport',
            'not-dispatched',
            true,
          ),
        );
      return;
    }
    // Registration precedes the native write, so a refused admission never reaches the runtime.
    const admitted: Member[] = [];
    for (const m of chunk) {
      if (m.settled) continue;
      m.admissionId ??= crypto.randomUUID();
      try {
        if (!retry)
          await m.request.onAdmission?.({
            admissionId: m.admissionId,
            key: m.spec.key,
            runtime: 'claude',
          });
        if (m.settled) continue;
        admitted.push(m);
      } catch {
        m.reject(
          new DecisionError(
            'Decision admission refused before dispatch',
            'admission',
            'not-dispatched',
            true,
            m.admissionId,
          ),
        );
      }
    }
    if (!admitted.length || !side.alive) {
      for (const m of admitted)
        m.reject(
          new DecisionError(
            'Side session lost before dispatch',
            'transport',
            'not-dispatched',
            true,
            m.admissionId,
          ),
        );
      return;
    }
    side.members = new Map(admitted.map((m) => [m.token, m]));
    const uuid = crypto.randomUUID();
    const turnEnded = new Promise<void>((resolve) => {
      side.onResult = resolve;
    });
    const deadline = Math.max(...admitted.map((m) => m.deadline)) + 5_000;
    let interrupted = false;
    // Every member answered: the dispatcher's own wrap-up is not waited for.
    const allSettled = setInterval(() => {
      if (!interrupted && admitted.every((m) => m.settled)) {
        interrupted = true;
        void this._control(side, { subtype: 'interrupt' }, 5_000).catch(() => undefined);
      }
    }, 20);
    try {
      this._write(side, {
        type: 'user',
        uuid,
        message: {
          role: 'user',
          content: admitted.map((m) => `${m.name} ${m.token}`).join('\n'),
        },
        parent_tool_use_id: null,
      });
      const ended = await Promise.race([
        turnEnded.then(() => true),
        Bun.sleep(Math.max(0, deadline - Date.now())).then(() => false),
      ]);
      if (!ended) {
        await this._kill(side, 'fan-out turn did not end');
        return;
      }
      // Any member still unsettled ended with the turn; skipped members are sent once more.
      const skipped = admitted.filter((m) => !m.settled && !m.toolUseId);
      for (const m of admitted.filter((m) => !m.settled && m.toolUseId))
        m.reject(
          new DecisionError(
            'Subagent ended without an answer',
            'transport',
            'attempted',
            true,
            m.admissionId,
          ),
        );
      const rewound = await this._control(side, {
        subtype: 'rewind_conversation',
        target_message_uuid: uuid,
      })
        .then((r) => r.rewound === true)
        .catch(() => false);
      if (!rewound) await this._kill(side, 'rewind refused');
      if (skipped.length) {
        if (!retry && side.alive) {
          await this._fanOut(side, skipped, true);
        } else
          for (const m of skipped)
            m.reject(
              new DecisionError(
                'The dispatcher did not call this member',
                'transport',
                'not-dispatched',
                true,
                m.admissionId,
              ),
            );
      }
    } catch (error) {
      for (const m of admitted)
        m.reject(
          new DecisionError(
            `Fan-out failed: ${(error as Error).message}`,
            'transport',
            'not-dispatched',
            true,
            m.admissionId,
          ),
        );
    } finally {
      clearInterval(allSettled);
      side.onResult = undefined;
      side.members = new Map();
    }
  }

  private _lost(side: Side): void {
    if (!side.alive) return;
    side.alive = false;
    try {
      rmSync(side.dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
    for (const pending of side.control.values()) pending.reject(Error('side session exited'));
    side.control.clear();
    for (const m of side.members.values())
      m.reject(
        new DecisionError(
          'Side session exited',
          'transport',
          m.toolUseId ? 'attempted' : 'not-dispatched',
          true,
          m.admissionId,
        ),
      );
    side.onResult?.();
    const group = this._groups.get(side.group);
    if (group) {
      const i = group.sides.indexOf(side);
      if (i >= 0) group.sides.splice(i, 1);
      this._drain(group);
    }
  }

  private async _kill(side: Side, reason: string): Promise<void> {
    if (side.alive && reason !== 'close')
      this._emit({ type: 'process-recycled', generation: side.generation, reason });
    try {
      side.proc.kill();
    } catch {
      /* exited */
    }
    await Promise.race([side.proc.exited.catch(() => 0), Bun.sleep(2_000)]);
    this._lost(side);
  }

  private _closeIdle(): void {
    const cutoff = Date.now() - this._config.idleMs;
    for (const group of this._groups.values()) {
      for (const side of [...group.sides])
        if (!side.busy && side.lastUsed < cutoff) void this._kill(side, 'idle');
      for (const [name, def] of group.defs) if (def.lastUsed < cutoff) group.defs.delete(name);
      if (!group.sides.length && !group.defs.size && !group.batch.length)
        this._groups.delete(group.id);
    }
  }
}
