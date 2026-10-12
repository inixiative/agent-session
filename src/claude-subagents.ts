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
//   standby   pre-started members (`prestart`): each role is dispatched ahead
//             of its trigger as a subagent holding its stable context and the
//             thread's current standby context, and calls the host's
//             `moment` tool (an SDK MCP server over the control channel),
//             which the host holds open. A decision whose standby context
//             matches answers that call with its input, so every pre-started
//             member starts at once, with no dispatch on the decision's path.
//             Each spare serves one decision; `prestart` with new standby
//             context replaces the spares (a turn landed), and a consumed one
//             is pre-started again.
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

/** How long a decision reserved on a spare still starting waits for it before fanning out. */
const RESERVE_START_MS = 2_000;

/** The tool a pre-started member calls; its result is the decision input. */
const MOMENT_TOOL = 'mcp__foundry__moment';
const standbyPrompt = (standby: string, token: string) =>
  `${standby}\n\nThe moment to assess has not arrived yet. Call the ${MOMENT_TOOL} tool now with token "${token}" and do nothing else first. Its result is the moment; then answer it exactly as your instructions and its response protocol say.`;

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
  /** Side sessions per group (pre-started spares hold some). Default 6. */
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
  /** Replaced (standby context in front of input) when a reserved spare cannot serve it. */
  request: DecisionRequest;
  /** Its admission was registered: never registered again, and only then is it sent. */
  admitted?: boolean;
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
  /** Served by a pre-started spare instead of a fan-out. */
  spare?: Spare;
  deliveredAt?: number;
  settled: boolean;
  /** Resolves when the member settles either way. */
  done: Promise<void>;
  resolve(result: DecisionResult): void;
  reject(error: DecisionError): void;
}

interface Spare {
  /** The role's definition name (`d-…`); the standby variant is `w-…`. */
  readonly name: string;
  readonly standbyHash: string;
  readonly prompt: string;
  readonly token: string;
  readonly side: Side;
  toolUseId?: string;
  taskId?: string;
  /** The held `moment` call. */
  pending?: { requestId: string; rpcId: unknown };
  /** The decision it serves, once reserved. */
  member?: Member;
  violation?: string;
  done: boolean;
}

interface Side {
  readonly group: string;
  readonly names: ReadonlySet<string>;
  readonly proc: PipedSubprocess;
  readonly dir: string;
  readonly generation: number;
  /** Eligible for new fan-outs; false from the moment it is being killed. */
  alive: boolean;
  /** Its exit has been handled. */
  gone: boolean;
  ready: Promise<void>;
  busy: boolean;
  lastUsed: number;
  sessionId?: string;
  /** Members of the fan-out in flight, by token. */
  members: Map<string, Member>;
  /** Pre-started members this side session's standby turn holds, by token. */
  spares: Map<string, Spare>;
  /** Its standby context was replaced: end its standby turn once no decision uses it. */
  retire?: boolean;
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
  /** Roles to keep pre-started, with the standby context to hold. */
  desired: Map<string, { standby: string; standbyHash: string }>;
  /** Last decision or pre-start: a group idle longer than `idleMs` lets its spares go. */
  lastActive: number;
  /** Standby side sessions that failed to start; pre-starting backs off while it grows. */
  startFailures: number;
  retryAt: number;
}

/** Role definitions a group's side sessions launch with; the least recently used beyond it drop. */
const MAX_DEFINITIONS = 64;

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const standbyName = (name: string) => `w-${name.slice(2)}`;

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
      maxSessionsPerGroup: config.maxSessionsPerGroup ?? 6,
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
    const group = this._group(request.group ?? 'default');
    group.lastActive = Date.now();
    const name = this._define(group, spec);
    // A pre-started member holding this standby context serves the decision; otherwise it fans out
    // with the standby context in front of its input.
    const spare =
      request.standby === undefined ? undefined : this._spareFor(group, name, request.standby);
    if (request.standby !== undefined && !spare)
      request = { ...request, input: `${request.standby}${request.input}` };
    const started = Date.now();
    let settle!: () => void;
    const done = new Promise<void>((r) => {
      settle = r;
    });
    return new Promise<DecisionResult>((resolve, reject) => {
      const member: Member = {
        done,
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
          settle();
          resolve(result);
        },
        reject: (error) => {
          if (member.settled) return;
          member.settled = true;
          clearTimeout(timer);
          settle();
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
      if (spare) {
        member.spare = spare;
        spare.member = member;
        void this._reserve(spare, member);
        return;
      }
      this._replenish(group);
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

  /**
   * Keep these roles pre-started with this standby context (the thread's current context, which
   * precedes each decision's input). Replaces the group's spares; spares holding other context are
   * ended once no decision uses them.
   */
  prestart(group: string, entries: ReadonlyArray<{ spec: PrimeSpec; standby: string }>): void {
    if (this._closed) return;
    const g = this._group(group);
    g.lastActive = Date.now();
    g.desired = new Map(
      entries.map((e) => [
        this._define(g, e.spec),
        { standby: e.standby, standbyHash: hash(e.standby) },
      ]),
    );
    for (const side of g.sides)
      if (side.spares.size) {
        const stale = [...side.spares.values()].some(
          (sp) => g.desired.get(sp.name)?.standbyHash !== sp.standbyHash,
        );
        if (stale) {
          side.retire = true;
          this._endStandby(side);
        }
      }
    this._replenish(g);
  }

  /** A group is done (its thread closed): its spares and side sessions stop. */
  async releaseGroup(group: string): Promise<void> {
    const g = this._groups.get(group);
    if (!g) return;
    g.desired = new Map();
    clearTimeout(g.timer);
    const closed = () =>
      new DecisionError('Decision group released', 'closed', 'not-dispatched', true);
    for (const m of g.batch.splice(0)) m.reject(closed());
    for (const m of g.waiting.splice(0).flat()) m.reject(closed());
    for (const side of g.sides) side.retire = true;
    await Promise.all([...g.sides].map((side) => this._kill(side, 'group released')));
    this._groups.delete(group);
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
      [...this._groups.values()].flatMap((g) => [...g.sides]).map((s) => this._kill(s, 'close')),
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

  /** Register a role's definition with its group; its name is the hash of its system prompt. */
  private _define(group: Group, spec: PrimeSpec): string {
    const prompt = [this._config.baseInstructions, spec.instructions, spec.context]
      .filter(Boolean)
      .join('\n\n');
    const name = `d-${hash(prompt).slice(0, 16)}`;
    group.defs.delete(name);
    group.defs.set(name, { prompt, lastUsed: Date.now() });
    // The least recently used definitions beyond the cap leave the next side session's agent file.
    for (const old of group.defs.keys()) {
      if (group.defs.size <= MAX_DEFINITIONS) break;
      group.defs.delete(old);
    }
    return name;
  }

  private _spareFor(group: Group, name: string, standby: string): Spare | undefined {
    const standbyHash = hash(standby);
    for (const side of group.sides)
      if (side.alive && !side.retire)
        for (const spare of side.spares.values())
          if (
            spare.name === name &&
            spare.standbyHash === standbyHash &&
            !spare.member &&
            !spare.done &&
            !spare.violation
          )
            return spare;
    return undefined;
  }

  /** Admit a decision onto its spare; the input goes out when the spare's moment call is held. */
  private async _reserve(spare: Spare, member: Member): Promise<void> {
    member.admissionId = crypto.randomUUID();
    const ours = () => spare.member === member && member.spare === spare;
    try {
      await Promise.race([
        Promise.resolve(
          member.request.onAdmission?.({
            admissionId: member.admissionId,
            key: member.spec.key,
            runtime: 'claude',
          }),
        ),
        member.done,
      ]);
    } catch {
      if (spare.member === member) spare.member = undefined;
      member.reject(
        new DecisionError(
          'Decision admission refused before dispatch',
          'admission',
          'not-dispatched',
          true,
          member.admissionId,
        ),
      );
      return;
    }
    if (member.settled) {
      if (spare.member === member && !member.deliveredAt) spare.member = undefined;
      return;
    }
    member.admitted = true;
    if (!ours()) return; // moved to a fan-out while it was being admitted
    if (!this._serviceable(spare)) {
      this._fallback(member);
      return;
    }
    spare.side.members.set(member.token, member);
    if (spare.pending) this._deliver(spare);
    // A spare still starting gets a moment to call in; otherwise the decision goes by fan-out.
    else
      setTimeout(() => {
        if (ours() && !member.deliveredAt && !member.settled) this._fallback(member);
      }, RESERVE_START_MS);
  }

  /** The spare is still held by a live standby turn and can take a decision. */
  private _serviceable(spare: Spare): boolean {
    return (
      spare.side.alive &&
      spare.side.spares.get(spare.token) === spare &&
      !spare.done &&
      !spare.violation
    );
  }

  /** A reserved decision its spare cannot serve: it fans out, its standby context in front of its input. */
  private _fallback(member: Member): void {
    const spare = member.spare;
    if (!spare || member.settled || member.deliveredAt) return;
    if (spare.member === member) spare.member = undefined;
    spare.side.members.delete(member.token);
    member.spare = undefined;
    const { standby, ...rest } = member.request;
    member.request = { ...rest, input: `${standby ?? ''}${member.request.input}` };
    const group = this._groups.get(spare.side.group);
    if (!group) return;
    group.batch.push(member);
    clearTimeout(group.timer);
    group.timer = setTimeout(() => this._flush(group), 0);
  }

  private _deliver(spare: Spare): void {
    const member = spare.member;
    if (!member || member.settled || !spare.pending || member.deliveredAt || !member.admitted)
      return;
    if (spare.violation) {
      this._fallback(member);
      return;
    }
    member.deliveredAt = member.dispatchedAt = Date.now();
    member.toolUseId = spare.toolUseId;
    member.taskId = spare.taskId;
    this._mcpReply(spare.side, spare.pending.requestId, {
      jsonrpc: '2.0',
      id: spare.pending.rpcId,
      result: { content: [{ type: 'text', text: member.request.input }] },
    });
  }

  /** Answer an MCP request from the runtime; true once written. */
  private _mcpReply(side: Side, requestId: string, message: unknown): boolean {
    this._write(side, {
      type: 'control_response',
      response: { subtype: 'success', request_id: requestId, response: { mcp_response: message } },
    });
    return true;
  }

  /** The host's MCP server: one tool, `moment`, whose call a pre-started member holds open. */
  private _answerMcp(side: Side, requestId: string, message: Record<string, unknown>): boolean {
    const id = message.id;
    if (message.method === 'initialize')
      return this._mcpReply(side, requestId, {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: (message.params as Record<string, unknown> | undefined)?.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: 'foundry', version: '1' },
        },
      });
    if (message.method === 'tools/list')
      return this._mcpReply(side, requestId, {
        jsonrpc: '2.0',
        id,
        result: {
          tools: [
            {
              name: 'moment',
              description: 'Wait for the moment to assess. Its result is your input.',
              inputSchema: {
                type: 'object',
                properties: { token: { type: 'string' } },
                required: ['token'],
              },
            },
          ],
        },
      });
    if (message.method === 'tools/call') {
      const params = (message.params ?? {}) as Record<string, unknown>;
      const token = String(((params.arguments ?? {}) as Record<string, unknown>).token ?? '');
      const spare = params.name === 'moment' ? side.spares.get(token) : undefined;
      if (!spare || spare.pending || spare.done)
        return this._mcpReply(side, requestId, {
          jsonrpc: '2.0',
          id,
          result: { isError: true, content: [{ type: 'text', text: 'No moment for this token.' }] },
        });
      spare.pending = { requestId, rpcId: id };
      this._deliver(spare);
      return true;
    }
    if (id === undefined) return this._mcpReply(side, requestId, null);
    return this._mcpReply(side, requestId, {
      jsonrpc: '2.0',
      id,
      error: { code: -32601, message: 'method not found' },
    });
  }

  /** Pre-start every desired role that has no spare holding its current standby context. */
  private _replenish(group: Group): void {
    if (this._closed || !group.desired.size || Date.now() < group.retryAt) return;
    // Spares are created when their standby turn is assigned, so one still starting counts as held.
    const held = new Set<string>();
    for (const side of group.sides)
      if (side.alive && !side.retire)
        for (const spare of side.spares.values())
          if (!spare.done && !spare.member && !spare.violation)
            if (group.desired.get(spare.name)?.standbyHash === spare.standbyHash)
              held.add(spare.name);
    const missing = [...group.desired.keys()].filter((name) => !held.has(name));
    if (!missing.length) return;
    const chunks = Math.ceil(missing.length / this._config.maxMembers);
    const size = Math.ceil(missing.length / chunks);
    for (let i = 0; i < missing.length; i += size) {
      const chunk = missing.slice(i, i + size);
      const needs = chunk.map(standbyName);
      let side = group.sides.find((s) => s.alive && !s.busy && needs.every((n) => s.names.has(n)));
      if (!side) {
        if (group.sides.length >= this._config.maxSessionsPerGroup) return; // retried when one frees
        try {
          side = this._spawn(group);
        } catch {
          this._startFailed(group);
          return;
        }
      }
      const owner = side;
      owner.busy = true;
      owner.spares = new Map(
        chunk.map((name) => {
          const desired = group.desired.get(name)!;
          const token = `s${crypto.randomUUID().slice(0, 8)}`;
          const spare: Spare = {
            name,
            standbyHash: desired.standbyHash,
            prompt: standbyPrompt(desired.standby, token),
            token,
            side: owner,
            done: false,
          };
          return [token, spare] as const;
        }),
      );
      void this._standbyFanOut(owner, group)
        .catch(() => undefined)
        .finally(() => {
          owner.busy = false;
          owner.retire = false;
          owner.lastUsed = Date.now();
          this._drain(group);
          this._replenish(group);
        });
    }
  }

  /** A standby side session that failed to start: pre-starting backs off (5 s, doubling to 5 min). */
  private _startFailed(group: Group): void {
    group.startFailures++;
    group.retryAt = Date.now() + Math.min(5 * 60_000, 5_000 * 2 ** (group.startFailures - 1));
  }

  /** End a side session's standby turn once no decision is using its spares. */
  private _endStandby(side: Side): void {
    const inUse = [...side.spares.values()].some((sp) => sp.member && !sp.member.settled);
    if (inUse || !side.spares.size) return;
    void this._control(side, { subtype: 'interrupt' }, 5_000).catch(
      () => void this._kill(side, 'standby interrupt unanswered'),
    );
  }

  private _endStandbyNow(side: Side): void {
    void this._control(side, { subtype: 'interrupt' }, 5_000).catch(
      () => void this._kill(side, 'standby interrupt unanswered'),
    );
  }

  /** One dispatcher turn holding pre-started members until each is used or the turn is ended. */
  private async _standbyFanOut(side: Side, group: Group): Promise<void> {
    try {
      await side.ready;
    } catch {
      this._startFailed(group);
      this._releaseSpares(side);
      return;
    }
    group.startFailures = 0;
    if (!side.alive) {
      this._releaseSpares(side);
      return;
    }
    const spares = [...side.spares.values()];
    const uuid = crypto.randomUUID();
    const turnEnded = new Promise<void>((resolve) => {
      side.onResult = resolve;
    });
    try {
      this._write(side, {
        type: 'user',
        uuid,
        message: {
          role: 'user',
          content: spares.map((sp) => `${standbyName(sp.name)} ${sp.token}`).join('\n'),
        },
        parent_tool_use_id: null,
      });
      await turnEnded;
    } finally {
      side.onResult = undefined;
      this._releaseSpares(side);
    }
    const rewound = side.alive
      ? await this._control(side, { subtype: 'rewind_conversation', target_message_uuid: uuid })
          .then((r) => r.rewound === true)
          .catch(() => false)
      : false;
    if (!rewound) await this._kill(side, 'rewind refused');
  }

  /**
   * The standby turn is over: a decision reserved on a spare that never ran fans out instead, and
   * one that ran but did not answer fails.
   */
  private _releaseSpares(side: Side): void {
    for (const sp of side.spares.values()) {
      sp.done = true;
      const member = sp.member;
      if (!member || member.settled) continue;
      if (!member.deliveredAt) this._fallback(member);
      else
        member.reject(
          new DecisionError(
            'Subagent ended without an answer',
            'transport',
            'attempted',
            true,
            member.admissionId,
          ),
        );
    }
    side.spares = new Map();
    side.members = new Map();
  }

  private _spareByToolUse(side: Side, id: unknown): Spare | undefined {
    if (typeof id !== 'string') return undefined;
    for (const sp of side.spares.values()) if (sp.toolUseId === id) return sp;
    return undefined;
  }

  private _group(id: string): Group {
    let group = this._groups.get(id);
    if (!group) {
      group = {
        id,
        defs: new Map(),
        sides: [],
        batch: [],
        waiting: [],
        desired: new Map(),
        lastActive: Date.now(),
        startFailures: 0,
        retryAt: 0,
      };
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
        try {
          side = this._spawn(group);
        } catch (error) {
          group.waiting.shift();
          for (const m of chunk)
            m.reject(
              new DecisionError(
                `Side session start failed: ${(error as Error).message}`,
                'transport',
                'not-dispatched',
                true,
              ),
            );
          continue;
        }
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
    try {
      return this._launch(group, generation, dir);
    } catch (error) {
      rmSync(dir, { recursive: true, force: true });
      throw error;
    }
  }

  private _launch(group: Group, generation: number, dir: string): Side {
    chmodSync(dir, 0o700);
    const agents: Record<string, unknown> = {};
    for (const [name, def] of group.defs) {
      agents[name] = {
        description: 'decision role',
        prompt: def.prompt,
        model: this._config.model,
        tools: [],
      };
      agents[standbyName(name)] = {
        description: 'decision role, pre-started',
        prompt: def.prompt,
        model: this._config.model,
        tools: [MOMENT_TOOL],
      };
    }
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
      JSON.stringify({ mcpServers: { foundry: { type: 'sdk', name: 'foundry' } } }),
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
      // A pre-started member holds its moment call until the thread's next trigger.
      MCP_TOOL_TIMEOUT: String(24 * 60 * 60_000),
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
      gone: false,
      ready: Promise.resolve(),
      busy: false,
      lastUsed: Date.now(),
      members: new Map(),
      spares: new Map(),
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
      sdkMcpServers: ['foundry'],
      hooks: { PreToolUse: [{ matcher: 'Agent', hookCallbackIds: ['members'] }] },
    }).then(() => {
      this._emit({ type: 'process-started', generation, ms: Math.round(performance.now() - t0) });
    });
    // A side session that never initialized serves nothing: it is stopped, not left to fail every fan-out.
    side.ready.catch(() => void this._kill(side, 'start failed'));
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
      if (request?.subtype === 'mcp_message' && request.server_name === 'foundry') {
        this._answerMcp(side, requestId, (request.message ?? {}) as Record<string, unknown>);
        return;
      }
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
      const spare = this._spareByToolUse(side, frame.tool_use_id);
      if (spare) {
        spare.taskId = frame.task_id as string;
        if (frame.prompt !== spare.prompt)
          spare.violation = 'standby input was not the composed input';
        return;
      }
      const member = this._byToolUse(side, frame.tool_use_id);
      if (!member) return;
      member.taskId = frame.task_id as string;
      // The hook decides what a subagent receives; anything else is a violation.
      if (frame.prompt !== member.request.input)
        member.violation = 'member input was not the composed input';
      return;
    }
    if (type === 'assistant' && frame.parent_tool_use_id) {
      const spare = this._spareByToolUse(side, frame.parent_tool_use_id);
      if (spare && !spare.member?.deliveredAt) {
        // Before its moment a pre-started member may only call the moment tool.
        const message = frame.message as Record<string, unknown> | undefined;
        for (const block of (message?.content as Array<Record<string, unknown>>) ?? [])
          if (block.type === 'tool_use' && block.name !== MOMENT_TOOL)
            spare.violation = 'tool activity before its moment';
        return;
      }
      const member = spare?.member ?? this._byToolUse(side, frame.parent_tool_use_id);
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
      const spare = this._spareByToolUse(side, frame.tool_use_id);
      if (spare) {
        spare.done = true;
        const member = spare.member;
        if (member?.deliveredAt) this._settle(side, member, String(frame.status ?? 'unknown'));
        else if (member) this._fallback(member);
        // Every spare used or ended: the standby turn ends too.
        if ([...side.spares.values()].every((sp) => sp.done)) this._endStandbyNow(side);
        else if (side.retire) this._endStandby(side);
        const group = this._groups.get(side.group);
        if (group) this._replenish(group);
        return;
      }
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
    const spare = side.spares.get(String(toolInput.description ?? ''));
    if (spare) {
      const usable = !spare.toolUseId && standbyName(spare.name) === toolInput.subagent_type;
      if (usable) spare.toolUseId = input?.tool_use_id as string;
      this._write(side, {
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: requestId,
          response: {
            hookSpecificOutput: usable
              ? {
                  hookEventName: 'PreToolUse',
                  permissionDecision: 'allow',
                  updatedInput: {
                    subagent_type: toolInput.subagent_type,
                    description: spare.token,
                    prompt: spare.prompt,
                    run_in_background: false,
                  },
                }
              : {
                  hookEventName: 'PreToolUse',
                  permissionDecision: 'deny',
                  permissionDecisionReason: 'not a member of this fan-out',
                },
          },
        },
      });
      return;
    }
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

  /** A member past its deadline or aborted: refused unsent, or rejected and its running subagent stopped. */
  private async _withdraw(member: Member, reason: 'timeout' | 'aborted'): Promise<void> {
    if (member.settled) return;
    const message = reason === 'timeout' ? 'Decision deadline passed' : 'Decision aborted';
    if (member.spare && !member.deliveredAt) {
      // Never sent: the spare stays pre-started for the next decision.
      member.spare.member = undefined;
      member.spare.side.members.delete(member.token);
    }
    if (!member.deliveredAt && (member.spare || !member.toolUseId)) {
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
    // Rejected at once, so the deadline is never extended by the stop. A stop that cannot be
    // confirmed recycles the side session.
    member.reject(
      new DecisionError(
        `${message}; subagent being stopped`,
        reason,
        'attempted',
        false,
        member.admissionId,
      ),
    );
    const side =
      member.spare?.side ??
      [...this._groups.values()]
        .flatMap((g) => g.sides)
        .find((s) => [...s.members.values()].includes(member));
    if (!side) return;
    const stopped =
      side.alive && member.taskId
        ? await this._control(side, { subtype: 'stop_task', task_id: member.taskId }, 2_000).then(
            () => true,
            () => false,
          )
        : false;
    if (!stopped) await this._kill(side, `${reason}: subagent stop unconfirmed`);
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
    // Admissions run together, and a member that settles meanwhile (its deadline) is not waited for.
    const admitted: Member[] = [];
    await Promise.all(
      chunk.map(async (m) => {
        if (m.settled) return;
        m.admissionId ??= crypto.randomUUID();
        try {
          if (!retry && !m.admitted)
            await Promise.race([
              Promise.resolve(
                m.request.onAdmission?.({
                  admissionId: m.admissionId,
                  key: m.spec.key,
                  runtime: 'claude',
                }),
              ),
              m.done,
            ]);
          m.admitted = true;
          if (!m.settled) admitted.push(m);
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
      }),
    );
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
    let interrupted = false,
      ended = false,
      overdue: ReturnType<typeof setTimeout> | undefined;
    // Every member answered: the dispatcher's own wrap-up is not waited for.
    const allSettled = setInterval(() => {
      if (!interrupted && !ended && admitted.every((m) => m.settled)) {
        interrupted = true;
        void this._control(side, { subtype: 'interrupt' }, 5_000).catch(() => undefined);
      }
    }, 20);
    try {
      this._write(side, {
        type: 'user',
        uuid,
        message: { role: 'user', content: admitted.map((m) => `${m.name} ${m.token}`).join('\n') },
        parent_tool_use_id: null,
      });
      ended = await Promise.race([
        turnEnded.then(() => true),
        new Promise<false>((resolve) => {
          overdue = setTimeout(() => resolve(false), Math.max(0, deadline - Date.now()));
        }),
      ]);
      clearTimeout(overdue);
      clearInterval(allSettled);
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
      side.members = new Map();
      const rewound = side.alive
        ? await this._control(side, { subtype: 'rewind_conversation', target_message_uuid: uuid })
            .then((r) => r.rewound === true)
            .catch(() => false)
        : false;
      if (!rewound) await this._kill(side, 'rewind refused');
      if (skipped.length) {
        if (!retry && side.alive) await this._fanOut(side, skipped, true);
        else
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
            m.toolUseId ? 'attempted' : 'not-dispatched',
            !m.toolUseId,
            m.admissionId,
          ),
        );
      await this._kill(side, 'fan-out failed');
    } finally {
      clearTimeout(overdue);
      clearInterval(allSettled);
      side.onResult = undefined;
      side.members = new Map();
    }
  }

  /** The side session's exit: everything it held settles, and its group's waiting work moves on. */
  private _lost(side: Side): void {
    if (side.gone) return;
    side.gone = true;
    side.alive = false;
    try {
      rmSync(side.dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
    for (const pending of side.control.values()) pending.reject(Error('side session exited'));
    side.control.clear();
    for (const sp of side.spares.values())
      if (sp.member && !sp.member.deliveredAt) this._fallback(sp.member);
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

  /** Stop a side session; from the first moment it takes no new fan-out. */
  private async _kill(side: Side, reason: string): Promise<void> {
    if (side.gone) return;
    if (side.alive && reason !== 'close')
      this._emit({ type: 'process-recycled', generation: side.generation, reason });
    side.alive = false;
    const group = this._groups.get(side.group);
    const i = group ? group.sides.indexOf(side) : -1;
    if (group && i >= 0) group.sides.splice(i, 1);
    try {
      side.proc.kill();
    } catch {
      /* exited */
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      side.proc.exited.catch(() => 0),
      new Promise((resolve) => {
        timer = setTimeout(resolve, 2_000);
      }),
    ]);
    clearTimeout(timer);
    this._lost(side);
  }

  private _closeIdle(): void {
    const cutoff = Date.now() - this._config.idleMs;
    for (const group of this._groups.values()) {
      // A thread with no decision for a while lets its spares go; they are pre-started again on demand.
      if (group.lastActive < cutoff && group.desired.size) {
        group.desired = new Map();
        for (const side of group.sides)
          if (side.spares.size) {
            side.retire = true;
            this._endStandby(side);
          }
      }
      for (const side of [...group.sides])
        if (!side.busy && side.lastUsed < cutoff) void this._kill(side, 'idle');
      for (const [name, def] of group.defs) if (def.lastUsed < cutoff) group.defs.delete(name);
      if (!group.sides.length && !group.defs.size && !group.batch.length)
        this._groups.delete(group.id);
    }
  }
}
