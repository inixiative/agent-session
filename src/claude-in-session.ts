// ---------------------------------------------------------------------------
// ClaudeInSessionDecisions — decision roles as subagents inside a main session's own process
// ---------------------------------------------------------------------------
//
// The whole tree (the main thread, its subagents, every decision role) is one Claude CLI process.
// The extension attaches to the main session (`ClaudeCodeSession.extend`) before it starts:
//
//   setup      one internal turn asks the main model to start `foundry-root` in the background.
//              The root never ends: it calls the host's `next` tool, which the host holds open,
//              and starts what `next` returns. That is a generation: `foundry-dispatch`, which
//              starts members (`foundry-warden`) the same way. After the setup turn no member
//              activity ever needs a main-model turn: a nested background task ends into its
//              parent, never the main thread (verified live on Claude Code 2.1.300).
//   pinning    every spawn goes through the session's PreToolUse callback, which replaces its
//              prompt with the exact one the host composed, so what a member sees never depends
//              on the root or a dispatcher. Spawns of these agent types from anywhere else are
//              denied; the main agent's own subagents pass to the tool gate untouched.
//   standby    a pre-started member (a spare) holds the host's `moment` call. A decision whose
//              standby context matches answers that call with its input; the member answers
//              through `answer`. A decision with no spare starts a member with its input inline.
//              Each member serves one decision (fresh every call); a used one is started again.
//   recycle    a dispatcher's context grows with every member it starts. Past a bound the root
//              starts a new generation; the old one's held spares are retired as their
//              replacements hold, and it ends into the root once empty.
//
// Agent definitions are generic (no prompt of their own): every member's composed text rides in
// its pinned prompt, so an edit reaches the next spare without relaunching the session.
// ---------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import type {
  ClaudeAgentDefinition,
  ClaudeSessionExtension,
  ClaudeSessionHost,
} from './claude-code-session';
import {
  DecisionError,
  type DecisionRequest,
  type DecisionResult,
  type PrimedEvent,
  type PrimedSessions,
  type PrimedSnapshot,
  type PrimeSpec,
} from './primed';

export const IN_SESSION_SERVER = 'foundry-wardens';
const tool = (name: string) => `mcp__${IN_SESSION_SERVER}__${name}`;
const NEXT = tool('next');
const MOMENT = tool('moment');
const ANSWER = tool('answer');
export const IN_SESSION_AGENTS = {
  root: 'foundry-root',
  dispatch: 'foundry-dispatch',
  member: 'foundry-warden',
} as const;
const ROOT_TOKEN = 'root';

/** How long a decision reserved on a spare still starting waits for it before starting its own member. */
const RESERVE_START_MS = 2_000;

const STARTER = (token: string) =>
  `You start Foundry's internal agents and never answer anything yourself. Call ${NEXT} with token "${token}". ` +
  'Its result is either lines of the form `<agent type> <token>` or an instruction to stop. ' +
  'For lines: call the Agent tool once per line, all calls in one single message, each with subagent_type = the agent type, ' +
  'description = the token, prompt = "-" and run_in_background = true. ' +
  `Then call ${NEXT} with token "${token}" again, whatever those calls returned (an Agent call that fails is Foundry's to handle, never a reason to stop). ` +
  'Repeat until its result tells you to stop. Never write any other text, and never stop on your own: notices about agents that finished need no reply.';

const SETUP =
  'This is an internal Foundry setup message, not a message from the user. Start the foundry-root agent in the background now: ' +
  `the Agent tool with subagent_type "${IN_SESSION_AGENTS.root}", description "${ROOT_TOKEN}", prompt "-" and run_in_background true. ` +
  'Then reply with exactly READY and nothing else. Do not mention this setup later; the agent runs for Foundry, not for you.';

const STOP = 'Foundry is done with you. Call nothing more; reply with exactly DONE.';
const RETIRED =
  'This standby is retired: there is no moment to assess. Call nothing; reply with exactly OK.';

const standbyPrompt = (composed: string, token: string) =>
  `${composed}\n\n---\nThe moment to assess has not arrived yet. Call ${MOMENT} with token "${token}" now and do nothing else first. ` +
  `Its result is the moment: the rest of your input. Answer it exactly as your instructions and its response protocol say, by calling ${ANSWER} once with token "${token}" and your whole answer as text. Then reply with exactly OK.`;

const directPrompt = (composed: string, token: string) =>
  `${composed}\n\n---\nAnswer the above exactly as your instructions and its response protocol say, by calling ${ANSWER} once with token "${token}" and your whole answer as text. Then reply with exactly OK.`;

const hash = (value: string) => createHash('sha256').update(value).digest('hex');

export interface ClaudeInSessionConfig {
  /** The members' model (Claude Code agent `model`). */
  model: string;
  effort?: string;
  /** Prepended to every member's composed text. */
  baseInstructions?: string;
  /** Pre-started spares kept per role. Default 1. */
  sparesPerRole?: number;
  /** Default decision deadline. Default 30 s. */
  timeoutMs?: number;
  /** Setup is `degraded` when not every role holds a spare by then. Default 30 s. */
  setupDeadlineMs?: number;
  /** A dispatcher whose context passes this many tokens is replaced. Default 100k. */
  recycleTokens?: number;
  /**
   * Subagents this host may run on top of the user's own concurrent-subagent cap
   * (`CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS`, 20 by default in Claude Code 2.1.300): the root, a
   * dispatcher or two, every held spare and its replacement while the used one finishes, and
   * orphans. The launch raises the cap by this much. Default 76.
   */
  maxSubagents?: number;
  /**
   * Orphaned members (their dispatcher ended unasked) held before the session stops serving
   * decisions in-session. Default 40.
   */
  maxOrphans?: number;
  /** Setup turns per session (the first plus restarts after the root died). Default 2. */
  maxSetups?: number;
  onEvent?: (event: PrimedEvent) => void;
  /** Setup progress: drives "setting up your thread" notices. */
  onSetup?: (setup: InSessionSetup) => void;
}

export interface InSessionSetup {
  readonly status: 'starting' | 'ready' | 'degraded';
  readonly startedAt: number;
  readonly readyAt?: number;
  /** When the root started: what precedes it is the main session's own start and first turn. */
  readonly rootStartedAt?: number;
  readonly wardens: { readonly expected: number; readonly held: number; readonly failed: string[] };
  readonly runtime: 'claude-in-session';
}

type Usage = { input: number; output: number; cacheRead: number; cacheWrite: number };
const zero = (): Usage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

interface Starter {
  readonly token: string;
  readonly kind: 'root' | 'dispatch';
  readonly prompt: string;
  toolUseId?: string;
  taskId?: string;
  /** Its held `next` call. */
  next?: { requestId: string; rpcId: unknown };
  /** Lines waiting for its next `next`. */
  lines: string[];
  /** Its own context, from its latest usage. */
  context: number;
  stopping?: boolean;
  ended?: boolean;
  /** A dispatcher whose line went out to the root. */
  issued?: boolean;
}

interface Member {
  readonly spec: PrimeSpec;
  readonly name: string;
  request: DecisionRequest;
  readonly started: number;
  readonly deadline: number;
  admissionId?: string;
  admitted?: boolean;
  spare?: Spare;
  deliveredAt?: number;
  settled: boolean;
  done: Promise<void>;
  resolve(result: DecisionResult): void;
  reject(error: DecisionError): void;
}

interface Spare {
  readonly token: string;
  /** The role's definition name (hash of its composed text). */
  readonly name: string;
  readonly standbyHash: string;
  readonly prompt: string;
  readonly direct: boolean;
  gen: Starter;
  /** Its line went out in a `next` answer. */
  issued?: boolean;
  toolUseId?: string;
  taskId?: string;
  /** Its held `moment` call. */
  held?: { requestId: string; rpcId: unknown };
  heldAt?: number;
  member?: Member;
  violation?: string;
  /**
   * Its dispatcher ended unasked. It still serves, but it never ends: a nested agent whose parent
   * is gone reports its end (completed or stopped) to the main thread, which wakes the main model
   * (verified on Claude Code 2.1.300). So it is never retired or stopped, and its answer is held.
   */
  orphan?: boolean;
  /** An orphan that answered: held in its `answer` call until the session ends. */
  parked?: boolean;
  /** Superseded by a newer generation or standby: retired once its replacement holds. */
  superseded?: boolean;
  retired?: boolean;
  answered?: boolean;
  done: boolean;
  model?: string;
  standby: Usage;
  usage: Usage;
}

export class ClaudeInSessionDecisions implements PrimedSessions, ClaudeSessionExtension {
  readonly runtime = 'claude' as const;
  readonly mcpServers = [IN_SESSION_SERVER] as const;
  readonly agents: Readonly<Record<string, ClaudeAgentDefinition>>;
  readonly env: Readonly<Record<string, string>>;
  private readonly _config: ClaudeInSessionConfig &
    Required<
      Pick<
        ClaudeInSessionConfig,
        | 'sparesPerRole'
        | 'timeoutMs'
        | 'setupDeadlineMs'
        | 'recycleTokens'
        | 'maxOrphans'
        | 'maxSetups'
      >
    >;
  private _host?: ClaudeSessionHost;
  private _closed = false;
  private _seq = 0;
  private _generation = 0;
  private _root?: Starter;
  private _gen?: Starter;
  private readonly _gens = new Map<string, Starter>();
  private readonly _spares = new Map<string, Spare>();
  private readonly _members = new Set<Member>();
  /** Spawns the CLI refused (its subagent cap): they go out again once one of ours ends. */
  private _awaitingSlot: Spare[] = [];
  /** Roles to keep pre-started: definition name → composed text and standby. */
  private _desired = new Map<string, { composed: string; standbyHash: string }>();
  private _setup: InSessionSetup;
  private _setupTimer?: ReturnType<typeof setTimeout>;
  private _settingUp = false;
  /** A roster arrived (`prestart`): setup is ready once it holds. */
  private _rostered = false;
  /** Setup turns run so far (each one costs a main-model turn). */
  private _setups = 0;
  private _setupAgain = false;
  /** Its session ended: a restarted process (`--resume`) is not set up again. */
  private _detached = false;
  /** Too many orphans: this session no longer serves decisions in-session. */
  private _orphanedOut = false;
  private _rootStartedAt?: number;
  private _ready!: Promise<void>;
  private _markReady!: () => void;

  constructor(config: ClaudeInSessionConfig) {
    this._config = {
      ...config,
      sparesPerRole: config.sparesPerRole ?? 1,
      timeoutMs: config.timeoutMs ?? 30_000,
      setupDeadlineMs: config.setupDeadlineMs ?? 30_000,
      recycleTokens: config.recycleTokens ?? 100_000,
      maxOrphans: config.maxOrphans ?? 40,
      maxSetups: config.maxSetups ?? 2,
    };
    if (this._config.sparesPerRole < 1 || this._config.recycleTokens < 10_000)
      throw Error('Invalid in-session decision bounds');
    // On top of the user's own cap (Claude Code's default 20), so the main agent keeps its slots.
    const own = Number(process.env.CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS) || 20;
    this.env = { CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS: String(own + (config.maxSubagents ?? 76)) };
    const common = {
      model: config.model,
      ...(config.effort ? { effort: config.effort } : {}),
      permissionMode: 'bypassPermissions',
      omitClaudeMd: true,
    };
    // The main model sees these agent types listed; the hook refuses them from anywhere but here.
    this.agents = {
      [IN_SESSION_AGENTS.root]: {
        description: 'Foundry internal. Never start it yourself.',
        prompt: 'Foundry internal agent. Your task arrives as your first message.',
        tools: ['Agent', NEXT],
        background: true,
        ...common,
      },
      [IN_SESSION_AGENTS.dispatch]: {
        description: 'Foundry internal. Never start it yourself.',
        prompt: 'Foundry internal agent. Your task arrives as your first message.',
        tools: ['Agent', NEXT],
        background: true,
        ...common,
      },
      [IN_SESSION_AGENTS.member]: {
        description: 'Foundry internal. Never start it yourself.',
        prompt: "You are one of Foundry's Wardens. Your task arrives as your first message.",
        tools: [MOMENT, ANSWER],
        ...common,
      },
    };
    this._setup = this._setupStatus('starting', Date.now());
    this._resetReady();
  }

  /** Setup progress so far. */
  get setup(): InSessionSetup {
    return this._setup;
  }

  /** It can take decisions now: attached, not closed, and its root is running. */
  serving(): boolean {
    return (
      !this._closed &&
      !this._orphanedOut &&
      !this._detached &&
      !!this._host?.alive() &&
      !!this._root?.taskId &&
      !this._root.ended &&
      // A dispatcher actually running (an old generation serves while a new one starts).
      [...this._gens.values()].some((gen) => !!gen.taskId && !gen.ended)
    );
  }

  /** Roles wanted, and how many hold a spare right now. */
  holding(): { expected: number; held: number } {
    const held = new Set(
      [...this._spares.values()]
        .filter((s) => s.held && !s.done && !s.retired && !s.superseded)
        .map((s) => s.name),
    );
    return {
      expected: this._desired.size,
      held: [...this._desired.keys()].filter((n) => held.has(n)).length,
    };
  }

  /** Resolves when setup is `ready` or `degraded`, or after `timeoutMs` at most. */
  ready(timeoutMs = this._config.setupDeadlineMs): Promise<void> {
    if (this._setup.status !== 'starting') return Promise.resolve();
    let timer: ReturnType<typeof setTimeout> | undefined;
    return Promise.race([
      this._ready,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      }),
    ]).finally(() => clearTimeout(timer));
  }

  // -------------------------------------------------------------------------
  // ClaudeSessionExtension
  // -------------------------------------------------------------------------

  attach(host: ClaudeSessionHost): void {
    // A process restarted after its session ended (`--resume`) still answers the MCP connect, but
    // nothing is set up in it again: whoever held this host already let it go.
    this._host = host;
  }

  started(): void {
    this._startSetup();
  }

  detach(reason: string): void {
    this._detached = true;
    this._host = undefined;
    this._awaitingSlot = [];
    this._desired = new Map();
    clearTimeout(this._setupTimer);
    const lost = () =>
      new DecisionError(`Main session ended (${reason})`, 'transport', 'attempted', true);
    for (const member of [...this._members]) {
      if (member.deliveredAt) member.reject(lost());
      else
        member.reject(
          new DecisionError(`Main session ended (${reason})`, 'transport', 'not-dispatched', true),
        );
    }
    this._spares.clear();
    this._gens.clear();
    this._root = this._gen = undefined;
  }

  mcp(_server: string, requestId: string, message: Record<string, unknown>): void {
    const reply = (m: unknown) => this._host?.mcpReply(requestId, m);
    const id = message.id;
    const text = (t: string, isError = false) =>
      reply({
        jsonrpc: '2.0',
        id,
        result: { ...(isError ? { isError: true } : {}), content: [{ type: 'text', text: t }] },
      });
    if (message.method === 'initialize') {
      reply({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: (message.params as Record<string, unknown> | undefined)?.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: IN_SESSION_SERVER, version: '1' },
        },
      });
      return;
    }
    if (message.method === 'tools/list') {
      const token = { token: { type: 'string' } };
      reply({
        jsonrpc: '2.0',
        id,
        result: {
          tools: [
            {
              name: 'next',
              description: 'Wait for the agents to start.',
              inputSchema: { type: 'object', properties: token, required: ['token'] },
            },
            {
              name: 'moment',
              description: 'Wait for the moment to assess. Its result is your input.',
              inputSchema: { type: 'object', properties: token, required: ['token'] },
            },
            {
              name: 'answer',
              description: 'Give your whole answer.',
              inputSchema: {
                type: 'object',
                properties: { ...token, text: { type: 'string' } },
                required: ['token', 'text'],
              },
            },
          ],
        },
      });
      return;
    }
    if (message.method === 'tools/call') {
      const params = (message.params ?? {}) as Record<string, unknown>;
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      const token = String(args.token ?? '');
      if (params.name === 'next') {
        const starter = token === ROOT_TOKEN ? this._root : this._gens.get(token);
        // A repeated call (the earlier one was abandoned) is held instead of it.
        if (!starter || starter.ended) {
          text('No agents for this token.', true);
          return;
        }
        starter.next = { requestId, rpcId: id };
        // Lines it was given and never started (skipped, or refused) go out again.
        if (starter.kind === 'dispatch')
          for (const spare of this._spares.values())
            if (spare.gen === starter && spare.issued && !spare.toolUseId && !spare.done)
              this._reissue(spare);
        // A dispatcher the root was given and skipped goes out again.
        if (starter.kind === 'root')
          for (const gen of this._gens.values())
            if (gen.issued && !gen.toolUseId && !gen.ended) {
              gen.issued = false;
              const line = `${IN_SESSION_AGENTS.dispatch} ${gen.token}`;
              if (!starter.lines.includes(line)) starter.lines.push(line);
            }
        this._feed(starter);
        if (starter.kind === 'dispatch') {
          this._replenish();
          this._checkSetup();
        }
        return;
      }
      if (params.name === 'moment') {
        const spare = this._spares.get(token);
        if (!spare || spare.done || spare.direct) {
          text('No moment for this token.', true);
          return;
        }
        // A retry after an interrupted call: the moment it was given goes out again.
        const member = spare.member;
        if (member?.deliveredAt && !member.settled && !spare.answered) {
          text(member.request.input);
          return;
        }
        // An earlier held call was abandoned: this one is held instead.
        spare.held = { requestId, rpcId: id };
        spare.heldAt = Date.now();
        this._emit({ type: 'standby', key: spare.name, ...spare.standby });
        if (spare.retired) {
          this._retire(spare);
          return;
        }
        this._deliver(spare);
        this._retireSuperseded(spare);
        this._checkSetup();
        return;
      }
      if (params.name === 'answer') {
        const spare = this._spares.get(token);
        // An orphan (its dispatcher is gone) must never end: its end would reach the main thread.
        // Its answer call is held, so it waits forever and never completes.
        if (spare?.orphan) spare.parked = true;
        else text('Recorded.');
        if (!spare || spare.answered) return;
        spare.answered = true;
        const member = spare.member;
        if (member?.deliveredAt && !member.settled)
          this._settle(spare, member, String(args.text ?? ''));
        return;
      }
    }
    if (id === undefined) {
      reply(null);
      return;
    }
    reply({ jsonrpc: '2.0', id, error: { code: -32601, message: 'method not found' } });
  }

  preToolUse(input: Record<string, unknown>): Record<string, unknown> | undefined {
    const name = input.tool_name;
    const agentId = typeof input.agent_id === 'string' ? input.agent_id : undefined;
    const toolInput = (input.tool_input ?? {}) as Record<string, unknown>;
    const type = toolInput.subagent_type;
    const ours = agentId ? this._ownTask(agentId) : undefined;
    const deny = (reason: string) => ({
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    });
    const allow = (updatedInput?: Record<string, unknown>) => ({
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      ...(updatedInput ? { updatedInput } : {}),
    });
    if (name === 'Agent' || name === 'Task') {
      const internal = Object.values(IN_SESSION_AGENTS).includes(type as never);
      if (!internal) return ours ? deny('Not an agent this one may start.') : undefined;
      const description = String(toolInput.description ?? '');
      const pin = (prompt: string) =>
        allow({ subagent_type: type, description, prompt, run_in_background: true });
      if (type === IN_SESSION_AGENTS.root) {
        const root = this._root;
        if (agentId || !root || root.toolUseId || description !== ROOT_TOKEN)
          return deny('Foundry starts this agent itself.');
        root.toolUseId = String(input.tool_use_id ?? '');
        return pin(root.prompt);
      }
      if (type === IN_SESSION_AGENTS.dispatch) {
        const gen = this._gens.get(description);
        if (!ours || ours !== this._root || !gen || gen.toolUseId)
          return deny('Foundry starts this agent itself.');
        gen.toolUseId = String(input.tool_use_id ?? '');
        return pin(gen.prompt);
      }
      const spare = this._spares.get(description);
      if (!ours || !spare || spare.gen !== ours || spare.toolUseId)
        return deny('Foundry starts this agent itself.');
      spare.toolUseId = String(input.tool_use_id ?? '');
      return pin(spare.prompt);
    }
    // The main agent (or the user's own subagents) never stops or messages Foundry's agents.
    if (!ours) {
      const ids = this._taskIds();
      const text = JSON.stringify(toolInput);
      return ids.some((id) => text.includes(id))
        ? deny('Foundry internal agent: not yours to stop or message.')
        : undefined;
    }
    // Its agents may use only the host's own tools.
    const starter = 'kind' in ours;
    if ((starter ? [NEXT] : [MOMENT, ANSWER]).includes(String(name))) return allow();
    if (!starter) ours.violation = `tool ${String(name)}`;
    return deny('Not a tool this agent may use.');
  }

  permission(request: Record<string, unknown>): Record<string, unknown> | undefined {
    const agentId = typeof request.agent_id === 'string' ? request.agent_id : undefined;
    if (!agentId || !this._ownTask(agentId)) return undefined;
    const name = String(request.tool_name ?? '');
    return [NEXT, MOMENT, ANSWER, 'Agent'].includes(name)
      ? { behavior: 'allow', updatedInput: request.input ?? {} }
      : { behavior: 'deny', message: 'Not a tool this agent may use.' };
  }

  frame(raw: Record<string, unknown>): boolean {
    const parent = typeof raw.parent_tool_use_id === 'string' ? raw.parent_tool_use_id : undefined;
    if (
      raw.type === 'system' &&
      typeof raw.subtype === 'string' &&
      raw.subtype.startsWith('task_')
    ) {
      const taskId = typeof raw.task_id === 'string' ? raw.task_id : undefined;
      const toolUseId = typeof raw.tool_use_id === 'string' ? raw.tool_use_id : undefined;
      const owner =
        (toolUseId && this._byToolUse(toolUseId)) || (taskId && this._ownTask(taskId)) || undefined;
      if (!owner) return false;
      if (raw.subtype === 'task_started' && taskId) {
        owner.taskId = taskId;
        if (owner === this._root) this._rootStartedAt = Date.now();
        if ('name' in owner && raw.prompt !== undefined && raw.prompt !== owner.prompt)
          owner.violation = 'input was not the composed input';
      }
      if (raw.subtype === 'task_notification') {
        this._ended(owner, String(raw.status ?? 'unknown'));
        // A slot freed: one refused spawn goes out again.
        const waiting = this._awaitingSlot.shift();
        if (waiting) {
          this._reissue(waiting);
          if (this._gen) this._feed(this._gen);
        }
      }
      return true;
    }
    if (!parent) return false;
    const owner = this._byToolUse(parent);
    if (!owner) return false;
    const message = raw.message as Record<string, unknown> | undefined;
    // A starter's Agent call the CLI refused (a concurrency cap, an error): its agent never started.
    if (raw.type === 'user' && 'kind' in owner && Array.isArray(message?.content))
      for (const block of message.content as Array<Record<string, unknown>>) {
        if (block.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue;
        const spawned = this._byToolUse(block.tool_use_id);
        const text = JSON.stringify(block.content ?? '');
        if (spawned && !spawned.taskId && (block.is_error === true || !text.includes('launched')))
          this._unstarted(spawned, owner);
      }
    const usage = message?.usage as Record<string, number> | undefined;
    if (raw.type === 'assistant' && usage) {
      const add = {
        input: usage.input_tokens ?? 0,
        output: usage.output_tokens ?? 0,
        cacheRead: usage.cache_read_input_tokens ?? 0,
        cacheWrite: usage.cache_creation_input_tokens ?? 0,
      };
      if ('kind' in owner) {
        owner.context = add.input + add.cacheRead + add.cacheWrite;
        if (
          owner.kind === 'dispatch' &&
          owner === this._gen &&
          owner.context > this._config.recycleTokens
        )
          this._recycle();
      } else {
        const target = owner.member?.deliveredAt ? owner.usage : owner.standby;
        for (const key of Object.keys(add) as Array<keyof Usage>) target[key] += add[key];
        if (typeof message?.model === 'string') owner.model = message.model;
      }
    }
    return true;
  }

  // -------------------------------------------------------------------------
  // PrimedSessions
  // -------------------------------------------------------------------------

  limits() {
    return undefined;
  }

  async readLimits() {
    return undefined;
  }

  snapshot(): PrimedSnapshot {
    return {
      runtime: 'claude',
      closed: this._closed,
      generation: this._generation,
      processAlive: !!this._host?.alive(),
      sessions: this._gens.size,
      active: [...this._members].filter((m) => m.deliveredAt && !m.settled).length,
      waiting: [...this._members].filter((m) => !m.deliveredAt && !m.settled).length,
    };
  }

  async evict(_key: string): Promise<void> {}

  decide(spec: PrimeSpec, request: DecisionRequest): Promise<DecisionResult> {
    if (this._closed || !this._host?.alive())
      return Promise.reject(
        new DecisionError('In-session decisions unavailable', 'closed', 'not-dispatched', true),
      );
    if (!spec.key || typeof spec.instructions !== 'string' || typeof request.input !== 'string')
      return Promise.reject(
        new DecisionError('Invalid decision request', 'admission', 'not-dispatched', true),
      );
    if (request.signal?.aborted)
      return Promise.reject(
        new DecisionError('Decision aborted before dispatch', 'aborted', 'not-dispatched', true),
      );
    const composed = this._compose(spec);
    const name = `d-${hash(composed).slice(0, 16)}`;
    const spare =
      request.standby === undefined ? undefined : this._spareFor(name, hash(request.standby));
    const started = Date.now();
    let settle!: () => void;
    const done = new Promise<void>((r) => {
      settle = r;
    });
    return new Promise<DecisionResult>((resolve, reject) => {
      const member: Member = {
        spec,
        name,
        request,
        started,
        deadline: started + (request.timeoutMs ?? this._config.timeoutMs),
        settled: false,
        done,
        resolve: (result) => {
          if (member.settled) return;
          member.settled = true;
          clearTimeout(timer);
          this._members.delete(member);
          settle();
          resolve(result);
        },
        reject: (error) => {
          if (member.settled) return;
          member.settled = true;
          clearTimeout(timer);
          this._members.delete(member);
          settle();
          reject(error);
        },
      };
      this._members.add(member);
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
      } else void this._direct(member, composed);
    });
  }

  /**
   * Keep these roles pre-started with this standby context (the thread as it now stands). Spares
   * holding other context are retired once their replacements hold.
   */
  prestart(_group: string, entries: ReadonlyArray<{ spec: PrimeSpec; standby: string }>): void {
    if (this._closed) return;
    this._rostered = true;
    this._desired = new Map(
      entries.map((e) => {
        const composed = this._compose(e.spec);
        return [
          `d-${hash(composed).slice(0, 16)}`,
          { composed: `${composed}${e.standby}`, standbyHash: hash(e.standby) },
        ];
      }),
    );
    for (const spare of this._spares.values())
      if (
        !spare.direct &&
        !spare.member &&
        this._desired.get(spare.name)?.standbyHash !== spare.standbyHash
      )
        spare.superseded = true;
    this._replenish();
    this._checkSetup();
    // A role no longer wanted holds a spare nobody replaces: retire it now.
    for (const spare of this._spares.values())
      if (spare.superseded && !this._desired.has(spare.name)) this._retire(spare);
  }

  async releaseGroup(_group: string): Promise<void> {
    await this.close();
  }

  async close(): Promise<void> {
    if (this._closed) return;
    this._closed = true;
    clearTimeout(this._setupTimer);
    for (const member of [...this._members])
      member.reject(
        new DecisionError('In-session decisions closed', 'closed', 'not-dispatched', true),
      );
    this._desired = new Map();
    // Drained the way a recycle is: members are retired (they end into their live dispatchers),
    // and each dispatcher ends into the root once empty. The root is never ended: its end would
    // reach the main thread, which may go on without in-session decisions.
    for (const spare of this._spares.values()) this._retire(spare);
    for (const gen of this._gens.values()) {
      gen.stopping = true;
      gen.lines = [];
      this._endIfEmpty(gen);
    }
  }

  // -------------------------------------------------------------------------

  private _emit(event: PrimedEvent): void {
    try {
      this._config.onEvent?.(event);
    } catch {
      /* observers only */
    }
  }

  private _compose(spec: PrimeSpec): string {
    return [this._config.baseInstructions, spec.instructions, spec.context]
      .filter(Boolean)
      .join('\n\n');
  }

  private _setupStatus(
    status: InSessionSetup['status'],
    startedAt: number,
    readyAt?: number,
  ): InSessionSetup {
    const held = new Set(
      [...this._spares.values()]
        .filter((s) => s.held && !s.done && !s.superseded && !s.retired)
        .map((s) => s.name),
    );
    const expected = this._desired?.size ?? 0;
    return {
      status,
      startedAt,
      ...(readyAt ? { readyAt } : {}),
      ...(this._rootStartedAt ? { rootStartedAt: this._rootStartedAt } : {}),
      wardens: {
        expected,
        held: [...(this._desired?.keys() ?? [])].filter((n) => held.has(n)).length,
        failed:
          status === 'degraded'
            ? [...(this._desired?.keys() ?? [])].filter((n) => !held.has(n))
            : [],
      },
      runtime: 'claude-in-session',
    };
  }

  private _publishSetup(status = this._setup.status): void {
    const readyAt = status === 'starting' ? undefined : (this._setup.readyAt ?? Date.now());
    this._setup = this._setupStatus(status, this._setup.startedAt, readyAt);
    try {
      this._config.onSetup?.(this._setup);
    } catch {
      /* observers only */
    }
    if (status !== 'starting') this._markReady();
  }

  private _resetReady(): void {
    this._ready = new Promise<void>((resolve) => {
      this._markReady = resolve;
    });
  }

  /** The setup turn: the main model starts the root, which then serves everything else. */
  private _startSetup(): void {
    if (this._closed || this._detached || !this._host) return;
    // A root that died while its setup turn is still running is set up again once that turn ends.
    if (this._settingUp) {
      this._setupAgain = true;
      return;
    }
    // Each setup is a main-model turn: a root that keeps dying stops being restarted.
    if (this._setups >= this._config.maxSetups) {
      this._publishSetup('degraded');
      return;
    }
    this._setups++;
    this._settingUp = true;
    this._setup = this._setupStatus('starting', Date.now());
    this._resetReady();
    this._publishSetup('starting');
    this._root = {
      token: ROOT_TOKEN,
      kind: 'root',
      prompt: STARTER(ROOT_TOKEN),
      lines: [],
      context: 0,
    };
    this._newGeneration();
    clearTimeout(this._setupTimer);
    this._setupTimer = setTimeout(() => {
      if (this._setup.status === 'starting') this._publishSetup('degraded');
    }, this._config.setupDeadlineMs);
    void this._host
      .sendInternal(SETUP)
      .catch(() => undefined)
      .finally(() => {
        this._settingUp = false;
        if (this._setupAgain) {
          this._setupAgain = false;
          this._startSetup();
          return;
        }
        // The main model did not start the root: nothing in-session serves this thread.
        if (!this._root?.toolUseId && this._setup.status === 'starting')
          this._publishSetup('degraded');
      });
  }

  private _checkSetup(): void {
    if (this._setup.status !== 'starting') return;
    const held = new Set(
      [...this._spares.values()].filter((s) => s.held && !s.done && !s.retired).map((s) => s.name),
    );
    const all = [...this._desired.keys()].every((name) => held.has(name));
    if (this._rostered && all && this._gen?.next) {
      clearTimeout(this._setupTimer);
      this._publishSetup('ready');
    } else this._publishSetup('starting');
  }

  private _newGeneration(): Starter {
    const token = `g${++this._generation}`;
    const gen: Starter = { token, kind: 'dispatch', prompt: STARTER(token), lines: [], context: 0 };
    this._gens.set(token, gen);
    this._gen = gen;
    this._root!.lines.push(`${IN_SESSION_AGENTS.dispatch} ${token}`);
    this._feed(this._root!);
    return gen;
  }

  /** A dispatcher past its bound: a new generation takes new spares; the old one's are retired as replacements hold. */
  private _recycle(): void {
    const old = this._gen;
    if (!old || old.stopping || !this._root?.taskId) return;
    old.stopping = true;
    this._emit({
      type: 'process-recycled',
      generation: this._generation,
      reason: 'dispatcher context bound',
    });
    for (const spare of this._spares.values())
      if (spare.gen === old && !spare.member && !spare.done) spare.superseded = true;
    this._newGeneration();
    this._replenish();
    this._endIfEmpty(old);
  }

  /** Answer a starter's held `next` with what it should start (or stop). */
  private _feed(starter: Starter): void {
    if (!starter.next) return;
    let text: string | undefined;
    if (starter.lines.length) {
      const lines = starter.lines.splice(0);
      for (const line of lines) {
        const token = line.split(' ')[1] ?? '';
        const spawned = this._spares.get(token) ?? this._gens.get(token);
        if (spawned) spawned.issued = true;
      }
      text = lines.join('\n');
    } else if (starter.stopping && starter.kind === 'dispatch' && this._empty(starter)) text = STOP;
    if (!text) return;
    const { requestId, rpcId } = starter.next;
    starter.next = undefined;
    this._host?.mcpReply(requestId, {
      jsonrpc: '2.0',
      id: rpcId,
      result: { content: [{ type: 'text', text }] },
    });
  }

  private _empty(gen: Starter): boolean {
    return ![...this._spares.values()].some((s) => s.gen === gen && !s.done);
  }

  private _endIfEmpty(gen: Starter): void {
    if (gen.stopping && this._empty(gen)) this._feed(gen);
  }

  /** Stop a starter at close: its next call ends it. */
  private _stop(starter: Starter): void {
    starter.stopping = true;
    starter.lines = [];
    if (starter.next) {
      const { requestId, rpcId } = starter.next;
      starter.next = undefined;
      this._host?.mcpReply(requestId, {
        jsonrpc: '2.0',
        id: rpcId,
        result: { content: [{ type: 'text', text: STOP }] },
      });
    }
  }

  private _taskIds(): string[] {
    const ids: string[] = [];
    if (this._root?.taskId) ids.push(this._root.taskId);
    for (const gen of this._gens.values()) if (gen.taskId) ids.push(gen.taskId);
    for (const spare of this._spares.values()) if (spare.taskId) ids.push(spare.taskId);
    return ids;
  }

  private _ownTask(taskId: string): Starter | Spare | undefined {
    if (this._root?.taskId === taskId) return this._root;
    for (const gen of this._gens.values()) if (gen.taskId === taskId) return gen;
    for (const spare of this._spares.values()) if (spare.taskId === taskId) return spare;
    return undefined;
  }

  private _byToolUse(id: string): Starter | Spare | undefined {
    if (this._root?.toolUseId === id) return this._root;
    for (const gen of this._gens.values()) if (gen.toolUseId === id) return gen;
    for (const spare of this._spares.values()) if (spare.toolUseId === id) return spare;
    return undefined;
  }

  private _spareFor(name: string, standbyHash: string): Spare | undefined {
    let best: Spare | undefined;
    for (const spare of this._spares.values()) {
      if (spare.direct || spare.name !== name || spare.standbyHash !== standbyHash) continue;
      if (spare.member || spare.done || spare.violation || spare.retired) continue;
      if (
        !best ||
        (spare.held && !best.held) ||
        (!!spare.held === !!best.held && !spare.superseded && best.superseded)
      )
        best = spare;
    }
    return best;
  }

  /** Keep `sparesPerRole` free spares of every desired role, in the current generation. */
  private _replenish(): void {
    const gen = this._gen;
    if (this._closed || !gen || gen.stopping) return;
    const free = new Map<string, number>();
    for (const spare of this._spares.values())
      if (!spare.direct && !spare.member && !spare.done && !spare.superseded && !spare.retired)
        if (this._desired.get(spare.name)?.standbyHash === spare.standbyHash)
          free.set(spare.name, (free.get(spare.name) ?? 0) + 1);
    for (const [name, desired] of this._desired)
      for (let n = free.get(name) ?? 0; n < this._config.sparesPerRole; n++) {
        const token = `w${++this._seq}`;
        this._spares.set(token, {
          token,
          name,
          standbyHash: desired.standbyHash,
          prompt: standbyPrompt(desired.composed, token),
          direct: false,
          gen,
          done: false,
          standby: zero(),
          usage: zero(),
        });
        gen.lines.push(`${IN_SESSION_AGENTS.member} ${token}`);
      }
    this._feed(gen);
  }

  /** A spare's replacement holds: retire one superseded spare of the same role. */
  private _retireSuperseded(holder: Spare): void {
    if (holder.superseded || holder.direct) return;
    for (const spare of this._spares.values())
      if (
        spare !== holder &&
        spare.name === holder.name &&
        spare.superseded &&
        !spare.member &&
        !spare.retired
      ) {
        this._retire(spare);
        return;
      }
  }

  /** End an unused spare: its held moment gets no input (or its moment, when it calls). */
  private _retire(spare: Spare): void {
    if (spare.member && !spare.member.settled) return;
    spare.retired = true;
    // An orphan's moment stays held: answering it would end it into the main thread.
    if (spare.orphan) return;
    if (!spare.held) return;
    const { requestId, rpcId } = spare.held;
    spare.held = undefined;
    this._host?.mcpReply(requestId, {
      jsonrpc: '2.0',
      id: rpcId,
      result: { content: [{ type: 'text', text: RETIRED }] },
    });
  }

  private async _admit(member: Member): Promise<boolean> {
    member.admissionId ??= crypto.randomUUID();
    if (member.admitted) return true;
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
      member.reject(
        new DecisionError(
          'Decision admission refused before dispatch',
          'admission',
          'not-dispatched',
          true,
          member.admissionId,
        ),
      );
      return false;
    }
    if (member.settled) return false;
    member.admitted = true;
    return true;
  }

  private async _reserve(spare: Spare, member: Member): Promise<void> {
    if (!(await this._admit(member))) {
      if (spare.member === member) spare.member = undefined;
      return;
    }
    if (spare.member !== member) return;
    if (spare.held) {
      this._deliver(spare);
      return;
    }
    setTimeout(() => {
      if (spare.member === member && !member.deliveredAt && !member.settled) this._fallback(member);
    }, RESERVE_START_MS);
  }

  /** A reserved decision its spare cannot serve in time: it starts its own member. */
  private _fallback(member: Member): void {
    const spare = member.spare;
    if (!spare || member.settled || member.deliveredAt) return;
    if (spare.member === member) spare.member = undefined;
    member.spare = undefined;
    void this._direct(member, this._compose(member.spec));
  }

  private _deliver(spare: Spare): void {
    const member = spare.member;
    if (!member || member.settled || member.deliveredAt || !member.admitted || !spare.held) return;
    if (spare.violation) {
      this._fallback(member);
      return;
    }
    member.deliveredAt = Date.now();
    const { requestId, rpcId } = spare.held;
    spare.held = undefined;
    this._host?.mcpReply(requestId, {
      jsonrpc: '2.0',
      id: rpcId,
      result: { content: [{ type: 'text', text: member.request.input }] },
    });
    // The spare is used: start its replacement now.
    this._replenish();
  }

  /** A decision with no spare: a member started with its whole input. */
  private async _direct(member: Member, composed: string): Promise<void> {
    if (!(await this._admit(member))) return;
    const gen = this._gen;
    if (!gen) {
      member.reject(
        new DecisionError(
          'No dispatcher running',
          'transport',
          'not-dispatched',
          true,
          member.admissionId,
        ),
      );
      return;
    }
    const token = `w${++this._seq}`;
    const input = `${member.request.standby ?? ''}${member.request.input}`;
    const spare: Spare = {
      token,
      name: member.name,
      standbyHash: '',
      prompt: directPrompt(`${composed}${input}`, token),
      direct: true,
      gen,
      member,
      done: false,
      standby: zero(),
      usage: zero(),
    };
    member.spare = spare;
    // Written when the dispatcher takes it: delivered from here on.
    member.deliveredAt = Date.now();
    this._spares.set(token, spare);
    gen.lines.push(`${IN_SESSION_AGENTS.member} ${token}`);
    this._feed(gen);
  }

  private _settle(spare: Spare, member: Member, content: string): void {
    if (spare.violation) {
      this._emit({ type: 'violation', key: member.spec.key, detail: spare.violation });
      member.reject(
        new DecisionError(
          `Decision violated the decision policy (${spare.violation})`,
          'violation',
          'attempted',
          true,
          member.admissionId,
        ),
      );
      return;
    }
    const now = Date.now();
    this._emit({
      type: 'decision',
      key: member.spec.key,
      prime: spare.direct ? 'cold' : 'warm',
      ms: now - member.started,
      cacheRead: spare.usage.cacheRead,
    });
    member.resolve({
      key: member.spec.key,
      admissionId: member.admissionId!,
      content,
      tokens: { ...spare.usage },
      ...(spare.model ? { model: spare.model } : {}),
      ...(spare.taskId ? { threadId: spare.taskId } : {}),
      ...(spare.toolUseId ? { turnId: spare.toolUseId } : {}),
      prime: spare.direct ? 'cold' : 'warm',
      timing: {
        waitMs: (member.deliveredAt ?? now) - member.started,
        primeMs: 0,
        branchMs: 0,
        turnMs: now - (member.deliveredAt ?? member.started),
      },
    });
  }

  /** A task of ours ended. */
  private _ended(owner: Starter | Spare, status: string): void {
    if ('kind' in owner) {
      owner.ended = true;
      owner.next = undefined;
      if (owner.kind === 'root') {
        // The root ended unasked (that end reached the main thread once). Its dispatchers stay
        // blocked in `next` for good; their members are orphans; setup runs again.
        if (this._closed) return;
        const orphaned = [...this._spares.values()].filter((sp) => !sp.done);
        this._gens.clear();
        this._gen = undefined;
        this._root = undefined;
        this._publishSetup('degraded');
        this._startSetup();
        for (const spare of orphaned) this._orphan(spare);
        this._replenish();
        return;
      }
      // Its members outlive it (nested background agents are not stopped with their parent).
      this._gens.delete(owner.token);
      const planned = owner.stopping && this._empty(owner);
      if (owner === this._gen && !this._closed) this._newGeneration();
      if (!planned && !this._closed)
        for (const spare of this._spares.values())
          if (spare.gen === owner && !spare.done) this._orphan(spare);
      this._replenish();
      return;
    }
    this._lost(owner, status);
    this._replenish();
  }

  /**
   * A member whose dispatcher ended unasked: one that never started goes to the current
   * dispatcher; one that runs is an orphan. Too many orphans and the session stops serving
   * in-session (its caller falls back), since each holds a subagent slot until the session ends.
   */
  private _orphan(spare: Spare): void {
    if (!spare.toolUseId) {
      this._reissue(spare);
      return;
    }
    if (spare.orphan) return;
    spare.orphan = true;
    const orphans = [...this._spares.values()].filter((sp) => sp.orphan && !sp.done).length;
    if (orphans > this._config.maxOrphans && !this._orphanedOut) {
      this._orphanedOut = true;
      this._emit({
        type: 'process-recycled',
        generation: this._generation,
        reason: `${orphans} orphaned members held; in-session decisions stop for this session`,
      });
      this._publishSetup('degraded');
    }
  }

  /** A spawn that never started: its line goes out again. */
  private _unstarted(spawned: Starter | Spare, by: Starter): void {
    spawned.toolUseId = undefined;
    if ('kind' in spawned) {
      // A dispatcher the root could not start: ask again.
      if (!this._closed && this._gens.has(spawned.token))
        by.lines.push(`${IN_SESSION_AGENTS.dispatch} ${spawned.token}`);
      return;
    }
    spawned.issued = false;
    if (!this._awaitingSlot.includes(spawned)) this._awaitingSlot.push(spawned);
    // A reserved decision does not wait for a slot: it fans out like any other.
    if (spawned.member && !spawned.member.deliveredAt && !spawned.direct)
      this._fallback(spawned.member);
  }

  private _reissue(spare: Spare): void {
    const gen = this._gen;
    if (this._closed || !gen || spare.done) return;
    spare.gen = gen;
    spare.issued = false;
    const line = `${IN_SESSION_AGENTS.member} ${spare.token}`;
    if (!gen.lines.includes(line)) gen.lines.push(line);
  }

  private _lost(spare: Spare, status: string): void {
    spare.done = true;
    spare.held = undefined;
    this._spares.delete(spare.token);
    const member = spare.member;
    if (!member || member.settled) {
      this._endIfEmpty(spare.gen);
      return;
    }
    if (!member.deliveredAt && !spare.direct) this._fallback(member);
    else
      member.reject(
        new DecisionError(
          `Subagent ended without an answer (${status})`,
          spare.violation ? 'violation' : 'native-failed',
          'attempted',
          true,
          member.admissionId,
        ),
      );
    this._endIfEmpty(spare.gen);
  }

  /** Past its deadline or aborted: refused unsent, or rejected and its member stopped. */
  private async _withdraw(member: Member, reason: 'timeout' | 'aborted'): Promise<void> {
    if (member.settled) return;
    const message = reason === 'timeout' ? 'Decision deadline passed' : 'Decision aborted';
    const spare = member.spare;
    if (!member.deliveredAt) {
      if (spare && spare.member === member) spare.member = undefined;
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
    member.reject(
      new DecisionError(
        `${message}; subagent being stopped`,
        reason,
        'attempted',
        false,
        member.admissionId,
      ),
    );
    if (!spare) return;
    // A direct member not yet started never starts.
    if (!spare.toolUseId) {
      spare.done = true;
      this._spares.delete(spare.token);
      spare.gen.lines = spare.gen.lines.filter((l) => !l.endsWith(` ${spare.token}`));
      return;
    }
    // A member is a leaf: stopping it ends into its dispatcher, never the main thread. An orphan
    // has no dispatcher, so it is left as it is.
    if (spare.taskId && !spare.orphan && this._host?.alive())
      await this._host
        .control({ subtype: 'stop_task', task_id: spare.taskId }, 2_000)
        .catch(() => undefined);
  }
}
