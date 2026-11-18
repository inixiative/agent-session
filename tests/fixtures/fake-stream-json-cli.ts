/**
 * A stand-in `claude` CLI speaking stream-json, for running a session through the real keeper.
 * Answers `initialize`; each user message starts a turn that answers `done: <text>` after the
 * delay named in it (`slow:<ms>`, else at once). Exits 0 when stdin ends.
 */
const SESSION = 'kept-through-keeper';
const decoder = new TextDecoder();
let buffer = '';
const print = (frame: Record<string, unknown>) =>
  process.stdout.write(`${JSON.stringify(frame)}\n`);
for await (const chunk of Bun.stdin.stream()) {
  buffer += decoder.decode(chunk, { stream: true });
  const lines = buffer.split('\n');
  buffer = lines.pop() ?? '';
  for (const line of lines) {
    if (!line.trim()) continue;
    const message = JSON.parse(line) as {
      type?: string;
      request_id?: string;
      request?: { subtype?: string };
      message?: unknown;
    };
    if (message.type === 'control_request' && message.request?.subtype === 'initialize') {
      print({
        type: 'control_response',
        response: { subtype: 'success', request_id: message.request_id, response: {} },
      });
      continue;
    }
    if (message.type !== 'user') continue;
    const text = JSON.stringify(message.message);
    const delay = Number(/slow:(\d+)/.exec(text)?.[1] ?? 0);
    print({ type: 'system', subtype: 'init', session_id: SESSION });
    print({
      type: 'assistant',
      session_id: SESSION,
      message: { role: 'assistant', content: [{ type: 'text', text: 'working' }] },
    });
    setTimeout(
      () =>
        print({
          type: 'result',
          subtype: 'success',
          result: `done: ${text.length}`,
          session_id: SESSION,
          uuid: crypto.randomUUID(),
        }),
      delay,
    );
  }
}
process.exit(0);
