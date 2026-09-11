import { test, expect } from "bun:test";
import { Sanitizer } from "../scripts/s0/sanitize";
import { sanitizeArgv, lifecycleEvent, sanitizeVersion } from "../scripts/s0/lifecycle";

test("argv uses executable, flag and value allowlists including equals syntax", () => {
  const s = new Sanitizer();
  const value = sanitizeArgv(["/private/bin/claude", "--resume=secret-native-id", "--resume", "secret-native-id",
    "--append-system-prompt=private context", "--model=private-model", "--unknown=secret", "123456789",
    "--effort", "max", "--max-turns", "8", "--output-format", "stream-json"], s);
  expect(value).toEqual({ executable: "claude", args: ["--resume", "ref-1", "--resume", "ref-1",
    "--append-system-prompt", "[redacted]", "--model", "[redacted]", "[redacted]", "[redacted]",
    "--effort", "max", "--max-turns", "8", "--output-format", "stream-json"] });
  expect(JSON.stringify(value)).not.toMatch(/private|secret|123456789/);
  expect(sanitizeArgv(["unknown-secret", "--model=gpt-6-astra"], s)).toEqual({ executable: "[redacted]", args: [] });
});
test("config and malformed argv never carry arbitrary text or numeric values", () => {
  const value = sanitizeArgv(["codex", "mcp-server", "-c", 'approval_policy="never"',
    '--config=model_reasoning_effort="xhigh"', '-c=token="secret"', "--max-turns=999999999",
    "--listen=ws://private:999", "--resume", "--unknown=secret"], new Sanitizer());
  expect(JSON.stringify(value)).not.toMatch(/secret|999|private|token/);
  expect(value.args).toContain('model_reasoning_effort="xhigh"');
});
test("lifecycle accepts only typed facts and pseudonymizes owned PID", () => {
  const s = new Sanitizer();
  const v = lifecycleEvent("spawned", { pid: 923847, executable: "secret", args: ["secret"], env: { TOKEN: "secret" }, code: 123 }, s);
  expect(v).toMatchObject({ kind: "spawned", pid: "ref-1" });
  expect(JSON.stringify(v)).not.toMatch(/secret|923847|123/);
  expect(lifecycleEvent("private-kind", { text: "secret", nativeTerminal: "secret" }, s).kind).toBe("unknown");
  expect(lifecycleEvent("cleanup-outcome-established", { nativeTerminal: "secret", exited: true, noTurn: false }, s)).toMatchObject({ nativeTerminal: "unknown", exited: true, noTurn: false });
});
test("additive attempt metadata is safe to persist, including numeric identities", () => {
  const s = new Sanitizer();
  const v = s.clean({ admissionId: "private-admission", nativeSessionId: "private-native", rpcRequestId: 83478347,
    terminal: { type: "task_complete", turnId: "private-turn", eventId: "private-event" }, nativeOutcome: "completed",
    content: [73847384, { phase: "analysis", content: "secret" }], rpcOutcome: "resolved" });
  expect(JSON.stringify(v)).not.toMatch(/private|secret|83478347|73847384/);
  expect(v).toMatchObject({ admissionId: "ref-1", nativeOutcome: "completed", rpcOutcome: "resolved" });
});

test("version provenance rejects diagnostic/private text and unknown executables", () => {
  expect(sanitizeVersion("codex", "codex-cli 0.153.4")).toBe("codex-cli 0.153.4");
  expect(sanitizeVersion("claude", "2.1.258 (Claude Code)")).toBe("2.1.258 (Claude Code)");
  expect(sanitizeVersion("bun", "1.3.14")).toBe("1.3.14");
  for (const exe of ["codex", "claude", "bun", "unknown"]) expect(sanitizeVersion(exe, "private context 123456789")).toBe("unavailable");
});
