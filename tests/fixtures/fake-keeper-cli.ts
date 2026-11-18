/**
 * A stand-in CLI for the keeper tests. Reads stdin lines:
 *   `echo:<text>`   prints <text>
 *   `err:<text>`    prints <text> on stderr
 *   `later:<ms>:<text>` prints <text> after <ms>
 *   `gate:<id>`     prints a `can_use_tool` control request with request id <id>
 *   `flood:<n>`     prints n numbered lines
 *   `exit:<code>`   exits with <code>
 *   `stubborn`      keeps running after stdin ends, until a signal
 * Exits 0 when stdin ends, unless `stubborn`.
 */
const decoder = new TextDecoder();
let buffer = '';
const print = (text: string) => process.stdout.write(`${text}\n`);
let stubborn = false;
for await (const chunk of Bun.stdin.stream()) {
  buffer += decoder.decode(chunk, { stream: true });
  const lines = buffer.split('\n');
  buffer = lines.pop() ?? '';
  for (const line of lines) {
    const [verb, ...rest] = line.split(':');
    const arg = rest.join(':');
    if (verb === 'echo') print(arg);
    else if (verb === 'err') process.stderr.write(`${arg}\n`);
    else if (verb === 'later') {
      const [ms, ...text] = arg.split(':');
      setTimeout(() => print(text.join(':')), Number(ms));
    } else if (verb === 'gate')
      print(
        JSON.stringify({
          type: 'control_request',
          request_id: arg,
          request: { subtype: 'can_use_tool', tool_name: 'Bash' },
        }),
      );
    else if (verb === 'flood')
      for (let i = 1; i <= Number(arg); i++) print(`line ${i} ${'x'.repeat(64)}`);
    else if (verb === 'exit') process.exit(Number(arg));
    else if (verb === 'stubborn') stubborn = true;
  }
}
if (stubborn) setInterval(() => {}, 1_000);
else process.exit(0);
