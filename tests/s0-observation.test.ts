import { expect, test } from "bun:test";
import { CaptureState } from "../scripts/s0/observation";

test("outbound observer failure cannot establish no-turn or prevent the actual single write", () => {
  const state = new CaptureState(); const writes: string[] = [];
  state.admitSend();
  state.write("request", () => { throw Error("private observer detail"); }, data => { writes.push(data); });
  expect(writes).toEqual(["request"]); expect(state.noTurn()).toBe(false);
  expect(state.cleanupAllowed(false, false)).toBe(false);
  expect(JSON.stringify(state.snapshot())).not.toContain("private observer detail");
});

test("observer failure without send admission still cannot certify absent outbound work", () => {
  const state = new CaptureState();
  state.write("request", () => { throw Error("failed"); }, () => {});
  expect(state.snapshot().sendAdmitted).toBe(false); expect(state.noTurn()).toBe(false);
});

test("send admission remains unknown after local failure even with zero recorded outbound frames", () => {
  const state = new CaptureState(); state.admitSend();
  expect(state.noTurn()).toBe(false); expect(state.cleanupAllowed(false, false)).toBe(false);
});

test("explicit non-turn writes and no send admission establish bounded no-turn evidence", () => {
  const state = new CaptureState(); state.write("initialize", () => true, () => {});
  expect(state.noTurn()).toBe(true); expect(state.cleanupAllowed(false, false)).toBe(true);
  state.write("unknown method", () => false, () => {});
  expect(state.noTurn()).toBe(false);
});

test("observed native completion survives a later observer failure; process exit is a separate cleanup fact", () => {
  const state = new CaptureState(); state.admitSend();
  state.observe(() => { throw Error("failure after success"); });
  expect(state.cleanupAllowed(true, false)).toBe(true);
  expect(state.cleanupAllowed(false, true)).toBe(true);
  expect(state.noTurn()).toBe(false);
});

test("a transport write error remains the original error and is never re-sent", () => {
  const state = new CaptureState(); state.admitSend(); let attempts = 0;
  const failure = Error("transport write failed");
  expect(() => state.write("request", () => { throw Error("observer failed"); }, () => { attempts++; throw failure; })).toThrow(failure);
  expect(attempts).toBe(1); expect(state.noTurn()).toBe(false);
});
