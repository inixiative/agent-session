import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { ClaudeCodeSession, CodexMcpSession, type SessionEvent } from "../src";
import { Sanitizer, PROMPT } from "../scripts/s0/sanitize";

const load = (path: string) => JSON.parse(readFileSync(new URL(`../fixtures/s0/2026-09-07/${path}/recording.json`, import.meta.url), "utf8"));
const claude = load("claude"), mcp = load("codex-mcp");
const wire = (r: any) => r.stdout.frames.map((f: any) => f.value);
const native = (r: any) => wire(r).map((v: any) => v.params?.msg ?? v);
const sha = (value: string) => createHash("sha256").update(value).digest("hex");

test("fixture manifest detects recording modification", () => {
  const base = new URL("../fixtures/s0/2026-09-07/", import.meta.url);
  const manifest = JSON.parse(readFileSync(new URL("manifest.json", base), "utf8")) as { recordings: Record<string, string> };
  for (const [file, digest] of Object.entries(manifest.recordings)) {
    expect(sha(readFileSync(new URL(file, base), "utf8"))).toBe(digest);
  }
});

for (const [name, recording] of [["claude", claude], ["codex-mcp", mcp]] as const) {
  test(`recording integrity: ${name} has real terminal, controlled tool output and owned cleanup`, () => {
    expect(recording.capture).toBe("terminal-recorded");
    expect(recording.localSend).toBe("resolved");
    expect(recording.nativeOutcome).toBe(name === "claude" ? "success" : "task_complete");
    expect(recording.versions.cli.exitCode).toBe(0); expect(recording.versions.bun.value).toBe("1.3.14");
    expect(recording.sourceRevision).toMatch(/^[a-f0-9]{40}$/);
    expect(recording.prompt).toBe(PROMPT);
    expect(recording.sample.beforeHash).toBe(sha("S0_SENTINEL_OK\n"));
    expect(recording.sample.afterHash).toBe(recording.sample.beforeHash);
    expect(recording.sample.filesUnchanged).toBe(true);
    expect(recording.processExited).toBe(true);
    expect(recording.observerErrors).toEqual([]);
    expect(recording.accountIdentity).toBe("unknown"); expect(recording.capacity).toBe("unknown");
    const cleanup = recording.lifecycle.findIndex((e: any) => e.kind === "cleanup-outcome-established");
    const kill = recording.lifecycle.findIndex((e: any) => e.kind === "owned-process-kill-requested");
    expect(cleanup).toBeGreaterThan(-1); expect(kill).toBeGreaterThan(cleanup);
    for (const frame of recording.stdout.frames) {
      expect(frame.firstChunk).toBeLessThanOrEqual(frame.lastChunk);
      expect(frame.lastChunk).toBeLessThan(recording.stdout.chunks.length);
    }
    expect(recording.stdin.frames.filter((f: any) => name === "claude" ? f.value.type === "user" : f.value.method === "tools/call")).toHaveLength(1);
    expect(JSON.stringify(recording)).not.toMatch(/\/Users\/|api[_-]?key|access_token|refresh_token|Bearer /i);
  });
}

test("protocol facts: tool begin/result correlation and output were observed before terminal", () => {
  const n = native(mcp), begin = n.find((v: any) => v.type === "exec_command_begin"), end = n.find((v: any) => v.type === "exec_command_end");
  expect(end.call_id).toBe(begin.call_id); expect(end.turn_id).toBe(begin.turn_id);
  expect(end.exit_code).toBe(0); expect(end.status).toBe("completed");
  expect(end.stdout).toContain("S0_SENTINEL_OK"); expect(end.stdout).toContain("1.3.14");
  expect(n.indexOf(end)).toBeLessThan(n.findIndex((v: any) => v.type === "task_complete"));
  const messages = wire(claude);
  const use = messages.flatMap((v: any) => v.message?.content ?? []).find((v: any) => v.type === "tool_use");
  const result = messages.flatMap((v: any) => v.message?.content ?? []).find((v: any) => v.type === "tool_result");
  expect(result.tool_use_id).toBe(use.id); expect(result.is_error).toBe(false);
  expect(result.content).toContain("S0_SENTINEL_OK"); expect(result.content).toContain("1.3.14");
  const terminal = messages.find((v: any) => v.type === "result");
  expect(terminal.subtype).toBe("success"); expect(terminal.stop_reason).toBe("end_turn");
});

test("protocol model acknowledgments and usage remain distinct from requests and missing evidence", () => {
  const configured = native(mcp).find((v: any) => v.type === "session_configured");
  expect(configured.model).toBe("gpt-6-astra"); expect(configured.reasoning_effort).toBe("xhigh");
  const init = wire(claude).find((v: any) => v.type === "system" && v.subtype === "init");
  expect(init.model).toBe("claude-fable-5-1"); expect(init.effort).toBeUndefined();
  const usage = native(mcp).filter((v: any) => v.type === "token_count").at(-1).info;
  expect(usage.total_token_usage.input_tokens).toBe(27954);
  expect(usage.last_token_usage.input_tokens).toBe(14059);
  expect(usage.total_token_usage.cached_input_tokens).toBe(4992);
  const claudeUsage = wire(claude).find((v: any) => v.type === "result").usage;
  expect(claudeUsage.cache_creation_input_tokens).toBe(15103); expect(claudeUsage.cache_read_input_tokens).toBe(35801);
});

async function replay(recording: any, chunkSize: number) {
  const values = wire(recording);
  let offset = 0, writes = 0;
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let finish!: (code: number) => void;
  const exited = new Promise<number>(resolve => { finish = resolve; });
  const emitThrough = (id?: number) => {
    while (offset < values.length) {
      const value = values[offset++];
      const bytes = new TextEncoder().encode(JSON.stringify(value) + "\n");
      for (let i = 0; i < bytes.length; i += chunkSize) controller.enqueue(bytes.slice(i, i + chunkSize));
      if (id !== undefined && value.id === id && ("result" in value || "error" in value)) break;
    }
  };
  const proc = { stdin: { write(data: string) {
    const value = JSON.parse(data);
    if (value.method === "notifications/initialized") return;
    writes++;
    queueMicrotask(() => emitThrough(value.id));
  }, flush() {}, end() {} }, stdout: new ReadableStream<Uint8Array>({ start(c) { controller = c; } }),
    stderr: new ReadableStream<Uint8Array>({ start(c) { c.close(); } }), exited,
    kill() { controller.close(); finish(143); } };
  const session = recording.path === "claude"
    ? new ClaudeCodeSession({ spawn: () => proc, ...recording.requested, timeout: 2000 })
    : new CodexMcpSession({ spawn: () => proc, ...recording.requested, timeout: 2000 });
  const events: SessionEvent[] = [];
  session.onEvent(e => events.push(e));
  await session.start();
  const result = await session.send(PROMPT);
  session.kill(); await exited;
  return { result, events, writes };
}

function historicalProjection(events: any[], engine: string) {
  // Historical artifacts remain byte-for-byte. S1 intentionally adds native status,
  // terminals and Claude user/tool_result, and removes MCP's duplicate begin.
  // Cache telemetry intentionally adds per-request usage events.
  let seenBegin = false;
  return events.filter(e => {
    if (e.kind === "usage") return false;
    if (e.kind === "native_status" || (e.kind === "result" && e.raw?.type === "task_complete")) return false;
    if (engine === "claude" && e.kind === "tool_result") return false;
    if (engine === "codex-mcp" && e.kind === "tool_use") { if (seenBegin) return false; seenBegin = true; }
    return true;
  });
}
function observable(events: any[]) {
  const s = new Sanitizer();
  // Reasoning payloads are deliberately unavailable for replay. IDs are tested
  // separately at the wire boundary; timestamps are newly generated by adapters.
  return events.filter(e => e.kind !== "thinking" && e.type !== "thinking").map(e => ({
    kind: e.kind, text: typeof e.text === "string" ? s.text(e.text) : undefined,
    toolName: e.toolName, toolInput: s.clean(e.toolInput), toolOutput: e.toolOutput ? s.text(e.toolOutput) : undefined,
    toolError: e.toolError,
    // Historical recordings predate cache counters and provider usage retention.
    tokens: e.tokens ? { input: e.tokens.input, output: e.tokens.output } : undefined,
  }));
}

for (const [name, recording] of [["claude", claude], ["codex-mcp", mcp]] as const) {
  test(`offline replay: ${name} production class reproduces recorded non-reasoning events across split chunks`, async () => {
    for (const size of [1, 7, 65536]) {
      const replayed = await replay(recording, size);
      expect(observable(historicalProjection(replayed.events, name))).toEqual(observable(historicalProjection(recording.normalized, name)));
      expect(replayed.result.nativeOutcome).toBe("completed");
      expect(replayed.result.content).toBe(recording.result.content);
      expect(replayed.writes).toBe(name === "claude" ? 1 : 3);
    }
  });
}

// Desired capability regressions: expected failures are NOT S1/S3/S4 acceptance.
test("S1 fixed (S3 overlap): Claude's real user/tool_result becomes a normalized tool result", async () => {
  expect((await replay(claude, 7)).events.filter(e => e.kind === "tool_result")).toHaveLength(1);
});
test("S1 fixed (S3 overlap): MCP emits one tool begin per native call, not a second begin at exec end", async () => {
  expect((await replay(mcp, 7)).events.filter(e => e.kind === "tool_use")).toHaveLength(1);
});
test("S1 fixed: normalized MCP tool results expose native call and turn identity", async () => {
  const result: any = (await replay(mcp, 7)).events.find(e => e.kind === "tool_result");
  const end = native(mcp).find((v: any) => v.type === "exec_command_end");
  expect(result.callId).toBe(end.call_id); expect(result.turnId).toBe(end.turn_id);
});
test("S1 fixed: native task_complete is available as an explicit normalized terminal", async () => {
  expect((await replay(mcp, 7)).events.some((e: any) => e.kind === "result" && e.raw?.type === "task_complete")).toBe(true);
});
test.failing("S4 desired: MCP result preserves observed total and last usage instead of dropping both", async () => {
  const result: any = (await replay(mcp, 7)).result;
  expect(result.usage).toMatchObject({ total: { input: 27954, output: 121, cachedInput: 4992 },
    last: { input: 14059, output: 27, cachedInput: 0 } });
});
test.failing("S4 desired: Claude normalized usage preserves available cached token fields", async () => {
  const result: any = (await replay(claude, 7)).result;
  expect(result.tokens.cacheReadInput).toBe(35801);
});

test("existing experimental path: no handshake response and no native turn request, not success", () => {
  const r = load("codex-app-server");
  expect(r.capture).toBe("handshake-unresolved"); expect(r.localSend).toBe("not-called");
  expect(r.nativeOutcome).toBe("not-started-no-turn-request");
  expect(r.stdout.frames).toHaveLength(0);
  expect(r.stdin.frames.map((f: any) => f.value.method)).toEqual(["initialize"]);
  expect(r.stderrFacts.websocketListenerAnnounced).toBe(true);
  expect(r.processExited).toBe(true); expect(r.processExitCode).toBe(0);
  expect(r.lifecycle.find((e: any) => e.kind === "cleanup-outcome-established").noTurn).toBe(true);
  expect(r.normalized.map((e: any) => e.kind)).toEqual(["session_start", "session_end"]);
});

const correctedRun = "2026-09-07-correction-1";
const correctedBase = new URL(`../fixtures/s0/${correctedRun}/`, import.meta.url);
const corrected = (name: string) => JSON.parse(readFileSync(new URL(`${name}/recording.json`, correctedBase), "utf8"));

test("corrective manifest preserves initial artifacts and original recorder source provenance", () => {
  const manifest = JSON.parse(readFileSync(new URL("manifest.json", correctedBase), "utf8")) as {
    recordings: Record<string, string>; previousRunUnchanged: Record<string, string>; newProbeCounts: Record<string, number> };
  for (const [file, digest] of Object.entries(manifest.recordings)) expect(sha(readFileSync(new URL(file, correctedBase), "utf8"))).toBe(digest);
  for (const [file, digest] of Object.entries(manifest.previousRunUnchanged)) {
    expect(sha(readFileSync(new URL(`../fixtures/s0/2026-09-07/${file}`, import.meta.url), "utf8"))).toBe(digest);
  }
  for (const file of ["record.ts", "sanitize.ts"]) {
    expect(sha(readFileSync(new URL(`source-before/${file}.txt`, correctedBase), "utf8"))).toBe(mcp.sourceHashes[`scripts/s0/${file}`]);
  }
  expect(manifest.newProbeCounts).toEqual({ claude: 1, "codex-mcp": 1, "codex-app-server": 0 });
  expect(mcp.format).toBe(1); // Historical bounds remain historical, byte-for-byte.
});

for (const name of ["claude", "codex-mcp"]) {
  test(`corrective ${name}: admitted once, native terminal, exact outbound framing and owned cleanup`, () => {
    const r = corrected(name);
    expect(r.format).toBe(2); expect(r.runId).toBe(correctedRun);
    expect(r.capture).toBe("terminal-recorded"); expect(r.localSend).toBe("resolved");
    expect(r.nativeOutcome).toBe(name === "claude" ? "success" : "task_complete");
    expect(r.admission).toMatchObject({ sendAdmitted: true, outboundObserverFailed: false, noTurn: false });
    expect(r.admission.attemptedWrites).toBe(r.admission.observedWrites);
    expect(r.lifecycle.filter((e: any) => e.kind === "send-admitted")).toHaveLength(1);
    expect(r.stdin.frames.filter((f: any) => name === "claude" ? f.value.type === "user" : f.value.method === "tools/call")).toHaveLength(1);
    expect(r.stdin.frames.map((f: any) => [f.firstChunk, f.lastChunk])).toEqual(r.stdin.chunks.map((c: any) => [c.index, c.index]));
    expect(r.processExited).toBe(true); expect(r.observerErrors).toEqual([]);
    expect(r.sample.beforeHash).toBe(r.sample.afterHash); expect(r.sample.filesUnchanged).toBe(true);
    expect(r.result.content).toContain("S0_SENTINEL_OK"); expect(r.result.content).toContain("1.3.14");
    expect(r.sourceHashes["src/codex-session.ts"]).toBe(mcp.sourceHashes["src/codex-session.ts"]);
    expect(r.sourceHashes["src/claude-code-session.ts"]).toBe(claude.sourceHashes["src/claude-code-session.ts"]);
  });
  test(`corrective ${name}: existing class replay preserves non-reasoning observations through split chunks`, async () => {
    const r = corrected(name);
    for (const size of [1, 7, 65536]) {
      const replayed = await replay(r, size);
      expect(observable(historicalProjection(replayed.events, name))).toEqual(observable(historicalProjection(r.normalized, name)));
      expect(replayed.result.nativeOutcome).toBe("completed");
      expect(replayed.result.content).toBe(r.result.content);
      expect(replayed.writes).toBe(name === "claude" ? 1 : 3);
    }
  });
}

test("corrective MCP wire preserves session/turn/item/call relationships, including unknown item types", () => {
  const n = native(corrected("codex-mcp"));
  const configured = n.find((v: any) => v.type === "session_configured");
  const started = n.filter((v: any) => v.type === "item_started");
  const ended = n.filter((v: any) => v.type === "item_completed");
  expect(started).toHaveLength(4); expect(ended).toHaveLength(4);
  const turn = n.find((v: any) => v.type === "task_started").turn_id;
  for (const item of started) {
    expect(item.item.id).toMatch(/^ref-/);
    const end = ended.find((v: any) => v.item.id === item.item.id);
    expect(end).toBeDefined(); expect(end.thread_id).toBe(configured.thread_id);
    expect(item.thread_id).toBe(end.thread_id); expect(item.turn_id).toBe(turn); expect(end.turn_id).toBe(turn);
    expect(item.item.type).toBe("unknown"); expect(item.item.shape).toBeDefined();
  }
  const begin = n.find((v: any) => v.type === "exec_command_begin"), end = n.find((v: any) => v.type === "exec_command_end");
  expect(started.some((v: any) => v.item.id === begin.call_id)).toBe(true);
  expect(end.call_id).toBe(begin.call_id); expect(end.turn_id).toBe(turn); expect(end.exit_code).toBe(0);
  expect(end.stdout).toContain("S0_SENTINEL_OK"); expect(end.stdout).toContain("1.3.14");
  expect(n.find((v: any) => v.type === "task_complete").turn_id).toBe(turn);
});

test("corrective Claude wire preserves message/tool identity and explicit absence of dedicated turn fields", () => {
  const messages = wire(corrected("claude"));
  const assistant = messages.filter((v: any) => v.type === "assistant");
  expect(assistant.length).toBeGreaterThan(0);
  for (const msg of assistant) expect(msg.message.id).toMatch(/^ref-/);
  const use = assistant.flatMap((v: any) => v.message.content).find((v: any) => v.type === "tool_use");
  const reply = messages.flatMap((v: any) => v.message?.content ?? []).find((v: any) => v.type === "tool_result");
  expect(use.id).toMatch(/^ref-/); expect(reply.tool_use_id).toBe(use.id); expect(reply.is_error).toBe(false);
  expect(reply.content).toContain("S0_SENTINEL_OK"); expect(reply.content).toContain("1.3.14");
  const session = messages.find((v: any) => v.type === "system" && v.subtype === "init").session_id;
  for (const msg of assistant) expect(msg.session_id).toBe(session);
  expect(messages.some((v: any) => v.turn_id !== undefined || v.turnId !== undefined)).toBe(false);
  // The sanitizer now preserves these allowed fields even on unknown types;
  // this narrow absence is not an assertion about unclassified field aliases.
});

test("app-server preflight records the installed input schema and transport distinction", () => {
  const preflight = JSON.parse(readFileSync(new URL("../fixtures/s0/2026-09-07/app-server-preflight.json", import.meta.url), "utf8"));
  expect(preflight.helpExit).toBe(0); expect(preflight.schemaExit).toBe(0);
  expect(preflight.stdioIsDefault).toBe(true); expect(preflight.websocketExplicit).toBe(true);
  expect(preflight.selectedSchema[0].input.type).toBe("array");
});

for (const name of ["claude", "codex-mcp"]) test(`S1 recorded ${name}: additive identities and terminal refer to the observed wire`, async () => {
  const r = corrected(name), { result, events } = await replay(r, 7);
  expect(result.admissionId).toBeDefined(); expect(result.nativeOutcome).toBe("completed");
  expect(result.admissionId).not.toBe(result.turnId);
  const terminal = events.find(e => e.kind === "result" && e.nativeOutcome === "completed")!;
  expect(terminal.admissionId).toBe(result.admissionId);
  const use = events.find(e => e.kind === "tool_use")!, output = events.find(e => e.kind === "tool_result")!;
  expect(use.callId).toBe(output.callId); expect(output.toolOutput).toContain("S0_SENTINEL_OK");
  if (name === "codex-mcp") {
    const n = native(r), started = n.find((v: any) => v.type === "task_started");
    expect(result.turnId).toBe(started.turn_id); expect(terminal.turnId).toBe(started.turn_id);
    expect(result.rpcRequestId).toBe(r.stdin.frames.find((f: any) => f.value.method === "tools/call").value.id);
    const items = events.filter(e => e.kind === "native_status" && (e.raw as any)?.type === "item_started");
    expect(items.map(e => e.itemId)).toEqual(n.filter((v: any) => v.type === "item_started").map((v: any) => v.item.id));
    expect(items.some(e => e.itemId === use.callId)).toBe(true); expect(result.tokens).toBeUndefined();
  } else {
    expect(result.turnId).toBeUndefined(); expect(result.correlation).toBe("ordered-stream");
    expect(use.messageId).toBe(wire(r).find((v: any) => v.message?.content?.some((b: any) => b.type === "tool_use")).message.id);
    expect(terminal.terminal?.eventId).toBe(wire(r).find((v: any) => v.type === "result").uuid);
  }
});
