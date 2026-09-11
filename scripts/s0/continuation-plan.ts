/** Fixed, independent read-only tasks. Neither prompt asks for prior-turn recall. */
export const CONTINUATION_TASKS = Object.freeze([
  { file: "sentinel-one.txt", content: "S1_FIRST_SENTINEL_29\n", marker: "S1_FIRST_DONE" },
  { file: "sentinel-two.txt", content: "S1_SECOND_SENTINEL_83\n", marker: "S1_SECOND_DONE" },
].map(task => Object.freeze({ ...task,
  prompt: `Disposable continuation probe. Use a shell tool to run exactly: bun --version && cat ${task.file} . Read only this controlled directory. Do not edit files, inspect other directories, use agents, or do other work. Then respond briefly with ${task.marker} and the two observed outputs.`,
})));
export type ActivePath = "claude" | "codex-mcp";
export const REQUESTED = { claude: { model: "claude-fable-5-1", effort: "max" }, "codex-mcp": { model: "gpt-6-astra", effort: "xhigh" } } as const;
/**
 * This controlled experiment pins the Bun runtime version and the sanitizer's controlled
 * literals. Preflight fails before any model process on a mismatch; the guard requires
 * the same value in tool output. This is a deliberate portability limit, not a general
 * version policy.
 */
export const PINNED_BUN_VERSION = "1.3.14";
export function continuationPlan(path: string, runId: string) {
  if (path !== "claude" && path !== "codex-mcp") throw Error("Choose claude or codex-mcp; app-server is excluded");
  if (!/^s1-continuation-\d{8}T\d{6}Z$/.test(runId)) throw Error("Use a new s1-continuation-YYYYMMDDTHHMMSSZ run ID");
  return { path: path as ActivePath, runId, mode: "plan-only", requested: REQUESTED[path],
    expectedSpawn: path === "claude"
      ? ["claude", "--print", "--verbose", "--input-format", "stream-json", "--output-format", "stream-json", "--model", "claude-fable-5-1", "--effort", "max", "--max-turns", "8", "--permission-mode", "bypassPermissions", "--include-hook-events"]
      : ["codex", "mcp-server", "-c", 'sandbox_mode="danger-full-access"', "-c", 'approval_policy="never"', "-c", 'model_reasoning_effort="xhigh"'],
    versionCommands: [["bun", "--version"], [path === "claude" ? "claude" : "codex", "--version"]],
    output: `fixtures/s0/${runId}/${path}-continuation`, tasks: CONTINUATION_TASKS,
    limits: { processes: 1, admittedSends: 2, startDeadlineMs: 15_000, sendDeadlineMs: 180_000, settleMs: 50,
      retries: 0, resume: false, fork: false, maxTurnsClaude: 8,
      admissionDeadline: "sendDeadlineMs is one monotonic deadline per admission covering local settlement, the current admission's native outcome and trailing frames; settleMs only lets trailing frames land and is capped by the same deadline.",
      afterDeadline: "Admission stops permanently with native outcome unknown; ownership is retained for reconciliation/cleanup on the same late terminal or owned process exit. Never resume, re-send, fork or reset identity." },
    preflight: { pinnedBunVersion: PINNED_BUN_VERSION, pinned: true,
      portability: `Pinned to Bun ${PINNED_BUN_VERSION} and the existing sanitizer literals; a different version fails preflight before any model process and is not a supported capture of this experiment.` },
    guard: "Second send requires first local and correlated native success, joined tool output, intact binding, live transport, no observer/checkpoint failure and exactly one first turn write.",
    toolCommandPolicy: "Only bun --version, cat the current sentinel, or their exact && combination; Bash/shell with optional zsh/bash -c/-lc wrapper. Unexpected commands fail verification; their arbitrary text is redacted, not reconstructed.",
    cleanup: "Kill only the owned process after current owned terminal, observed process exit, or explicit no-turn evidence. Unknown outcomes stay attached; a deadline is not cancellation.",
    accountIdentity: "unknown", subscriptionContinuity: "unknown", nativeRetention: "not-tested",
    executeCommand: `bun scripts/s0/continuation-record.ts --capture ${path} ${runId}`,
    authorization: "Real capture requires separate supervisor authorization; this plan performs no process launch or filesystem mutation.",
  };
}
