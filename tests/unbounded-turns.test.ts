import { test, expect } from "bun:test";
import { ClaudeCodeSession } from "../src";

test("Claude explicit null omits the optional turn ceiling; undefined preserves standalone default", async () => {
  for (const limit of [undefined, null, 48]) {
    let argv: string[] = [];
    let finish!: (code: number) => void;
    const session = new ClaudeCodeSession({ maxTurns: limit, spawn: cmd => {
      argv = cmd;
      return { stdin: { write() {}, flush() {}, end() {} },
        stdout: new ReadableStream({ start(c) { c.close(); } }), stderr: new ReadableStream({ start(c) { c.close(); } }),
        exited: new Promise<number>(r => { finish = r; }), kill() { finish(0); } };
    } });
    await session.start();
    const index = argv.indexOf("--max-turns");
    if (limit === null) expect(index).toBe(-1);
    else expect(argv[index + 1]).toBe(String(limit ?? 25));
    session.kill();
  }
});
test("invalid turn ceilings fail before spawning", () => {
  for (const maxTurns of [0, -1, NaN, Infinity, 1.5]) expect(() => new ClaudeCodeSession({ maxTurns })).toThrow("positive safe integer");
});
