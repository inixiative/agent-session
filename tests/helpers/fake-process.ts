import type { PipedSubprocess } from "../../src/claude-code-session";

/** A scriptable stdio process: each stdin JSON line is handed to `onMessage`. */
export function fakeProcess(onMessage: (message: any, io: FakeIo) => void = () => {}) {
  let out!: ReadableStreamDefaultController<Uint8Array>, exit!: (code: number) => void;
  let closed = false, killed = false;
  const lines: any[] = [];
  const encoder = new TextEncoder();
  const io: FakeIo = {
    emit(value) { if (!closed) out.enqueue(encoder.encode(JSON.stringify(value) + "\n")); },
    exit(code = 0) { if (!closed) { closed = true; try { out.close(); } catch { /* closed */ } exit(code); } },
  };
  const proc: PipedSubprocess = {
    stdout: new ReadableStream<Uint8Array>({ start(c) { out = c; } }),
    stderr: new ReadableStream<Uint8Array>({ start(c) { c.close(); } }),
    exited: new Promise<number>(resolve => { exit = resolve; }),
    kill() { killed = true; io.exit(143); },
    stdin: {
      write(data: string) {
        for (const line of data.split("\n")) {
          if (!line.trim()) continue;
          const message = JSON.parse(line);
          lines.push(message);
          queueMicrotask(() => onMessage(message, io));
        }
      },
      flush() {},
      end() {},
    },
  };
  return { proc, lines, io, get killed() { return killed; }, get closed() { return closed; } };
}

export interface FakeIo {
  emit(value: unknown): void;
  exit(code?: number): void;
}

export const tick = (ms = 0) => Bun.sleep(ms);
