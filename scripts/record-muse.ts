// Live re-recording of fixtures/muse/shell-approval.jsonl: one supervised turn on this machine's
// Muse login (two shell probes, every approval stage allowed), captured through MuseSession's own
// connect seam as the replay tests read it. Home and workspace paths and the account tier are scrubbed. Run it whenever
// the Muse pin moves, then update the recorded values tests/muse-session.test.ts asserts.
//
//   bun run record:muse

import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { MuseSession } from '../src';
import { spawnMuseHost } from '../src/muse-session';

const PROMPT =
  'Run these two shell commands: `echo probe-ok` then `curl -sI https://example.com | head -1`. Reply with both outputs only.';
const OUT = new URL('../fixtures/muse/shell-approval.jsonl', import.meta.url);

type Record_ =
  | { type: 'initialize' | 'start' | 'usage' | 'read'; result: unknown }
  | { type: 'notify'; frame: unknown };
const notifications: Record_[] = [];
const results = new Map<string, unknown>();
const RESULT_TYPES: Readonly<Record<string, 'start' | 'usage' | 'read'>> = {
  'session/start': 'start',
  'usage/read': 'usage',
  'session/read': 'read',
};

const workspace = realpathSync(mkdtempSync(join(tmpdir(), 'agent-session-muse-')));
const session = new MuseSession({
  cwd: workspace,
  effort: 'low',
  connect: async (launch) => {
    const host = await spawnMuseHost(launch);
    results.set('initialize', host.initializeResult);
    const { connection } = host;
    const onNotification = connection.onNotification.bind(connection);
    connection.onNotification = (handler) =>
      onNotification((notification) => {
        notifications.push({ type: 'notify', frame: notification });
        handler(notification);
      });
    const command = connection.command.bind(connection);
    connection.command = async (method, params, options) => {
      const result = await command(method, params, options);
      const type = RESULT_TYPES[method];
      // The last answer wins: session/read is asked again after the turn, as the fixture holds it.
      if (type) results.set(type, result);
      return result;
    };
    return host;
  },
});
session.onToolRequest(() => ({ behavior: 'allow' }));

try {
  await session.start();
  const done = await session.send(PROMPT);
  await session.readLimits();
  console.log(`outcome ${done.nativeOutcome}; content ${JSON.stringify(done.content)}`);
} finally {
  session.kill();
}

const ordered: Record_[] = [
  { type: 'initialize', result: results.get('initialize') },
  { type: 'start', result: results.get('start') },
  ...notifications,
  { type: 'usage', result: results.get('usage') },
  { type: 'read', result: results.get('read') },
];
const missing = ordered.filter((r) => 'result' in r && r.result === undefined).map((r) => r.type);
if (missing.length) throw new Error(`recording incomplete: no ${missing.join(', ')} answer`);
const scrub = (line: string) =>
  line
    .replaceAll(workspace, '/workspace')
    .replaceAll(homedir(), '/home/user')
    .replace(/"tier":"[^"]*"/g, '"tier":"tier-0"');
writeFileSync(OUT, `${ordered.map((r) => scrub(JSON.stringify(r))).join('\n')}\n`);
console.log(`wrote ${ordered.length} records to fixtures/muse/shell-approval.jsonl`);
