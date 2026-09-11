import { expect, test } from "bun:test";
import { ClaudeCodeSession, type SessionEvent } from "../src";

// Focused Claude compaction/evidence boundary cases. Written RED before the
// correction; a repeated system/init is configuration evidence, never proof of
// compaction. Only an explicit supported boundary is a compaction.

function fixture(resume = "ref-3") {
  let output!: ReadableStreamDefaultController<Uint8Array>;
  let finish!: (code: number) => void;
  let closed = false;
  const proc = {
    stdin: { write() {}, flush() {}, end() {} },
    stdout: new ReadableStream<Uint8Array>({ start(c) { output = c; } }),
    stderr: new ReadableStream<Uint8Array>({ start(c) { c.close(); } }),
    exited: new Promise<number>(resolve => { finish = resolve; }),
    kill() { if (!closed) { closed = true; output.close(); finish(143); } },
  };
  const session = new ClaudeCodeSession({ externalSessionId: resume, timeout: 1000, spawn: () => proc });
  const emit = (raw: unknown) => output.enqueue(new TextEncoder().encode(JSON.stringify(raw) + "\n"));
  const of = (kind: SessionEvent["kind"]) => session.events.filter(e => e.kind === kind);
  const inits = () => session.events.filter(e => (e.raw as any)?.type === "system" && (e.raw as any)?.subtype === "init");
  return { session, emit, of, inits, async close() { session.kill(); await proc.exited; } };
}

const recording = new URL("../fixtures/s0/s1-continuation-20260907T041000Z/claude-continuation/recording.json", import.meta.url);

test("replayed actual init envelopes are unowned configuration evidence, not compaction", async () => {
  const r = await Bun.file(recording).json();
  const inits = r.capture.stdout.frames.map((f: any) => f.value).filter((v: any) => v.type === "system" && v.subtype === "init");
  expect(inits).toHaveLength(2);
  const f = fixture();
  try {
    await f.session.start();
    for (const raw of inits) f.emit(raw);
    await Bun.sleep(10);
    expect(f.of("session_compact")).toHaveLength(0);
    const kept = f.inits();
    expect(kept).toHaveLength(2);
    for (const e of kept) {
      expect(e.kind).toBe("native_status");
      expect(e.unattributedReason).toBe("session-configuration");
      expect(e.nativeSessionId).toBe("ref-3");
      expect(e.admissionId).toBeUndefined();
      expect(Object.isFrozen(e.raw)).toBe(true);
    }
    expect(f.session.externalSessionId).toBe("ref-3");
    expect(f.session.attempts).toHaveLength(0);
  } finally { await f.close(); }
});

test("an init during an admission is not attributed to that admission", async () => {
  const f = fixture();
  try {
    await f.session.start();
    const pending = f.session.send("second task");
    await Bun.sleep(5);
    f.emit({ type: "system", subtype: "init", session_id: "ref-3", model: "claude-fable-5-1", uuid: "init-2" });
    f.emit({ type: "result", subtype: "success", session_id: "ref-3", uuid: "res-2", result: "done", is_error: false });
    const result = await pending;
    expect(result.events.some(e => (e.raw as any)?.subtype === "init")).toBe(false);
    expect(f.session.attempts[0]?.events.some(e => (e.raw as any)?.subtype === "init")).toBe(false);
    const [init] = f.inits();
    expect(init?.unattributedReason).toBe("session-configuration");
    expect(init?.admissionId).toBeUndefined();
    expect(f.of("session_compact")).toHaveLength(0);
    expect(result.nativeOutcome).toBe("completed");
  } finally { await f.close(); }
});

test("differing init payloads are still not inferred as compaction", async () => {
  const f = fixture();
  try {
    await f.session.start();
    f.emit({ type: "system", subtype: "init", session_id: "ref-3", model: "claude-fable-5-1", tools: ["Bash"] });
    f.emit({ type: "system", subtype: "init", session_id: "ref-3", model: "claude-opus-5", tools: ["Bash", "Read"], permissionMode: "plan" });
    await Bun.sleep(10);
    expect(f.of("session_compact")).toHaveLength(0);
    expect(f.inits()).toHaveLength(2);
  } finally { await f.close(); }
});

test("one explicit boundary is exactly one compaction with native provenance; the following init adds none", async () => {
  const f = fixture();
  try {
    await f.session.start();
    f.emit({ type: "system", subtype: "init", session_id: "ref-3", uuid: "init-1" });
    f.emit({ type: "system", subtype: "compact_boundary", session_id: "ref-3", uuid: "cb-1", compact_metadata: { trigger: "auto", pre_tokens: 120000 } });
    f.emit({ type: "system", subtype: "init", session_id: "ref-3", uuid: "init-2" });
    await Bun.sleep(10);
    const compactions = f.of("session_compact");
    expect(compactions).toHaveLength(1);
    expect((compactions[0].raw as any).subtype).toBe("compact_boundary");
    expect(compactions[0].compactionSource).toBe("claude-code");
    expect(compactions[0].externalSessionId).toBe("ref-3");
    expect(compactions[0].nativeSessionId).toBe("ref-3");
    expect(compactions[0].admissionId).toBeUndefined();
    expect(Object.isFrozen(compactions[0].raw)).toBe(true);
    expect(f.inits()).toHaveLength(2);
    expect(f.session.externalSessionId).toBe("ref-3");
  } finally { await f.close(); }
});

test("a foreign boundary neither adopts its binding nor invalidates this owner", async () => {
  const f = fixture();
  try {
    await f.session.start();
    f.emit({ type: "system", subtype: "init", session_id: "ref-3" });
    f.emit({ type: "system", subtype: "compact_boundary", session_id: "foreign-binding", uuid: "cb-x" });
    await Bun.sleep(10);
    expect(f.of("session_compact")).toHaveLength(0);
    const foreign = f.session.events.find(e => (e.raw as any)?.subtype === "compact_boundary");
    expect(foreign?.kind).toBe("native_status");
    expect(foreign?.unattributedReason).toBe("foreign-session");
    expect(foreign?.nativeSessionId).toBe("foreign-binding");
    expect(f.session.externalSessionId).toBe("ref-3");
  } finally { await f.close(); }
});

test("boundaries duplicate only by correlatable uuid; text-equal boundaries without uuid are distinct compactions", async () => {
  const f = fixture();
  try {
    await f.session.start();
    f.emit({ type: "system", subtype: "init", session_id: "ref-3" });
    f.emit({ type: "system", subtype: "compact_boundary", session_id: "ref-3", uuid: "cb-1" });
    f.emit({ type: "system", subtype: "compact_boundary", session_id: "ref-3", uuid: "cb-1" });
    f.emit({ type: "system", subtype: "compact_boundary", session_id: "ref-3" });
    f.emit({ type: "system", subtype: "compact_boundary", session_id: "ref-3" });
    await Bun.sleep(10);
    const compactions = f.of("session_compact");
    expect(compactions.map(e => (e.raw as any).uuid)).toEqual(["cb-1", undefined, undefined]);
    const duplicates = f.session.events.filter(e => e.unattributedReason === "duplicate-boundary");
    expect(duplicates).toHaveLength(1);
    expect((duplicates[0].raw as any).uuid).toBe("cb-1");
  } finally { await f.close(); }
});
