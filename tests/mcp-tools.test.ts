import { test, expect } from "bun:test";
import { CodexMcpSession, type SessionEvent } from "../src";

// Synthetic protocol.rs-derived notifications, not a captured installed wire.
const invocation = { server: "foundry_controlled", tool: "foundry_memory", arguments: { id: "owned-fact" } };
const begin = () => ({ type: "mcp_tool_call_begin", call_id: "call", invocation });
const end = (result: unknown = { Ok: { content: [{ type: "text", text: "PUBLIC" }] } }) =>
  ({ type: "mcp_tool_call_end", call_id: "call", invocation, result });
async function replay(frames: Record<string, unknown>[], late = false) {
  let output!: ReadableStreamDefaultController<Uint8Array>, exit!: (n: number) => void;
  let request: number; let writes = 0;
  const emit = (value: unknown) => output.enqueue(new TextEncoder().encode(JSON.stringify(value) + "\n"));
  const event = (msg: Record<string, unknown>) => emit({ method: "codex/event", params: { id: "turn", msg } });
  const session = new CodexMcpSession({ externalSessionId: "session", timeout: late ? 5 : 1000, spawn: () => ({
    stdout: new ReadableStream({ start(c) { output = c; } }), stderr: new ReadableStream({ start(c) { c.close(); } }),
    exited: new Promise<number>(r => { exit = r; }), kill() { output.close(); exit(0); },
    stdin: { write(line: string) { const v = JSON.parse(line); if (v.method !== "tools/call") { queueMicrotask(() => emit({ id: v.id, result: {} })); return; }
      writes++; request = v.id; queueMicrotask(() => { event({ type: "task_started", turn_id: "turn" }); if (!late) finish(); }); }, flush() {}, end() {} },
  }) });
  function finish() { for (const frame of frames) event(frame); event({ type: "task_complete", turn_id: "turn" }); emit({ id: request, result: { structuredContent: { threadId: "session", content: "DONE" } } }); }
  await session.start();
  const observed: SessionEvent[] = []; session.onEvent(e => { observed.push(e); if (e.kind === "tool_use") { try { (e.toolInput as any).id = "FORGED"; } catch {} } });
  const result = await session.send("controlled").catch(e => e);
  const localSnapshot = session.attempts[0];
  if (late) { finish(); for (let i = 0; i < 20 && session.attempts[0].nativeOutcome === "unknown"; i++) await Bun.sleep(1); }
  const attempt = session.attempts[0]; const events = session.events; session.kill();
  return { result, attempt, events, observed, writes, localSnapshot };
}
test("MCP call evidence preserves public arguments, server, result and immutable ownership", async () => {
  const r = await replay([begin(), end()]); const start = r.attempt.events.find(e => e.kind === "tool_use")!;
  const finish = r.attempt.events.find(e => e.kind === "tool_result")!;
  expect(start.toolInput).toEqual({ id: "owned-fact" }); expect(start.toolName).toBe("mcp__foundry_controlled__foundry_memory");
  expect(start.toolServer).toBe("foundry_controlled"); expect(finish.toolMethod).toBe("foundry_memory");
  expect(finish.callId).toBe(start.callId); expect(finish.admissionId).toBe(start.admissionId);
  expect(JSON.parse(finish.toolOutput!)).toEqual({ content: [{ type: "text", text: "PUBLIC" }] });
  expect(Object.isFrozen(start.toolInput)).toBe(true); expect(r.attempt.nativeOutcome).toBe("completed");
});
for (const result of [{ Err: "PUBLIC_TOOL_ERROR" }, { Ok: { content: [], isError: true } }]) test("MCP tool failure does not fabricate failed native terminal " + JSON.stringify(result), async () => {
  const r = await replay([begin(), end(result)]); expect(r.attempt.nativeOutcome).toBe("completed");
  expect(r.attempt.events.find(e => e.kind === "tool_result")?.toolError).toBe(true);
});
test("duplicate, foreign, mismatched and malformed MCP events cannot invent call joins", async () => {
  const r = await replay([end(), { ...begin(), thread_id: "foreign" }, { ...begin(), call_id: 1 }, begin(), begin(),
    { ...end(), invocation: { ...invocation, arguments: { id: "foreign" } } }, end({ Ok: null }), end({ Ok: { content: [] }, Err: "ambiguous" }), end(), end()]);
  expect(r.attempt.events.filter(e => e.kind === "tool_use")).toHaveLength(1);
  expect(r.attempt.events.filter(e => e.kind === "tool_result")).toHaveLength(1);
  expect(r.events.filter(e => e.unattributedReason)).toHaveLength(8);
});
test("non-text and unknown result fields retain schema omission, never private payloads", async () => {
  const r = await replay([begin(), end({ Ok: { content: [{ type: "image", data: "PRIVATE" }, { type: "thinking", text: "PRIVATE" }, { type: "text", text: "PUBLIC", reasoning: "PRIVATE" }], structuredContent: { secret: "PRIVATE" }, _meta: { token: "PRIVATE" } } })]);
  const e = r.attempt.events.find(e => e.kind === "tool_result")!;
  expect(e.toolOutput).toContain("PUBLIC"); expect(e.toolOutputOmitted).toBe(true); expect(JSON.stringify(e)).not.toContain("PRIVATE");
});
test("late MCP call evidence remains with the timed-out admission; historical result stays frozen", async () => {
  const r = await replay([begin(), end()], true);
  expect(r.result.attempt.nativeOutcome).toBe("completed"); expect(r.attempt.localOutcome).toBe("rejected");
  expect(r.attempt.events.filter(e => e.kind === "tool_result")).toHaveLength(1); expect(r.writes).toBe(1);
  expect(r.localSnapshot.nativeOutcome).toBe("unknown"); expect(r.localSnapshot.events.some(e => e.kind === "tool_result")).toBe(false);
});
test("absent arguments stay unavailable; secret subfields and envelope extras never become public tool evidence",async()=>{
  const args={id:"owned",nested:{credentials:{key:"PRIVATE"},reasoning:"PRIVATE",value:3}};
  const r=await replay([{...begin(),invocation:{...invocation,arguments:args},reasoning:"PRIVATE"},
    {...end(),invocation:{...invocation,arguments:args},environment:{key:"PRIVATE"}},
    {...begin(),call_id:"absent",invocation:{server:invocation.server,tool:invocation.tool}},
    {...end(),call_id:"absent",invocation:{server:invocation.server,tool:invocation.tool}}]);
  const begins=r.attempt.events.filter(e=>e.kind==="tool_use");expect(begins).toHaveLength(2);
  expect(begins[0].toolInput).toEqual({id:"owned",nested:{value:3}});expect(begins[0].toolInputOmitted).toBeDefined();
  expect(begins[1].toolInput).toBeUndefined();expect(begins[1].toolInputOmitted).toBeDefined();
  expect(JSON.stringify(r.attempt.events)).not.toContain("PRIVATE");
});
test("a tool result after an observed terminal stays unowned, without entering a later admission",async()=>{
  const r=await replay([begin(),{type:"task_complete",turn_id:"turn"},end()]);
  expect(r.attempt.nativeOutcome).toBe("completed");expect(r.attempt.events.filter(e=>e.kind==="tool_result")).toHaveLength(0);
  expect(r.events.some(e=>e.unattributedReason==="after-terminal"&&e.callId==="call"&&!e.admissionId)).toBe(true);
});
