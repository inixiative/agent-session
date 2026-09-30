// Minimal JSON-RPC 2.0 over a child's stdio, one JSON object per line.
// Used where a caller multiplexes many threads over one native process
// (Codex app-server) or makes short control reads (limit polls).

import type { PipedSubprocess } from "./codex-session";

export class JsonRpcError extends Error {
  constructor(readonly code: number, message: string) { super(message); this.name = "JsonRpcError"; }
}
/** No response within the caller's bound; the request may still be processed. */
export class JsonRpcTimeoutError extends Error {
  constructor(message: string) { super(message); this.name = "JsonRpcTimeoutError"; }
}
export class JsonRpcClosedError extends Error {
  constructor(message: string) { super(message); this.name = "JsonRpcClosedError"; }
}

export interface JsonRpcHandlers {
  onNotification?(method: string, params: Record<string, unknown> | undefined): void;
  /** Return true when the request was answered; unanswered requests are refused (-32601). */
  onRequest?(id: string | number, method: string, params: Record<string, unknown> | undefined): boolean;
  onClose?(error: Error): void;
}

const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

export class JsonRpcConnection {
  private _id = 0;
  private _pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer?: ReturnType<typeof setTimeout> }>();
  private _stderr = "";
  private _closeError?: Error;
  readonly exited: Promise<number>;

  constructor(private readonly _proc: PipedSubprocess, private readonly _handlers: JsonRpcHandlers = {}) {
    this.exited = _proc.exited;
    void this._read();
    void this._readStderr();
    _proc.exited.then(code => this._close(new JsonRpcClosedError(`Native process exited (code ${code})${this._stderr.trim() ? `: ${this._stderr.trim().slice(-300)}` : ""}`)),
      () => this._close(new JsonRpcClosedError("Native process exit unobserved")));
  }

  get closed(): boolean { return this._closeError !== undefined; }
  get stderrTail(): string { return this._stderr.slice(-2_000); }

  request(method: string, params?: unknown, timeoutMs?: number): Promise<unknown> {
    if (this._closeError) return Promise.reject(this._closeError);
    const id = ++this._id;
    return new Promise((resolve, reject) => {
      const entry: { resolve(value: unknown): void; reject(error: Error): void; timer?: ReturnType<typeof setTimeout> } = { resolve, reject };
      if (timeoutMs !== undefined && timeoutMs > 0) entry.timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new JsonRpcTimeoutError(`${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this._pending.set(id, entry);
      try { this._write({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) }); }
      catch (error) { clearTimeout(entry.timer); this._pending.delete(id); reject(error as Error); }
    });
  }

  notify(method: string, params?: unknown): void {
    this._write({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) });
  }

  /** Kill the process. Pending requests reject once its exit is observed. */
  kill(): void {
    try { this._proc.stdin.end(); } catch { /* already closed */ }
    try { this._proc.kill(); } catch { /* already dead */ }
  }

  private _write(message: unknown): void {
    if (this._closeError) throw this._closeError;
    this._proc.stdin.write(JSON.stringify(message) + "\n");
    this._proc.stdin.flush();
  }

  private _close(error: Error): void {
    if (this._closeError) return;
    this._closeError = error;
    for (const entry of this._pending.values()) { clearTimeout(entry.timer); entry.reject(error); }
    this._pending.clear();
    try { this._handlers.onClose?.(error); } catch { /* observer */ }
  }

  private async _read(): Promise<void> {
    const reader = this._proc.stdout.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop()!;
        for (const line of lines) this._line(line);
      }
      this._line(buffer + decoder.decode());
      this._close(new JsonRpcClosedError(`Native stdout closed${this._stderr.trim() ? `: ${this._stderr.trim().slice(-300)}` : ""}`));
    } catch (error) {
      this._close(error instanceof Error ? error : new JsonRpcClosedError(String(error)));
    }
  }

  private async _readStderr(): Promise<void> {
    const reader = this._proc.stderr.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        this._stderr = (this._stderr + decoder.decode(value, { stream: true })).slice(-8_192);
      }
    } catch { /* diagnostics only */ }
  }

  private _line(line: string): void {
    if (!line.trim()) return;
    let message: Record<string, unknown> | undefined;
    try { message = object(JSON.parse(line)); } catch { return; }
    if (!message) return;
    const id = message.id, method = typeof message.method === "string" ? message.method : undefined;
    if (method && (typeof id === "string" || typeof id === "number")) {
      let answered = false;
      try { answered = this._handlers.onRequest?.(id, method, object(message.params)) === true; } catch { answered = false; }
      if (!answered) this.respondError(id, -32601, "Client interaction is unsupported by this adapter");
      return;
    }
    if (method) { try { this._handlers.onNotification?.(method, object(message.params)); } catch { /* observer */ } return; }
    if (typeof id !== "number") return;
    const entry = this._pending.get(id);
    if (!entry) return;
    this._pending.delete(id); clearTimeout(entry.timer);
    const error = object(message.error);
    if (error) entry.reject(new JsonRpcError(typeof error.code === "number" ? error.code : -32000, typeof error.message === "string" ? error.message : "JSON-RPC error"));
    else entry.resolve(message.result);
  }

  respondError(id: string | number, code: number, message: string): void {
    try { this._write({ jsonrpc: "2.0", id, error: { code, message } }); } catch { /* closing */ }
  }
}
