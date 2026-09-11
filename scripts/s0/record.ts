import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { ClaudeCodeSession, CodexMcpSession, CodexAppServerSession, type HarnessSession, type CodexSpawn } from "../../src";
import { FrameRecorder, Sanitizer, PROMPT } from "./sanitize";
import { lifecycleEvent, sanitizeArgv, sanitizeVersion } from "./lifecycle";
import { CaptureState } from "./observation";

const path = process.argv[2];
if (!["claude", "codex-mcp", "codex-app-server"].includes(path)) throw Error("Choose one path: claude | codex-mcp | codex-app-server");
const runId = process.argv[3];
if (!runId || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,80}$/.test(runId)) throw Error("An explicit, new recording run ID is required");
const root = resolve(import.meta.dir, "../..");
const dir = join(root, "fixtures/s0", runId, path);
mkdirSync(join(root, "fixtures/s0", runId), { recursive: true });
// Exclusive attempt directory: never replay an existing or unknown-running recording.
mkdirSync(dir);
const startedAt = new Date().toISOString();
const sha = (s: string | Uint8Array) => createHash("sha256").update(s).digest("hex");
const sample = mkdtempSync(join(tmpdir(), `agent-session-s0-${path}-`));
writeFileSync(join(sample, "sentinel.txt"), "S0_SENTINEL_OK\n");
const s = new Sanitizer();
const stdout = new FrameRecorder(s), stdin = new FrameRecorder(s);
const normalized: unknown[] = [];
const lifecycle: Array<Record<string, unknown>> = [];
const stderrFacts = { bytes: 0, websocketListenerAnnounced: false, loopbackPort: null as number | null, lines: 0 };
const captureState = new CaptureState();
const observerErrors = captureState.observerErrors;
let child: Bun.Subprocess<"pipe", "pipe", "pipe"> | undefined;
let exited = false;
let exitCode: number | null = null;
let stderrBuffer = "";
const event = (kind: string, more: Record<string, unknown> = {}) => lifecycle.push(lifecycleEvent(kind, more, s));
function observed(fn: () => void) { captureState.observe(fn); }
function version(cmd: string[]) {
  const proc = Bun.spawnSync(cmd, { cwd: sample, stdout: "pipe", stderr: "pipe" });
  const output = new TextDecoder().decode(proc.stdout).trim();
  return { command: sanitizeArgv(cmd, s), exitCode: proc.exitCode, value: sanitizeVersion(cmd[0], output) };
}
const versions = { bun: version(["bun", "--version"]), cli: version([path === "claude" ? "claude" : "codex", "--version"]) };
const revision = new TextDecoder().decode(Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: root }).stdout).trim();
const sourceHashes = Object.fromEntries(["src/claude-code-session.ts", "src/codex-session.ts", "src/harness-session.ts", "src/turn-state.ts", "src/retained-evidence.ts", "scripts/s0/sanitize.ts", "scripts/s0/observation.ts", "scripts/s0/lifecycle.ts", "scripts/s0/record.ts"]
  .map(p => [p, sha(readFileSync(join(root, p)))]));
const requested = path === "claude" ? { model: "claude-fable-5-1", effort: "max" } : { model: "gpt-6-astra", effort: "xhigh" };
const report: Record<string, unknown> = { format: 3, runId, path, startedAt, sourceRevision: revision, sourceHashes,
  capturePolicy: { lifecycle: "executable/flag/value allowlists; native handles and PID pseudonymized; historical recordings unchanged", framing: "exact starting/ending observed chunk; original bytes not persisted",
    identities: "explicit ID fields pseudonymized even on unknown/analysis items; absence of an allowed field is wire absence, not type-based sanitizer omission",
    payload: "typed numeric fields only; analysis/reasoning bodies omitted independently of type/kind" },
  package: { name: "@inixiative/agent-session", version: "0.1.0", source: "sibling checkout; not installed in Foundry" },
  versions, requested, accountIdentity: "unknown", capacity: "unknown", prompt: PROMPT,
  sample: { alias: "<controlled-sample>", sentinel: "S0_SENTINEL_OK\n", beforeHash: sha(readFileSync(join(sample, "sentinel.txt"))) },
  lifecycle, observerErrors, nativeOutcome: "unknown", localSend: "not-called", capture: "in-progress" };
function save() {
  // Only allowlisted objects reach disk. No original chunks or environment are serialized.
  const data = JSON.stringify({ ...report, stdout: { chunks: stdout.chunks, frames: stdout.frames },
    stdin: { chunks: stdin.chunks, frames: stdin.frames }, normalized, stderrFacts, admission: captureState.snapshot() }, null, 2);
  writeFileSync(join(dir, "recording.tmp"), data);
  renameSync(join(dir, "recording.tmp"), join(dir, "recording.json"));
}
save();
const spawn: CodexSpawn = (cmd, opts) => {
  child = Bun.spawn(cmd, { ...opts, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  event("spawned", { pid: child.pid, command: cmd });
  const proc = child;
  const out = proc.stdout.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(bytes, controller) { observed(() => stdout.chunk(bytes)); controller.enqueue(bytes); },
    flush() { observed(() => stdout.end()); },
  }));
  const err = proc.stderr.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(bytes, controller) {
      stderrFacts.bytes += bytes.byteLength;
      stderrBuffer += new TextDecoder().decode(bytes);
      stderrFacts.lines += (new TextDecoder().decode(bytes).match(/\n/g) ?? []).length;
      // Static listener diagnostics only; never persist raw stderr or auth information.
      const address = stderrBuffer.match(/ws:\/\/127\.0\.0\.1:(\d+)/);
      if (address) { stderrFacts.websocketListenerAnnounced = true; stderrFacts.loopbackPort = Number(address[1]); }
      if (stderrBuffer.length > 8192) stderrBuffer = stderrBuffer.slice(-4096);
      controller.enqueue(bytes);
    },
  }));
  proc.exited.then(code => { exited = true; exitCode = code; event("process-exited", { code }); });
  return { stdin: {
    write(data) { captureState.write(data, value => {
      const before = stdin.frames.length;
      stdin.chunk(new TextEncoder().encode(value));
      const added = stdin.frames.slice(before);
      const nonTurnMethods = ["initialize", "initialized", "notifications/initialized", "tools/list"];
      return added.length > 0 && added.every(frame => nonTurnMethods.includes((frame.value as { method?: string }).method ?? ""));
    }, value => { proc.stdin.write(value); }); },
    flush() { proc.stdin.flush(); }, end() { event("stdin-end-requested"); proc.stdin.end(); },
  }, stdout: out, stderr: err, exited: proc.exited, kill() { event("owned-process-kill-requested"); proc.kill(); } };
};
const session: HarnessSession = path === "claude"
  ? new ClaudeCodeSession({ ...requested, cwd: sample, maxTurns: 8, timeout: 180_000, spawn })
  : path === "codex-mcp" ? new CodexMcpSession({ ...requested, cwd: sample, timeout: 180_000, spawn })
  : new CodexAppServerSession({ ...requested, cwd: sample, timeout: 180_000, spawn });
session.onEvent(e => observed(() => normalized.push(s.clean(e))));
const pause = (ms: number) => new Promise(r => setTimeout(r, ms));
function terminal(): string | undefined {
  for (const frame of stdout.frames) {
    const v = frame.value as any;
    if (path === "claude" && v.type === "result") return v.subtype === "success" && v.is_error === false ? "success" : "failure";
    const msg = v.params?.msg;
    if (msg?.type === "task_complete") return "task_complete";
    if (v.method === "turn/completed") return v.params?.turn?.status ?? "terminal-status-missing";
  }
}
try {
  const start = session.start();
  let startDone = false;
  void start.then(() => { startDone = true; }, () => { startDone = true; });
  await Promise.race([start, pause(15_000)]);
  if (!startDone) {
    // No send() is admitted here. Missing observer data can still make it unknown.
    report.capture = "handshake-unresolved";
    report.nativeOutcome = captureState.noTurn() ? "not-started-no-turn-request" : "unknown";
    event("handshake-deadline", { sendCalled: false });
  } else {
    await start;
    event("handshake-returned"); report.localSend = "pending"; save();
    try {
      captureState.admitSend(); event("send-admitted");
      const result = await session.send(PROMPT);
      report.localSend = "resolved";
      report.result = s.clean({ content: result.content, tokens: result.tokens, externalSessionId: result.externalSessionId });
      event("send-returned");
    } catch { report.localSend = "rejected"; event("send-rejected"); }
    // A resolved send is not proof of native completion. Observe the wire itself.
    for (let i = 0; i < 120 && !terminal() && !exited; i++) {
      report.nativeOutcome = "unknown"; save(); await pause(1000);
    }
    report.nativeOutcome = terminal() ?? "unknown";
    report.capture = terminal() ? "terminal-recorded" : "terminal-missing";
  }
} catch {
  report.capture = "start-failed"; event("start-rejected");
} finally {
  const noTurn = captureState.noTurn();
  if (captureState.cleanupAllowed(!!terminal(), exited)) {
    // Native terminal / process exit / explicit no-turn evidence precedes cleanup.
    event("cleanup-outcome-established", { nativeTerminal: terminal() ?? null, exited, noTurn });
    session.kill();
    if (child) await Promise.race([child.exited, pause(5000)]);
  } else {
    report.capture = "owned-process-awaiting-terminal";
    save();
    console.log(JSON.stringify({ path, state: report.capture, ownedPid: child?.pid, recording: join(dir, "recording.json") }));
    // Stay attached to owned work; never replay or treat local timeout as cancellation.
    while (!terminal() && !exited) { await pause(2000); save(); }
    report.nativeOutcome = terminal() ?? "unknown-after-process-exit";
    session.kill(); if (child) await child.exited;
  }
  await pause(100); stdin.end();
  report.processExitCode = exitCode; report.processExited = exited;
  report.finishedAt = new Date().toISOString();
  report.artifact = s.clean(session.artifact());
  report.sample = { ...(report.sample as object), afterHash: sha(readFileSync(join(sample, "sentinel.txt"))),
    filesUnchanged: JSON.stringify(readdirSync(sample).sort()) === JSON.stringify(["sentinel.txt"]) };
  report.capture = report.capture === "owned-process-awaiting-terminal" ? "late-outcome-recorded" : report.capture;
  save();
  console.log(JSON.stringify({ path, nativeOutcome: report.nativeOutcome, localSend: report.localSend,
    frames: stdout.frames.length, events: normalized.length, processExited: exited, recording: join(dir, "recording.json") }));
}
