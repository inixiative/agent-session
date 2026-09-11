import { basename } from "node:path";
import { Sanitizer } from "./sanitize";
const redacted = "[redacted]";
const toggles = new Set(["--print", "--verbose", "--include-hook-events", "--fork-session", "--version"]);
const values: Record<string, readonly string[]> = {
  "--input-format": ["stream-json"], "--output-format": ["stream-json"],
  "--model": ["gpt-6-astra", "gpt-5.5", "claude-fable-5-1", "sonnet", "haiku"],
  "--effort": ["minimal", "low", "medium", "high", "xhigh", "max"],
  "--permission-mode": ["bypassPermissions"],
  "--listen": ["stdio://", "ws://127.0.0.1:0"],
};
const configs = new Set(['sandbox_mode="danger-full-access"', 'approval_policy="never"',
  ...["minimal", "low", "medium", "high", "xhigh"].map(v => `model_reasoning_effort="${v}"`)]);
/** Capture policy only, never modifies the executable's actual argv. */
export function sanitizeArgv(cmd: readonly string[], sanitizer: Sanitizer) {
  const executable = basename(cmd[0] ?? "");
  if (!["claude", "codex", "bun"].includes(executable)) return { executable: redacted, args: [] as string[] };
  const args: string[] = [];
  for (let i = 1; i < cmd.length; i++) {
    const token = cmd[i];
    if (executable === "codex" && i === 1 && ["mcp-server", "app-server"].includes(token)) { args.push(token); continue; }
    if (toggles.has(token)) { args.push(token); continue; }
    const eq = token.indexOf("=");
    const flag = eq < 0 ? token : token.slice(0, eq);
    const known = flag in values || ["--resume", "--append-system-prompt", "--max-turns", "-c", "--config"].includes(flag);
    if (!known) { args.push(redacted); continue; }
    const value = eq >= 0 ? token.slice(eq + 1) : cmd[i + 1]?.startsWith("-") ? undefined : cmd[++i];
    let safe = redacted;
    if (value !== undefined) {
      if (flag === "--resume") safe = String(sanitizer.ref(value));
      else if (flag === "--max-turns" && /^(?:[1-9]|[1-9][0-9]|100)$/.test(value)) safe = value;
      else if (["-c", "--config"].includes(flag) && configs.has(value)) safe = value;
      else if (values[flag]?.includes(value)) safe = value;
    }
    args.push(flag, safe);
  }
  return { executable, args };
}
const kinds = new Set(["spawned", "process-exited", "stdin-end-requested", "owned-process-kill-requested",
  "handshake-deadline", "handshake-returned", "send-admitted", "send-returned", "send-rejected", "start-rejected", "cleanup-outcome-established",
  "admission-settled", "admission-closed"]);
const nativeWaits = new Set(["known", "deadline", "process-exited", "no-admission"]);
/** No caller strings, arbitrary objects, environment or usable handles reach disk. */
export function lifecycleEvent(kind: string, more: Record<string, unknown>, sanitizer: Sanitizer): Record<string, unknown> {
  const out: Record<string, unknown> = { kind: kinds.has(kind) ? kind : "unknown", at: new Date().toISOString() };
  // Typed facts only: how the bounded owned-outcome wait ended, and whether verification passed.
  if (kind === "admission-settled") {
    out.nativeWait = nativeWaits.has(String(more.nativeWait)) ? more.nativeWait : "unknown";
    if (typeof more.verified === "boolean") out.verified = more.verified;
  }
  if (kind === "admission-closed") out.reason = nativeWaits.has(String(more.reason)) ? more.reason : "unknown";
  if (kind === "spawned") {
    if (Number.isSafeInteger(more.pid)) out.pid = sanitizer.ref(more.pid);
    if (Array.isArray(more.command) && more.command.every(v => typeof v === "string")) Object.assign(out, sanitizeArgv(more.command, sanitizer));
  }
  if (kind === "process-exited" && Number.isSafeInteger(more.code)) out.code = more.code;
  if (kind === "handshake-deadline" && typeof more.sendCalled === "boolean") out.sendCalled = more.sendCalled;
  if (kind === "cleanup-outcome-established") {
    for (const key of ["exited", "noTurn"]) if (typeof more[key] === "boolean") out[key] = more[key];
    out.nativeTerminal = more.nativeTerminal === null ? null : ["success", "failure", "task_complete", "completed", "failed", "interrupted"].includes(String(more.nativeTerminal)) ? more.nativeTerminal : "unknown";
  }
  return out;
}
/** CLI versions are typed provenance, not unrestricted diagnostic output. */
export function sanitizeVersion(executable: string, output: string): string {
  const pattern = executable === "bun" ? /^\d{1,4}\.\d{1,4}\.\d{1,4}$/
    : executable === "claude" ? /^\d{1,4}\.\d{1,4}\.\d{1,4} \(Claude Code\)$/
    : executable === "codex" ? /^codex-cli \d{1,4}\.\d{1,4}\.\d{1,4}$/ : undefined;
  return pattern?.test(output) ? output : "unavailable";
}
