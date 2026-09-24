// One-shot account limit reads without a model turn: a short-lived native
// process asks the runtime for its usage, then exits. Account identity is not read.

import { ClaudeCodeSession, type ClaudeCodeSessionConfig } from "./claude-code-session";
import type { CodexSpawn, PipedSubprocess } from "./codex-session";
import { JsonRpcConnection } from "./json-rpc";
import { codexLimitSnapshot, type LimitSnapshot } from "./limits";

export interface LimitProbeOptions {
  bin?: string;
  /** Merged over process.env (CODEX_HOME / CLAUDE_CONFIG_DIR for a profile). */
  env?: Record<string, string | undefined>;
  cwd?: string;
  timeoutMs?: number;
}

/** `codex app-server` → account/rateLimits/read. */
export async function probeCodexLimits(options: LimitProbeOptions & { spawn?: CodexSpawn } = {}): Promise<LimitSnapshot | undefined> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const argv = [options.bin ?? "codex", "app-server", "--listen", "stdio://"];
  const env: Record<string, string | undefined> = { ...process.env, ...options.env, DISABLE_AUTOUPDATER: "1" };
  delete env.OPENAI_API_KEY; delete env.CODEX_API_KEY;
  for (const key of Object.keys(env)) if (env[key] === undefined) delete env[key];
  const cwd = options.cwd ?? process.cwd();
  const proc = options.spawn ? options.spawn(argv, { cwd, env })
    : Bun.spawn(argv, { cwd, env, stdin: "pipe", stdout: "pipe", stderr: "pipe" }) as unknown as PipedSubprocess;
  const conn = new JsonRpcConnection(proc);
  try {
    await conn.request("initialize", { clientInfo: { name: "agent-session-limits", version: "0.2.0" }, capabilities: {} }, timeoutMs);
    conn.notify("initialized");
    return codexLimitSnapshot(await conn.request("account/rateLimits/read", { excludeResetCreditDetails: true }, timeoutMs), "poll");
  } finally {
    conn.kill();
    await Promise.race([conn.exited.catch(() => 0), Bun.sleep(2_000)]);
  }
}

/** Text-only `claude` process → control request get_usage. */
export async function probeClaudeLimits(options: LimitProbeOptions & { spawn?: ClaudeCodeSessionConfig["spawn"] } = {}): Promise<LimitSnapshot | undefined> {
  const session = new ClaudeCodeSession({ bin: options.bin, env: options.env, cwd: options.cwd, spawn: options.spawn,
    textOnly: true, persistSession: false, maxTurns: 1 });
  try {
    await session.start();
    return await session.readLimits({ timeoutMs: options.timeoutMs ?? 15_000 });
  } finally { session.kill(); }
}
