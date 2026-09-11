import { expect, test } from "bun:test";
import { ClaudeCodeSession, type SessionEvent } from "../src";

// Synthetic documented public result blocks (Anthropic tool search: client-side
// tool_result content may carry `tool_reference` blocks). This is not a claim about
// the content of any earlier native capture; the actual wire shape is unobserved.
const tool = "mcp__foundry_controlled__foundry_memory";

async function run(content: unknown, isError = false): Promise<{ end: SessionEvent; events: readonly SessionEvent[] }> {
  let out!: ReadableStreamDefaultController<Uint8Array>, exit!: (code: number) => void;
  let closed = false, writes = 0;
  const emit = (v: unknown) => out.enqueue(new TextEncoder().encode(JSON.stringify(v) + "\n"));
  const proc = {
    stdout: new ReadableStream<Uint8Array>({ start(c) { out = c; } }),
    stderr: new ReadableStream<Uint8Array>({ start(c) { c.close(); } }),
    exited: new Promise<number>(resolve => { exit = resolve; }),
    kill() { if (!closed) { closed = true; out.close(); exit(143); } },
    stdin: { write(line: string) {
      if (JSON.parse(line).type !== "user") return;
      writes++;
      queueMicrotask(() => {
        emit({ type: "assistant", session_id: "reference-owner", message: { content: [
          { type: "tool_use", id: "discovery-call", name: "ToolSearch", input: { query: `select:${tool}` } },
        ] } });
        emit({ type: "user", session_id: "reference-owner", message: { content: [
          { type: "tool_result", tool_use_id: "discovery-call", content, is_error: isError },
        ] } });
        emit({ type: "result", session_id: "reference-owner", uuid: "reference-turn", subtype: "success", is_error: false, result: "DONE" });
      });
    }, flush() {}, end() {} },
  };
  const session = new ClaudeCodeSession({ externalSessionId: "reference-owner", timeout: 1000, spawn: () => proc as never });
  try {
    await session.start(); const result = await session.send("Controlled discovery");
    expect(result.nativeOutcome).toBe("completed"); expect(writes).toBe(1);
    const end = result.events.find(e => e.kind === "tool_result")!;
    expect(end.callId).toBe("discovery-call");
    return { end, events: result.events };
  } finally { session.kill(); await proc.exited; }
}

test("reference-only result retains exact public tool names, empty text and no omission", async () => {
  const { end } = await run([{ type: "tool_reference", tool_name: tool }]);
  expect(end.toolReferences).toEqual([tool]);
  expect(end.toolOutput).toBe(""); expect(end.toolError).toBe(false);
  expect(end.toolOutputOmitted).toBeUndefined(); expect(end.toolOutputOmittedTypes).toBeUndefined();
  expect(Object.isFrozen(end.toolReferences)).toBe(true);
});

test("references are copied in order with duplicates preserved for the guard to judge, and private sibling fields are not forwarded", async () => {
  const source = [{ type: "tool_reference", tool_name: tool, secret: "PRIVATE_REFERENCE_FIELD" }, { type: "tool_reference", tool_name: "mcp__other__tool" }, { type: "tool_reference", tool_name: tool }];
  const { end } = await run(source);
  expect(end.toolReferences).toEqual([tool, "mcp__other__tool", tool]);
  (source as any[]).push({ type: "tool_reference", tool_name: "late" });
  expect(end.toolReferences).toHaveLength(3);
  expect(JSON.stringify({ ...end, raw: undefined })).not.toContain("PRIVATE_REFERENCE_FIELD");
});

test("mixed text, references and unsupported blocks keep text and references and record partial omission by type", async () => {
  const { end } = await run([
    { type: "text", text: "1 tool found" }, { type: "tool_reference", tool_name: tool },
    { type: "image", source: { data: "PRIVATE_IMAGE_BYTES" } }, { type: "mystery", payload: "PRIVATE_UNKNOWN" }, { type: "text", text: "done" },
  ]);
  expect(end.toolOutput).toBe("1 tool found\ndone"); expect(end.toolReferences).toEqual([tool]);
  expect(end.toolOutputOmitted).toBe(true); expect(end.toolOutputOmittedTypes).toEqual(["image", "unsupported"]);
  expect(JSON.stringify({ ...end, raw: undefined })).not.toContain("PRIVATE_");
});

test("unknown or malformed non-text content is explicitly omitted, never disguised as empty success", async () => {
  const image = await run([{ type: "image", data: "PRIVATE_IMAGE_BYTES" }]);
  expect(image.end.toolOutput).toBe(""); expect(image.end.toolOutputOmitted).toBe(true);
  expect(image.end.toolOutputOmittedTypes).toEqual(["image"]); expect(image.end.toolReferences).toBeUndefined();
  const malformed = await run([{ type: "tool_reference" }, { type: "tool_reference", tool_name: 7 }, { type: "tool_reference", tool_name: "" }, "not-a-block", null]);
  expect(malformed.end.toolReferences).toBeUndefined(); expect(malformed.end.toolOutputOmitted).toBe(true);
  expect(malformed.end.toolOutputOmittedTypes).toEqual(["unsupported"]);
  expect(JSON.stringify({ ...malformed.end, raw: undefined })).not.toContain("PRIVATE");
});

test("string content, ordinary text arrays, errors and ordering are unchanged by the contract", async () => {
  const text = await run("plain string output");
  expect(text.end.toolOutput).toBe("plain string output"); expect(text.end.toolReferences).toBeUndefined(); expect(text.end.toolOutputOmitted).toBeUndefined();
  const array = await run([{ type: "text", text: "CONTROLLED_PUBLIC_TEXT" }]);
  expect(array.end.toolOutput).toBe("CONTROLLED_PUBLIC_TEXT"); expect(array.end.toolReferences).toBeUndefined(); expect(array.end.toolOutputOmitted).toBeUndefined();
  const failed = await run([{ type: "tool_reference", tool_name: tool }], true);
  expect(failed.end.toolError).toBe(true); expect(failed.end.toolReferences).toEqual([tool]);
  const kinds = failed.events.map(e => e.kind);
  expect(kinds.indexOf("tool_use")).toBeLessThan(kinds.indexOf("tool_result"));
  expect(failed.events.find(e => e.kind === "tool_use")?.callId).toBe("discovery-call");
});
