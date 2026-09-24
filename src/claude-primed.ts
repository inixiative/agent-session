// ---------------------------------------------------------------------------
// ClaudePrimedSessions — primed decision sessions on the Claude CLI
// ---------------------------------------------------------------------------
//
// The CLI serves one conversation per process, so each key owns:
//
//   prime   a text-only session with the role instructions as its appended
//           system prompt, plus one primer turn carrying the stable context.
//           That session is persisted; its process exits.
//   decide  a fork of the primed session (`--resume <primed> --fork-session
//           --no-session-persistence`) receives the cycle input and exits. The
//           next fork is spawned right away as a warm spare, so the following
//           decision pays no process start. Forks send the primed prefix
//           byte-for-byte, so it is read from the prompt cache.
//
// Verified live with claude 2.1.281: forks read the full primed prefix from
// cache (cache_read equal to the primer's cache write) and write nothing to
// history.
// ---------------------------------------------------------------------------

import { readdirSync, realpathSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ClaudeCodeSession, type ClaudeCodeSessionConfig, type PipedSubprocess } from "./claude-code-session";
import { SessionTurnError, type SessionResult } from "./harness-session";
import { mergeLimits, type LimitSnapshot } from "./limits";
import {
  DecisionError, KeyedQueue, primeHash, Slots,
  type DecisionRequest, type DecisionResult, type PrimedEvent, type PrimedSessions, type PrimedSnapshot, type PrimeSpec,
} from "./primed";

const PRIMER_SUFFIX = "\n\nThe above is standing context for the decisions that follow. Reply with OK only.";

export interface ClaudePrimedConfig {
  bin?: string;
  model: string;
  effort?: string;
  /** Private working directory for primed sessions. */
  cwd: string;
  /** Prepended to every key's instructions in the appended system prompt. */
  baseInstructions?: string;
  /** Merged over process.env (e.g. CLAUDE_CONFIG_DIR). API keys are always removed. */
  env?: Record<string, string | undefined>;
  spawn?: ClaudeCodeSessionConfig["spawn"];
  /** Concurrent decisions across keys. Default 1 (one refresh owner per profile). */
  maxConcurrent?: number;
  /** Keys kept primed; least recently used idle keys are evicted beyond this. Default 64. */
  maxSessions?: number;
  /** Evict keys idle longer than this. Default 30 min. */
  idleMs?: number;
  timeoutMs?: number;
  /** Pre-spawn the next fork after each decision. Default true. */
  spare?: boolean;
  /**
   * Delete primed transcripts this host persisted when a key is dropped, and
   * transcripts a crashed host left for `cwd`, on first use. `cwd` must be
   * dedicated to this host. Default true.
   */
  sweepTranscripts?: boolean;
  onEvent?: (event: PrimedEvent) => void;
}

interface Owned { session: ClaudeCodeSession; exited?: Promise<number> }
interface Primed {
  readonly key: string;
  readonly hash: string;
  readonly instructions: string;
  readonly base?: ClaudeCodeSession;
  spare?: Owned;
  /** Disposal of the last branch and start of its spare; the key's next decision waits for it. */
  cleanup?: Promise<void>;
  model?: string;
  lastUsed: number;
  busy: boolean;
}

export class ClaudePrimedSessions implements PrimedSessions {
  readonly runtime = "claude" as const;
  private readonly _config: ClaudePrimedConfig & Required<Pick<ClaudePrimedConfig, "maxConcurrent" | "maxSessions" | "idleMs" | "timeoutMs" | "spare">>;
  private _sessions = new Map<string, Primed>();
  private _queue = new KeyedQueue();
  private _slots: Slots;
  private _limits?: LimitSnapshot;
  private _closed = false;
  private _idleTimer?: ReturnType<typeof setInterval>;
  /** Branches and primers with a live process, so close() can stop them. */
  private _live = new Set<Owned>();
  private _swept = false;
  private _lastPoll = 0;

  constructor(config: ClaudePrimedConfig) {
    if (!config.cwd?.startsWith("/")) throw Error("Primed Claude sessions require an absolute private working directory");
    this._config = { ...config, maxConcurrent: config.maxConcurrent ?? 1, maxSessions: config.maxSessions ?? 64,
      idleMs: config.idleMs ?? 30 * 60_000, timeoutMs: config.timeoutMs ?? 30_000, spare: config.spare ?? true };
    this._slots = new Slots(this._config.maxConcurrent);
  }

  limits(): LimitSnapshot | undefined { return this._limits; }

  snapshot(): PrimedSnapshot {
    return { runtime: "claude", closed: this._closed, generation: 0, processAlive: [...this._sessions.values()].some(s => s.spare?.session.alive),
      sessions: this._sessions.size, active: this._slots.active, waiting: this._slots.waiting, ...(this._limits ? { limits: this._limits } : {}) };
  }

  /** get_usage through a short-lived text-only session. No model turn. */
  async readLimits(opts?: { timeoutMs?: number }): Promise<LimitSnapshot | undefined> {
    if (this._closed) throw new DecisionError("Primed sessions closed", "closed", "not-dispatched", true);
    this._lastPoll = Date.now();
    const probe = this._owned({ persistSession: false });
    try { await probe.session.start(); return await probe.session.readLimits(opts); }
    finally { await this._dispose(probe); }
  }

  decide(spec: PrimeSpec, request: DecisionRequest): Promise<DecisionResult> {
    if (this._closed) return Promise.reject(new DecisionError("Primed sessions closed", "closed", "not-dispatched", true));
    if (!spec.key || typeof spec.instructions !== "string" || typeof request.input !== "string")
      return Promise.reject(new DecisionError("Invalid decision request", "admission", "not-dispatched", true));
    const started = Date.now(), deadline = started + (request.timeoutMs ?? this._config.timeoutMs);
    this._idleTimer ??= setInterval(() => void this._evictIdle(), Math.min(this._config.idleMs, 60_000));
    (this._idleTimer as { unref?: () => void }).unref?.();
    return this._queue.run(spec.key, async () => {
      const release = await this._slots.acquire(deadline);
      try { return await this._decide(spec, request, started, deadline); }
      finally { release(); }
    });
  }

  async evict(key: string): Promise<void> {
    await this._queue.run(key, async () => { const s = this._sessions.get(key); if (s) await this._drop(s, "requested"); });
  }

  async close(): Promise<void> {
    if (this._closed) return;
    this._closed = true;
    clearInterval(this._idleTimer);
    this._slots.drain(new DecisionError("Primed sessions closed", "closed", "not-dispatched", true));
    // In-flight branches and primers are stopped, not awaited to completion.
    await Promise.all([...this._live].map(owned => this._dispose(owned)));
    await Promise.all([...this._sessions.values()].map(s => this._drop(s, "close")));
  }

  // -------------------------------------------------------------------------

  private _emit(event: PrimedEvent): void { try { this._config.onEvent?.(event); } catch { /* observers only */ } }

  /** Refuse before dispatch while the account reports usage blocked; a poll (at most once a minute) can clear it. */
  private async _checkLimits(): Promise<void> {
    if (!this._limits?.blocked) return;
    const now = Date.now();
    const resets = this._limits.windows.filter(w => w.usedPercent >= 100 && w.resetsAt).map(w => w.resetsAt!);
    if (resets.length && now >= Math.max(...resets)) { this._limits = { ...this._limits, blocked: false }; return; }
    if (now - this._lastPoll >= 60_000) {
      try { const polled = await this.readLimits({ timeoutMs: 10_000 }); if (polled) this._limits = mergeLimits(this._limits, polled); }
      catch { /* keep the blocked view */ }
    }
    if (this._limits?.blocked) throw new DecisionError("Claude subscription usage limit reached; no fallback", "rate-limited", "not-dispatched", true);
  }

  /** A session whose process exit is observable, so settlement can be proven. */
  private _owned(overrides: Partial<ClaudeCodeSessionConfig> & { instructions?: string }, from?: ClaudeCodeSession): Owned {
    const owned = {} as Owned;
    const spawn: NonNullable<ClaudeCodeSessionConfig["spawn"]> = (cmd, options) => {
      const child: PipedSubprocess = this._config.spawn ? this._config.spawn(cmd, options)
        : Bun.spawn(cmd, { ...options, stdin: "pipe", stdout: "pipe", stderr: "pipe" }) as unknown as PipedSubprocess;
      owned.exited = child.exited;
      return child;
    };
    const { instructions, ...rest } = overrides;
    owned.session = from ? from.fork({ persistSession: false, spawn }) : new ClaudeCodeSession({
      bin: this._config.bin, model: this._config.model, effort: this._config.effort, cwd: this._config.cwd, env: this._config.env,
      textOnly: true, maxTurns: 1, timeout: this._config.timeoutMs,
      baseContext: [this._config.baseInstructions, instructions].filter(Boolean).join("\n\n") || undefined, ...rest, spawn,
    });
    this._live.add(owned);
    owned.session.onEvent(event => {
      if (event.kind === "rate_limit" && event.limits) {
        this._limits = mergeLimits(this._limits, event.limits);
        this._emit({ type: "limits", limits: this._limits });
      }
    });
    return owned;
  }

  /** Kill and wait (bounded) for exit; true when exit was observed. */
  private async _dispose(owned: Owned | undefined): Promise<boolean> {
    if (!owned) return true;
    this._live.delete(owned);
    owned.session.kill();
    if (!owned.exited) return true;
    return Promise.race([owned.exited.then(() => true, () => false), Bun.sleep(2_000).then(() => false)]);
  }

  /** Where the CLI persists transcripts for this host's cwd. */
  private _projectDirectory(): string | undefined {
    try {
      const configDir = this._config.env?.CLAUDE_CONFIG_DIR ?? process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
      return join(configDir, "projects", realpathSync(this._config.cwd).replace(/[^a-zA-Z0-9]/g, "-"));
    } catch { return undefined; }
  }

  private _deleteTranscript(sessionId: string | undefined): void {
    if (this._config.sweepTranscripts === false || !sessionId || !/^[a-zA-Z0-9-]+$/.test(sessionId)) return;
    const directory = this._projectDirectory();
    if (directory) try { unlinkSync(join(directory, `${sessionId}.jsonl`)); } catch { /* already gone */ }
  }

  private _sweepTranscripts(): void {
    if (this._swept || this._config.sweepTranscripts === false) return;
    this._swept = true;
    const directory = this._projectDirectory();
    if (!directory) return;
    let names: string[] = [];
    try { names = readdirSync(directory); } catch { return; }
    for (const name of names) if (/^[a-zA-Z0-9-]+\.jsonl$/.test(name)) try { unlinkSync(join(directory, name)); } catch { /* best effort */ }
  }

  private _branch(session: Primed): Owned {
    return session.base ? this._owned({}, session.base) : this._owned({ persistSession: false, instructions: session.instructions });
  }

  private async _prime(spec: PrimeSpec, hash: string, deadline: number): Promise<Primed> {
    const t0 = performance.now();
    if (!spec.context) {
      const primed: Primed = { key: spec.key, hash, instructions: spec.instructions, lastUsed: Date.now(), busy: false };
      this._sessions.set(spec.key, primed);
      this._emit({ type: "primed", key: spec.key, hash, ms: 0 });
      return primed;
    }
    const base = this._owned({ instructions: spec.instructions, persistSession: true });
    let result: SessionResult | undefined;
    try {
      await base.session.start();
      result = await base.session.send(`${spec.context}${PRIMER_SUFFIX}`, { timeout: Math.max(1, deadline - Date.now()) });
    } catch (error) {
      const settled = await this._dispose(base);
      this._deleteTranscript(base.session.externalSessionId);
      throw new DecisionError(`Priming ${spec.key} failed: ${(error as Error).message}`, error instanceof SessionTurnError && error.attempt.localFailure === "timeout" ? "timeout" : "prime-failed",
        "not-dispatched", settled, undefined, { cause: error });
    }
    const settled = await this._dispose(base);
    if (result.nativeOutcome !== "completed" || !base.session.externalSessionId || result.events.some(e => e.kind === "tool_use")) {
      this._deleteTranscript(base.session.externalSessionId);
      throw new DecisionError(`Priming ${spec.key} did not complete`, "prime-failed", "not-dispatched", settled);
    }
    const primed: Primed = { key: spec.key, hash, instructions: spec.instructions, base: base.session, model: observedModel(result),
      lastUsed: Date.now(), busy: false };
    this._sessions.set(spec.key, primed);
    this._emit({ type: "primed", key: spec.key, hash, ms: Math.round(performance.now() - t0) });
    return primed;
  }

  private async _drop(session: Primed, reason: "idle" | "capacity" | "reprime" | "requested" | "close"): Promise<void> {
    if (this._sessions.get(session.key) === session) this._sessions.delete(session.key);
    await session.cleanup;
    const spare = session.spare; session.spare = undefined;
    await this._dispose(spare);
    this._deleteTranscript(session.base?.externalSessionId);
    this._emit({ type: "evicted", key: session.key, reason });
  }

  private async _evictIdle(): Promise<void> {
    const cutoff = Date.now() - this._config.idleMs;
    for (const session of [...this._sessions.values()]) if (!session.busy && session.lastUsed < cutoff) await this._drop(session, "idle");
  }

  private async _decide(spec: PrimeSpec, request: DecisionRequest, started: number, deadline: number): Promise<DecisionResult> {
    const waitMs = Date.now() - started;
    const closed = () => new DecisionError("Primed sessions closed", "closed", "not-dispatched", true);
    if (this._closed) throw closed();
    if (Date.now() >= deadline) throw new DecisionError("Decision deadline passed before dispatch", "timeout", "not-dispatched", true);
    await this._checkLimits();
    this._sweepTranscripts();
    const hash = primeHash(spec);
    let session = this._sessions.get(spec.key), prime: "warm" | "cold" = "warm", primeMs = 0;
    if (session && session.hash !== hash) { await this._drop(session, "reprime"); session = undefined; }
    if (!session) {
      while (this._sessions.size >= this._config.maxSessions) {
        const idle = [...this._sessions.values()].filter(s => !s.busy).sort((a, b) => a.lastUsed - b.lastUsed)[0];
        if (!idle) break;
        await this._drop(idle, "capacity");
      }
      if (this._closed) throw closed();
      const t = performance.now();
      session = await this._prime(spec, hash, deadline);
      primeMs = Math.round(performance.now() - t); prime = "cold";
    }
    await session.cleanup;
    if (this._closed) throw closed();
    session.busy = true; session.lastUsed = Date.now();
    const t1 = performance.now();
    let branch = session.spare;
    session.spare = undefined;
    let admissionId: string | undefined;
    try {
      if (!branch || !branch.session.alive) {
        await this._dispose(branch);
        branch = this._branch(session);
        try { await branch.session.start(); }
        catch (error) { throw new DecisionError(`Branching ${spec.key} failed: ${(error as Error).message}`, "transport", "not-dispatched", true, undefined, { cause: error }); }
      }
      const branchMs = Math.round(performance.now() - t1);
      const t2 = performance.now();
      let result: SessionResult;
      try {
        let refusal: "timeout" | "closed" | "admission" | undefined;
        result = await branch.session.send(request.input, { timeout: Math.max(1, deadline - Date.now()), onAdmission: async attempt => {
          admissionId = attempt.admissionId;
          const expired = () => { refusal = this._closed ? "closed" : "timeout"; return Error("Decision deadline passed or host closed before dispatch"); };
          if (Date.now() >= deadline || this._closed) throw expired();
          refusal = "admission";
          await request.onAdmission?.({ admissionId: attempt.admissionId!, key: spec.key, runtime: "claude" });
          refusal = undefined;
          if (Date.now() >= deadline || this._closed) throw expired();
        } }).catch(error => {
          const attempt = error instanceof SessionTurnError ? error.attempt : undefined;
          if (attempt?.dispatch === "not-dispatched" && attempt.localFailure === "registration" && refusal)
            throw new DecisionError(refusal === "admission" ? "Decision admission refused before dispatch" : "Decision deadline passed or host closed before dispatch",
              refusal, "not-dispatched", true, admissionId, { cause: error });
          throw error;
        });
      } catch (error) {
        if (error instanceof DecisionError) throw error;
        const attempt = error instanceof SessionTurnError ? error.attempt : undefined;
        if (!attempt || attempt.dispatch === "not-dispatched")
          throw new DecisionError(`Decision not dispatched: ${(error as Error).message}`, "transport", "not-dispatched", true, admissionId, { cause: error });
        let settled = attempt.nativeOutcome !== "unknown";
        if (!settled && branch.session.interruptNative) settled = await branch.session.interruptNative({ timeoutMs: 2_000 }) === "acknowledged";
        const exited = await this._dispose(branch);
        throw new DecisionError(`Claude decision ${attempt.localFailure ?? "failed"}: ${(error as Error).message}`,
          attempt.localFailure === "timeout" ? "timeout" : "transport", "attempted", settled || exited, admissionId, { cause: error });
      }
      const turnMs = Math.round(performance.now() - t2);
      if (result.events.some(e => e.kind === "tool_use" || e.kind === "tool_result")) {
        this._emit({ type: "violation", key: spec.key, detail: "tool activity" });
        throw new DecisionError("Decision violated the text-only policy (tool activity)", "violation", "attempted", true, admissionId);
      }
      if (result.nativeOutcome !== "completed") {
        const limited = result.terminal?.apiErrorStatus === 429 || /rate.?limit|usage.?limit/i.test(result.terminal?.reason ?? result.content);
        throw new DecisionError(`Claude decision failed (${result.terminal?.subtype ?? "unknown"})`, limited ? "rate-limited" : "native-failed", "attempted", true, admissionId);
      }
      session.model ??= observedModel(result);
      const cacheRead = result.tokens?.cacheRead;
      this._emit({ type: "decision", key: spec.key, prime, ms: Date.now() - started, ...(cacheRead !== undefined ? { cacheRead } : {}) });
      return { key: spec.key, admissionId: result.admissionId ?? admissionId!, content: result.content, ...(result.tokens ? { tokens: result.tokens } : {}),
        ...(session.model ? { model: session.model } : {}), ...(result.externalSessionId ? { threadId: result.externalSessionId } : {}),
        prime, timing: { waitMs, primeMs, branchMs, turnMs } };
    } finally {
      session.busy = false; session.lastUsed = Date.now();
      // The decision settled on its native terminal; process exit and the next spare are off the caller's path.
      const done = branch;
      session.cleanup = (async () => {
        await this._dispose(done);
        if (this._config.spare && !this._closed && this._sessions.get(spec.key) === session) {
          const spare = this._branch(session);
          session.spare = spare;
          await spare.session.start().catch(() => { if (session.spare === spare) session.spare = undefined; });
        }
      })();
    }
  }
}

function observedModel(result: SessionResult): string | undefined {
  for (const event of result.events) {
    const raw = event.raw as Record<string, unknown> | undefined;
    const message = raw?.message as Record<string, unknown> | undefined;
    if (typeof message?.model === "string") return message.model;
  }
  return undefined;
}
