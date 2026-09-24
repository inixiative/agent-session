// ---------------------------------------------------------------------------
// Primed decision sessions — one live, warm session per middleware role
// ---------------------------------------------------------------------------
//
// Each key (Foundry: `${threadId}:aux:${role}`) owns one long-lived session,
// primed once with its stable context: role instructions plus owned content.
// That primed state is the cached prefix. Every decision runs on a fresh branch
// of the primed state and is then discarded, so one cycle never sees another's
// turns. A key is re-primed only when its prime hash changes, after eviction,
// or after its process is lost; those are the only cold paths.
//
// Decisions are text-only: the launch policy removes tool surfaces, and any
// tool, command or approval activity is a violation that fails the decision.
// ---------------------------------------------------------------------------

import { createHash } from "node:crypto";
import type { SessionTokens } from "./harness-session";
import type { LimitSnapshot } from "./limits";

export interface PrimeSpec {
  /** Session identity. One live primed session per key. */
  readonly key: string;
  /** Role instructions (developer/system role). */
  readonly instructions: string;
  /** Stable owned context (layer content), primed as data in the user role. May be empty. */
  readonly context?: string;
  /** Content hash of instructions and context. Re-primes when it changes. Default: sha256 of both. */
  readonly hash?: string;
}

export interface DecisionAdmission {
  readonly admissionId: string;
  readonly key: string;
  readonly runtime: "codex" | "claude";
  /** Native identity of the branch the decision will run on, when known before the write. */
  readonly threadId?: string;
}

export interface DecisionRequest {
  /** The per-cycle input, run on top of the primed state. */
  readonly input: string;
  readonly timeoutMs?: number;
  /** Required registration before the native write; a rejection means nothing was dispatched. */
  readonly onAdmission?: (admission: DecisionAdmission) => void | Promise<void>;
  /** JSON Schema constraining the final message (Codex only). */
  readonly outputSchema?: Readonly<Record<string, unknown>>;
  /** Cancel: refused before dispatch, or the running turn is interrupted and settled. */
  readonly signal?: AbortSignal;
}

export interface DecisionResult {
  readonly key: string;
  readonly admissionId: string;
  readonly content: string;
  readonly tokens?: SessionTokens;
  /** Model the runtime reported serving the session. */
  readonly model?: string;
  readonly threadId?: string;
  readonly turnId?: string;
  /** `cold`: this call (re)primed the key. */
  readonly prime: "warm" | "cold";
  readonly timing: { readonly waitMs: number; readonly primeMs: number; readonly branchMs: number; readonly turnMs: number };
}

export type DecisionFailure =
  | "closed" | "busy" | "admission" | "rate-limited" | "auth" | "timeout" | "aborted" | "violation" | "transport" | "native-failed" | "prime-failed";

/**
 * `dispatch: "not-dispatched"`: no model input was written for this decision.
 * `settled: false`: a native turn may still be running; its process is being recycled.
 */
export class DecisionError extends Error {
  constructor(
    message: string,
    readonly reason: DecisionFailure,
    readonly dispatch: "not-dispatched" | "attempted",
    readonly settled: boolean,
    readonly admissionId?: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "DecisionError";
  }
}

export type PrimedEvent =
  | { readonly type: "process-started"; readonly generation: number; readonly ms: number }
  | { readonly type: "process-recycled"; readonly generation: number; readonly reason: string }
  | { readonly type: "primed"; readonly key: string; readonly hash: string; readonly ms: number }
  | { readonly type: "evicted"; readonly key: string; readonly reason: "idle" | "capacity" | "reprime" | "requested" | "process-lost" | "close" }
  | { readonly type: "decision"; readonly key: string; readonly prime: "warm" | "cold"; readonly ms: number; readonly cacheRead?: number; readonly input?: number }
  | { readonly type: "limits"; readonly limits: LimitSnapshot }
  | { readonly type: "violation"; readonly key: string; readonly detail: string };

export interface PrimedSnapshot {
  readonly runtime: "codex" | "claude";
  readonly closed: boolean;
  readonly generation: number;
  readonly processAlive: boolean;
  readonly sessions: number;
  readonly active: number;
  readonly waiting: number;
  readonly limits?: LimitSnapshot;
}

export interface PrimedSessions {
  readonly runtime: "codex" | "claude";
  decide(spec: PrimeSpec, request: DecisionRequest): Promise<DecisionResult>;
  /** Drop a key's primed session; the next decision re-primes it. */
  evict(key: string): Promise<void>;
  limits(): LimitSnapshot | undefined;
  snapshot(): PrimedSnapshot;
  close(): Promise<void>;
}

export function primeHash(spec: PrimeSpec): string {
  return spec.hash ?? createHash("sha256").update(spec.instructions).update("\0").update(spec.context ?? "").digest("hex");
}

/** FIFO counting semaphore with deadline-bounded waits. */
export class Slots {
  private _active = 0;
  private _waiters: Array<{ grant(): void; fail(error: Error): void; timer: ReturnType<typeof setTimeout> }> = [];
  constructor(private readonly _limit: number) {
    if (!Number.isSafeInteger(_limit) || _limit < 1) throw Error("Concurrency limit must be a positive integer");
  }
  get active() { return this._active; }
  get waiting() { return this._waiters.length; }
  acquire(deadline: number, signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(new DecisionError("Decision aborted before dispatch", "aborted", "not-dispatched", true));
    const release = () => {
      let released = false;
      return () => {
        if (released) return; released = true;
        const next = this._waiters.shift();
        if (next) { clearTimeout(next.timer); next.grant(); } else this._active--;
      };
    };
    if (this._active < this._limit) { this._active++; return Promise.resolve(release()); }
    return new Promise((resolve, reject) => {
      const leave = (error: DecisionError) => {
        const index = this._waiters.indexOf(waiter);
        if (index >= 0) { this._waiters.splice(index, 1); clearTimeout(waiter.timer); reject(error); }
      };
      const onAbort = () => leave(new DecisionError("Decision aborted before dispatch", "aborted", "not-dispatched", true));
      const waiter = {
        grant: () => { signal?.removeEventListener("abort", onAbort); resolve(release()); },
        fail: (error: Error) => { signal?.removeEventListener("abort", onAbort); reject(error); },
        timer: setTimeout(() => leave(new DecisionError("Decision expired waiting for a session slot", "busy", "not-dispatched", true)), Math.max(0, deadline - Date.now())),
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this._waiters.push(waiter);
    });
  }
  /** Reject every waiter (close). Held slots are released by their owners. */
  drain(error: Error): void {
    for (const waiter of this._waiters.splice(0)) { clearTimeout(waiter.timer); waiter.fail(error); }
  }
}

/** Per-key serialization: a key's decisions run one at a time, in order. */
export class KeyedQueue {
  private _tails = new Map<string, Promise<void>>();
  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const prior = this._tails.get(key) ?? Promise.resolve();
    const result = prior.then(task, task);
    const tail = result.then(() => undefined, () => undefined);
    this._tails.set(key, tail);
    void tail.then(() => { if (this._tails.get(key) === tail) this._tails.delete(key); });
    return result;
  }
  get size() { return this._tails.size; }
}
