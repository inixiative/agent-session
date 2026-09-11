import { ClaudeCodeSession, CodexMcpSession, type CodexSpawn, type SessionAttempt, type SessionResult } from "../../src";
import { FrameRecorder, Sanitizer } from "./sanitize";
import { CaptureState } from "./observation";
import { lifecycleEvent } from "./lifecycle";
import { CONTINUATION_TASKS, PINNED_BUN_VERSION, REQUESTED, type ActivePath } from "./continuation-plan";

type Boundary = "stdin" | "stdout" | "event";
type Stop = "not-run" | "running" | "complete" | "start-failed" | "start-deadline" | "send-rejected" | "native-deadline" | "evidence-incomplete" | "checkpoint-failed";
/** How the bounded wait for the current admission's native outcome ended. */
type NativeWait = "known" | "deadline" | "process-exited" | "no-admission";
type Turn = { index: number; admittedAt: string; deadlineAt: number; finishedAt?: string; localSend: "pending" | "resolved" | "rejected";
  /** Immutable local settlement as returned by send(); later native evidence never rewrites it. */
  result?: SessionResult; admissionId?: string; nativeWait?: NativeWait; verified?: boolean; firstFrame: number; endFrameExclusive?: number };
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/** Observes the existing production classes. No transport, parser, replay or resume implementation. */
export class ContinuationCapture {
  readonly session: ClaudeCodeSession | CodexMcpSession;
  private readonly sanitizer = new Sanitizer("continuation");
  private readonly input = new FrameRecorder(this.sanitizer);
  private readonly output = new FrameRecorder(this.sanitizer);
  private readonly admission = new CaptureState();
  private readonly normalized: unknown[] = [];
  private readonly lifecycle: Record<string, unknown>[] = [];
  private readonly turns: Turn[] = [];
  private readonly wake = new Set<() => void>();
  private started = false;
  private spawns = 0;
  private processOwned = false;
  private exited = false;
  private exitCode: number | null = null;
  private stop: Stop = "not-run";
  /** Permanent: once admission is closed nothing in this capture may admit another send. */
  private closed?: { reason: NativeWait; at: string };
  private binding?: string;
  private stderrBytes = 0;
  private readonly now = () => new Date().toISOString();
  constructor(readonly path: ActivePath, private readonly options: {
    spawn: CodexSpawn; cwd: string; startDeadlineMs?: number; sendDeadlineMs?: number; settleMs?: number;
    observationFault?: (boundary: Boundary) => void;
    checkpoint?: (safe: ReturnType<ContinuationCapture["snapshot"]>) => void | Promise<void>;
  }) {
    const observe = (boundary: Boundary, fn: () => void) => this.admission.observe(() => { options.observationFault?.(boundary); fn(); });
    const spawn: CodexSpawn = (cmd, opts) => {
      if (++this.spawns !== 1) throw Error("A continuation capture cannot spawn a second process");
      const proc = options.spawn(cmd, opts);
      this.processOwned = true;
      this.lifecycle.push(lifecycleEvent("spawned", { command: cmd, pid: (proc as { pid?: number }).pid }, this.sanitizer));
      void proc.exited.then(code => {
        this.exited = true; this.exitCode = code;
        this.lifecycle.push(lifecycleEvent("process-exited", { code }, this.sanitizer)); this.notify();
      });
      return { stdin: {
        write: data => this.admission.write(data, value => {
          options.observationFault?.("stdin");
          const before = this.input.frames.length;
          this.input.chunk(new TextEncoder().encode(value));
          const added = this.input.frames.slice(before);
          return added.length > 0 && added.every(frame => ["initialize", "initialized", "notifications/initialized", "tools/list"].includes((frame.value as any)?.method));
        }, value => proc.stdin.write(value)),
        flush: () => proc.stdin.flush(), end: () => proc.stdin.end(),
      }, stdout: proc.stdout.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
        transform: (bytes, controller) => { observe("stdout", () => this.output.chunk(bytes)); controller.enqueue(bytes); },
        flush: () => observe("stdout", () => this.output.end()),
      })), stderr: proc.stderr.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
        transform: (bytes, controller) => { this.stderrBytes += bytes.byteLength; controller.enqueue(bytes); },
      })), exited: proc.exited, kill: () => {
        this.lifecycle.push(lifecycleEvent("owned-process-kill-requested", {}, this.sanitizer)); proc.kill();
      } };
    };
    const config = { ...REQUESTED[path], cwd: options.cwd, timeout: options.sendDeadlineMs ?? 180_000, spawn };
    this.session = path === "claude" ? new ClaudeCodeSession({ ...config, maxTurns: 8 }) : new CodexMcpSession(config);
    this.session.onEvent(event => { observe("event", () => this.normalized.push(this.sanitizer.clean(event))); queueMicrotask(() => this.notify()); });
  }
  private notify() { for (const wake of this.wake) wake(); this.wake.clear(); }
  private turnWrites() { return this.input.frames.filter(frame => this.path === "claude"
    ? (frame.value as any)?.type === "user" : (frame.value as any)?.method === "tools/call"); }
  private owned(): SessionAttempt | undefined {
    const id = this.turns.at(-1)?.admissionId;
    return id ? this.session.attempts.find(a => a.admissionId === id && a.dispatch === "attempted") : undefined;
  }
  private terminalKnown() { const a = this.owned(); return !!a?.terminal && a.nativeOutcome !== "unknown"; }
  cleanupAllowed() { return this.admission.cleanupAllowed(this.terminalKnown(), this.exited); }

  private verify(turn: Turn): boolean {
    const a = this.session.attempts.find(a => a.admissionId === turn.admissionId);
    if (!a || a.nativeOutcome !== "completed" || a.localOutcome !== "resolved" || a.transportOutcome !== "open"
      || !this.session.alive || this.exited || this.spawns !== 1 || this.admission.observerErrors.length
      || this.session.diagnostics.observerFailures.synchronous || this.session.diagnostics.observerFailures.asynchronous
      || this.turnWrites().length !== turn.index + 1) return false;
    const binding = this.path === "claude" ? a.nativeSessionId : a.threadId;
    if (!binding || this.session.externalSessionId !== binding || (this.binding && this.binding !== binding)) return false;
    const observed = this.output.frames.slice(turn.firstFrame);
    if (observed.some(frame => (frame.value as any)?.malformedJson)) return false;
    const frames = observed.map(frame => frame.value as any);
    const terminal = this.path === "claude"
      ? frames.find(v => v.type === "result" && a.terminal?.eventId && v.uuid === this.sanitizer.ref(a.terminal.eventId)
        && v.session_id === this.sanitizer.ref(binding) && v.subtype === "success")
      : frames.find(v => v.params?.msg?.type === "task_complete" && a.turnId && v.params.msg.turn_id === this.sanitizer.ref(a.turnId));
    if (!terminal) return false;
    if (this.path === "codex-mcp" && (!frames.some(v => v.params?.msg?.type === "task_started" && v.params.msg.turn_id === this.sanitizer.ref(a.turnId))
      || !frames.some(v => v.id === a.rpcRequestId && v.result && !v.error && v.result.isError !== true))) return false;
    // Join actual tool begin/results by native call ID, not by adjacency or final response text.
    const begins = a.events.filter(e => e.kind === "tool_use" && e.callId);
    const commands = new Set(["bun --version", `cat ${CONTINUATION_TASKS[turn.index].file}`,
      `bun --version && cat ${CONTINUATION_TASKS[turn.index].file}`]);
    const allowedCommand = (value: unknown): boolean => typeof value === "string" ? commands.has(value)
      : Array.isArray(value) && value.length === 3 && ["/bin/zsh", "/bin/bash", "zsh", "bash"].includes(value[0])
        && ["-lc", "-c"].includes(value[1]) && typeof value[2] === "string" && commands.has(value[2]);
    // Compare original in-memory arguments before redaction. Literal extraction alone
    // cannot establish that a command did only the authorized controlled task.
    if (begins.some(begin => !["Bash", "shell"].includes(begin.toolName ?? "")
      || !allowedCommand((begin.raw as any)?.input?.command ?? (begin.raw as any)?.command))) return false;
    const outputs = a.events.filter(e => e.kind === "tool_result" && !e.toolError && e.callId && begins.some(b => b.callId === e.callId));
    const text = outputs.map(e => e.toolOutput ?? "").join("\n");
    if (!begins.length || begins.some(begin => !outputs.some(output => output.callId === begin.callId))
      || a.events.some(event => event.kind === "tool_result" && event.toolError)
      || !text.includes(CONTINUATION_TASKS[turn.index].content.trim()) || !text.includes(PINNED_BUN_VERSION)) return false;
    if (!a.content.includes(CONTINUATION_TASKS[turn.index].marker)) return false;
    this.binding = binding;
    return true;
  }
  private async checkpoint() {
    try { await this.options.checkpoint?.(this.snapshot()); return true; }
    catch { this.stop = "checkpoint-failed"; return false; }
  }
  async run() {
    if (this.started) throw Error("A capture can run only once; never replay ambiguous work");
    this.started = true;
    this.stop = "running";
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const start = this.session.start().then(() => "started" as const, () => "failed" as const);
      const status = await Promise.race([start, new Promise<"deadline">((resolve) => {
        timer = setTimeout(() => resolve("deadline"), this.options.startDeadlineMs ?? 15_000);
      })]);
      clearTimeout(timer);
      if (status !== "started") { this.stop = status === "failed" ? "start-failed" : "start-deadline"; return this.snapshot(); }
      if (!this.session.alive || this.admission.observerErrors.length) { this.stop = "evidence-incomplete"; return this.snapshot(); }
      for (let index = 0; index < 2; index++) {
        if (index) {
          if (!this.verify(this.turns[0])) { this.stop = "evidence-incomplete"; return this.snapshot(); }
          if (!await this.checkpoint()) return this.snapshot();
          if (!this.verify(this.turns[0])) { this.stop = "evidence-incomplete"; return this.snapshot(); }
        }
        // One monotonic deadline per admission covers local settlement, the native outcome
        // and trailing frames. No phase gets a fresh full timeout.
        const turn: Turn = { index, admittedAt: this.now(), deadlineAt: performance.now() + (this.options.sendDeadlineMs ?? 180_000),
          localSend: "pending", firstFrame: this.output.frames.length }; this.turns.push(turn);
        this.admission.admitSend();
        this.lifecycle.push(lifecycleEvent("send-admitted", {}, this.sanitizer));
        const beforeCount = this.session.attempts.length;
        try {
          const pending = this.session.send(CONTINUATION_TASKS[index].prompt);
          turn.result = await pending; turn.localSend = "resolved";
        } catch { turn.localSend = "rejected"; this.stop = "send-rejected"; }
        // An early hook/rejection may create no admission. Never borrow the previous turn's ID.
        const admitted = this.session.attempts.slice(beforeCount);
        if (admitted.length === 1) turn.admissionId = admitted[0].admissionId;
        // Local settlement is not the native outcome. Wait, bounded by the same admission
        // deadline, for THIS admission's terminal (or owned process exit), then allow trailing
        // frames to land before verifying. A deadline is not cancellation: ownership is retained.
        turn.nativeWait = await this.awaitOwnedOutcome(turn);
        // Latch synchronously, before any further await: a deadline, process exit or missing
        // admission observed here closes admission for the rest of this capture. Native
        // completion that lands afterwards may enrich evidence and permit owned cleanup, but
        // it can never reopen admission or turn this run into success.
        if (turn.nativeWait !== "known") {
          this.closed = { reason: turn.nativeWait, at: this.now() };
          if (this.stop === "running") this.stop = turn.nativeWait === "deadline" ? "native-deadline" : "evidence-incomplete";
          this.lifecycle.push(lifecycleEvent("admission-closed", { reason: turn.nativeWait }, this.sanitizer));
        }
        turn.finishedAt = this.now();
        await pause(Math.max(0, Math.min(this.options.settleMs ?? 50, turn.deadlineAt - performance.now())));
        turn.endFrameExclusive = this.output.frames.length;
        // For a closed admission this is evidence about what arrived late, never a gate.
        turn.verified = this.verify(turn);
        this.lifecycle.push(lifecycleEvent("admission-settled", { nativeWait: turn.nativeWait, verified: turn.verified }, this.sanitizer));
        if (!await this.checkpoint()) return this.snapshot();
        if (this.closed || turn.localSend !== "resolved" || !turn.verified) {
          if (this.stop === "running") this.stop = "evidence-incomplete";
          return this.snapshot();
        }
      }
      this.stop = "complete";
      return this.snapshot();
    } finally { clearTimeout(timer); }
  }
  /**
   * Bounded wait for the current admission's own native outcome. Ends when that
   * admission's terminal is known, the owned process exits, or the admission's single
   * deadline passes. Foreign or duplicate terminals do not count: the engine never
   * attributes them to this admission, so `terminalKnown()` stays false.
   */
  private async awaitOwnedOutcome(turn: Turn): Promise<NativeWait> {
    if (!turn.admissionId) return "no-admission";
    for (;;) {
      // The deadline is checked first: a terminal that becomes visible at or after
      // expiration, before this check runs, still counts as a deadline, never as success.
      const remaining = turn.deadlineAt - performance.now();
      if (remaining <= 0) return "deadline";
      if (this.terminalKnown()) return "known";
      if (this.exited) return "process-exited";
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        new Promise<void>(resolve => this.wake.add(resolve)),
        new Promise<void>(resolve => { timer = setTimeout(resolve, remaining); }),
      ]);
      clearTimeout(timer);
    }
  }
  /** Waiting for the current owned outcome never resumes run() or admits a second send. */
  async waitForCleanup() {
    while (!this.cleanupAllowed()) await new Promise<void>(resolve => this.wake.add(resolve));
  }
  async closeOwned() {
    if (!this.cleanupAllowed()) return false;
    this.lifecycle.push(lifecycleEvent("cleanup-outcome-established", {
      nativeTerminal: this.terminalKnown() ? (this.owned()?.nativeOutcome === "completed" ? "completed" : "failed") : null,
      exited: this.exited, noTurn: this.admission.noTurn(),
    }, this.sanitizer));
    this.session.kill();
    while (this.processOwned && !this.exited) await new Promise<void>(resolve => this.wake.add(resolve));
    await pause(0);
    return true;
  }
  snapshot() {
    // This copy occurs only at checkpoints/readout, never for each native event.
    return structuredClone({ stop: this.stop, sendCalls: this.turns.length,
      admittedSends: this.turns.filter(turn => turn.admissionId).length, observedTurnWrites: this.turnWrites().length, spawnCount: this.spawns,
      nativeOutcome: this.owned()?.nativeOutcome ?? "unknown", admissionClosed: this.closed ?? null,
      processExited: this.exited, processExitCode: this.exitCode,
      cleanupAllowed: this.cleanupAllowed(), accountIdentity: "unknown", capacity: "unknown", subscriptionContinuity: "unknown",
      turns: this.turns.map(turn => ({ index: turn.index, admittedAt: turn.admittedAt, finishedAt: turn.finishedAt,
        firstFrame: turn.firstFrame, endFrameExclusive: turn.endFrameExclusive, nativeWait: turn.nativeWait,
        // `result` is the immutable local settlement; `attempt` below is the current native evidence.
        localSend: turn.localSend, verified: turn.verified, result: this.sanitizer.clean(turn.result),
        // Events live once in normalized; this explicit join avoids duplicating the transcript per result.
        eventIndices: turn.admissionId ? this.normalized.flatMap((event, index) => (event as { admissionId?: unknown }).admissionId === this.sanitizer.ref(turn.admissionId) ? [index] : []) : [],
        attempt: this.sanitizer.clean(this.session.attempts.find(a => a.admissionId === turn.admissionId)) })),
      admission: this.admission.snapshot(), observerErrors: [...this.admission.observerErrors],
      diagnostics: this.session.diagnostics, lifecycle: this.lifecycle, stderrBytes: this.stderrBytes,
      observedConfiguration: this.output.frames.flatMap(frame => {
        const wire = frame.value as any, value = wire?.params?.msg ?? wire;
        return (value?.type === "system" && value.subtype === "init") || value?.type === "session_configured"
          ? [{ frame: frame.index, model: value.model ?? null, effort: value.effort ?? value.reasoning_effort ?? null }] : [];
      }),
      stdin: { chunks: this.input.chunks, frames: this.input.frames }, stdout: { chunks: this.output.chunks, frames: this.output.frames },
      normalized: this.normalized });
  }
}
