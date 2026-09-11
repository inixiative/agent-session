import { expect, test } from "bun:test";
import { Sanitizer, FrameRecorder } from "../scripts/s0/sanitize";

test("explicit allowlists reject nested secrets, reasoning, unknown values and hostile discriminator names", () => {
  const s = new Sanitizer();
  const value = s.clean({ method: "codex/event", params: { msg: {
    type: "exec_command_end", call_id: "private-call", output: "1.3.14\nS0_SENTINEL_OK\nprivate content SECRET",
    token: "SECRET", nested: { auth: "SECRET" }, usage: { input_tokens: 7, secret: "SECRET" },
  }, authentication: "SECRET" }, session_secret: "SECRET" });
  const json = JSON.stringify(value);
  expect(json).not.toContain("SECRET"); expect(json).not.toContain("private-call");
  expect(json).not.toContain("private content"); expect(json).toContain("S0_SENTINEL_OK");
  expect(json).toContain('"input_tokens":7');
  expect(JSON.stringify(s.clean({ type: "thinking", thinking: "SECRET", text: "S0_SENTINEL_OK", signature: "SECRET" }))).not.toContain("S0_SENTINEL_OK");
  const unknown = JSON.stringify(s.clean({ type: "SECRET", SECRET: { token: "SECRET" }, text: "SECRET" }));
  expect(unknown).not.toContain("SECRET"); expect(unknown).toContain("unknown");
  expect(JSON.stringify(s.clean({ type: "assistant", message: { content: [{ type: "thinking", thinking: "SECRET" }] } }))).not.toContain("SECRET");
});

test("stable redaction preserves native correlation but never native IDs", () => {
  const s = new Sanitizer();
  const a = s.clean({ type: "exec_command_begin", call_id: "secret-id" }) as any;
  const b = s.clean({ type: "exec_command_end", call_id: "secret-id" }) as any;
  expect(a.call_id).toBe(b.call_id); expect(a.call_id).not.toBe("secret-id");
});

test("session diagnostics use explicit labels/counts and preserve two-admission pseudonyms", () => {
  const s = new Sanitizer();
  const frames = ["first", "second"].map(admissionId => s.clean({ kind: "native_status", admissionId,
    nativeSessionId: "private-native-handle", turnId: admissionId, unattributedReason: "foreign-turn",
    diagnostics: { observerFailures: { synchronous: 2, asynchronous: 3, error: "PRIVATE" } },
  }) as any);
  expect(frames[0].nativeSessionId).toBe(frames[1].nativeSessionId);
  expect(frames[0].admissionId).not.toBe(frames[1].admissionId);
  expect(frames[0].turnId).toBe(frames[0].admissionId);
  expect(frames[0].unattributedReason).toBe("foreign-turn");
  expect(frames[0].diagnostics.observerFailures.synchronous).toBe(2);
  expect(frames[0].diagnostics.observerFailures.asynchronous).toBe(3);
  expect(JSON.stringify(frames)).not.toMatch(/PRIVATE|private-native-handle/);
  const adversarial = s.clean({ kind: "native_status", unattributedReason: "PRIVATE", synchronous: 987654321,
    diagnostics: { observerFailures: { synchronous: "PRIVATE", asynchronous: [987654321], content: [987654321] } } });
  expect(JSON.stringify(adversarial)).not.toMatch(/PRIVATE|987654321/);
});

test("split UTF8 / newline frames retain framing evidence without persisting original bytes", () => {
  const f = new FrameRecorder(new Sanitizer());
  const bytes = new TextEncoder().encode(JSON.stringify({ type: "result", result: "secret café S0_PROBE_OK", is_error: false }) + "\n");
  for (const byte of bytes) f.chunk(new Uint8Array([byte]));
  f.end();
  expect(f.frames).toHaveLength(1); expect(f.chunks).toHaveLength(bytes.length);
  expect(f.frames[0].firstChunk).toBe(0); expect(f.frames[0].lastChunk).toBe(bytes.length - 1);
  expect(JSON.stringify(f.frames)).not.toContain("secret"); expect(JSON.stringify(f.frames)).toContain("S0_PROBE_OK");
});

test("malformed and unknown transport data retains only safe shape facts", () => {
  const f = new FrameRecorder(new Sanitizer());
  f.chunk(new TextEncoder().encode('SECRET not-json\n{"type":"unknown-secret","payload":{"password":"SECRET"}}'));
  f.end();
  expect(f.frames).toHaveLength(2); expect(JSON.stringify(f.frames)).not.toContain("SECRET");
  expect(JSON.stringify(f.frames)).not.toContain("unknown-secret");
});

test("numeric payloads are omitted outside explicitly typed protocol fields", () => {
  const s = new Sanitizer();
  const value: any = s.clean({ type: "assistant", content: [987654321, { type: "text", input_tokens: 987654321 }],
    usage: { input_tokens: 7, output_tokens: 11 }, message: { content: [[987654321]] } });
  expect(JSON.stringify(value)).not.toContain("987654321");
  expect(value.usage).toEqual({ input_tokens: 7, output_tokens: 11 });
  expect(JSON.stringify(s.clean(987654321))).not.toContain("987654321");
});

test("untyped analysis envelopes drop their entire payload but retain pseudonymized identity", () => {
  const s = new Sanitizer();
  const value: any = s.clean({ phase: "analysis", id: "private-item", content: "S0_SENTINEL_OK", usage: { input_tokens: 987654321 } });
  expect(JSON.stringify(value)).not.toMatch(/S0_SENTINEL_OK|987654321|private-item/);
  expect(value.omitted).toBe("reasoning"); expect(value.id).toMatch(/^ref-/);
  expect((s.clean({ type: "item_completed", item: { phase: "analysis", id: "private-item" } }) as any).item.id).toBe(value.id);
});

test("unknown item schemas retain only explicit pseudonymized identities and safe shape", () => {
  const s = new Sanitizer();
  const begin: any = s.clean({ type: "item_started", thread_id: "thread", turn_id: "turn", item: {
    type: "UNRECOGNIZED_PRIVATE_TYPE", id: "item", call_id: "call", content: [987654321, "SECRET"], secret: "SECRET",
  } });
  const end: any = s.clean({ type: "item_completed", thread_id: "thread", turn_id: "turn", item: {
    type: "UNRECOGNIZED_PRIVATE_TYPE", id: "item", call_id: "call",
  } });
  expect(begin.item.id).toMatch(/^ref-/); expect(begin.item.call_id).toMatch(/^ref-/);
  expect(begin.item.id).toBe(end.item.id); expect(begin.item.call_id).toBe(end.item.call_id);
  expect(begin.thread_id).toBe(end.thread_id); expect(begin.turn_id).toBe(end.turn_id);
  expect(JSON.stringify(begin)).not.toMatch(/SECRET|987654321|UNRECOGNIZED_PRIVATE_TYPE/);
  expect(begin.item.type).toBe("unknown");
});

test("exact newline, partial UTF8 and multiple frames preserve actual starting chunks", () => {
  const r = new FrameRecorder(new Sanitizer()); const e = new TextEncoder();
  r.chunk(e.encode('{"type":"system"}\n'));
  r.chunk(e.encode('{"type":"result",'));
  r.chunk(e.encode('"result":"S0_PROBE_OK"}\n{"type":"user"}\n'));
  r.chunk(e.encode('{"type":"assistant","content":"'));
  const utf = e.encode("é"); r.chunk(utf.slice(0, 1)); r.chunk(utf.slice(1));
  r.chunk(e.encode('"}\n')); r.end();
  expect(r.frames.map(f => [f.firstChunk, f.lastChunk])).toEqual([[0, 0], [1, 2], [2, 2], [3, 6]]);
});
