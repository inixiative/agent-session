// Live check of ClaudeSubagentSessions on this machine's Claude login (makes real, small calls).
//
//   bun scripts/measure-subagents.ts [--roles 3] [--hold-ms 180000] [--bin <claude>] [--max-members 12] [--spares 2]
//
// For N synthetic roles on one group it measures:
//   - a fan-out (no spare): wall time to every answer, inputs byte-identical, outputs verbatim;
//   - pre-start: time until every role holds its moment call, and the tokens one standby turn costs;
//   - a trigger served by spares: wall time to every answer, moment inputs only the turn;
//   - a held moment survives --hold-ms (MCP_TOOL_TIMEOUT), then still answers;
//   - new standby context retires the old spares (interrupt) and pre-starts again; rewind works;
//   - the side session's resident memory.
// Prints numbers only, never prompts or answers.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeSubagentSessions, type PrimedEvent } from '../src';

const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1]! : fallback;
};
const roles = Number(arg('roles', '3'));
const holdMs = Number(arg('hold-ms', '180000'));
const bin = arg('bin', 'claude');
const maxMembers = Number(arg('max-members', '12'));
const sparesPerRole = Number(arg('spares', '2'));
const cwd = mkdtempSync(join(tmpdir(), 'measure-subagents-'));

const events: PrimedEvent[] = [];
const spawned: number[] = [];
const host = new ClaudeSubagentSessions({
  bin,
  model: 'claude-haiku-5-5',
  effort: 'low',
  cwd,
  baseInstructions:
    'You assess one moment for one narrow domain and answer NO_COMMENT unless the moment breaks a rule below.',
  timeoutMs: 30_000,
  maxMembers,
  sparesPerRole,
  spawn: (argv, options) => {
    const child = Bun.spawn([...argv, '--setting-sources', ''], {
      ...options,
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    spawned.push(child.pid);
    return child as never;
  },
  onEvent: (e) => events.push(e),
});
const rss = () =>
  spawned.reduce((mb, pid) => {
    const out = Bun.spawnSync(['/bin/ps', '-o', 'rss=', '-p', String(pid)])
      .stdout.toString()
      .trim();
    return mb + (out ? Number(out) / 1024 : 0);
  }, 0);
const specs = Array.from({ length: roles }, (_, i) => ({
  key: `role-${i}`,
  instructions: `You are role ${i}. Your domain: rule ${i}.`,
  context: `## Domain cache (role-${i})\n- Rule ${i}: never rename public settings keys.\n`,
}));
const moment = (n: number) =>
  `\n## Message\nPlease rename button ${n}.\n\nAnswer NO_COMMENT or one short finding.`;
const all = async (standby: string | undefined, tag: string) => {
  const t = performance.now();
  const results = await Promise.all(
    specs.map((spec, i) =>
      host.decide(spec, { input: moment(i), group: 'G', ...(standby ? { standby } : {}) }).then(
        (r) => ({ ok: true, tokens: r.tokens }),
        (e) => ({ ok: false, error: String(e.message) }),
      ),
    ),
  );
  return {
    tag,
    wallMs: Math.round(performance.now() - t),
    answered: results.filter((r) => r.ok).length,
    errors: results.flatMap((r) => ('error' in r ? [r.error] : [])),
    cacheRead: results.reduce((n, r) => n + ('tokens' in r ? (r.tokens?.cacheRead ?? 0) : 0), 0),
  };
};
const report: Record<string, unknown> = { roles };
try {
  report.fanOut = await all(undefined, 'fan-out (no spare)');
  const standby1 = '\n## Thread state\nstate v1\n';
  let t = performance.now();
  host.prestart(
    'G',
    specs.map((spec) => ({ spec, standby: standby1 })),
  );
  // Held when the snapshot shows no member in flight and the spares are dispatched; give it a bounded wait.
  await Bun.sleep(8_000);
  report.prestartMs = Math.round(performance.now() - t);
  report.rssAfterPrestartMb = Math.round(rss());
  report.served = await all(standby1, 'trigger served by spares');
  await Bun.sleep(8_000); // consumed spares are pre-started again
  report.heldFor = holdMs;
  await Bun.sleep(holdMs);
  report.servedAfterHold = await all(standby1, `trigger after holding ${holdMs} ms`);
  const standby2 = '\n## Thread state\nstate v2\n';
  t = performance.now();
  host.prestart(
    'G',
    specs.map((spec) => ({ spec, standby: standby2 })),
  );
  await Bun.sleep(8_000);
  report.refreshMs = Math.round(performance.now() - t);
  report.servedAfterRefresh = await all(standby2, 'trigger after refresh');
  report.rssEndMb = Math.round(rss());
  report.events = Object.fromEntries(
    ['process-started', 'process-recycled', 'violation', 'decision', 'standby'].map((type) => [
      type,
      events.filter((e) => e.type === type).length,
    ]),
  );
  report.recycled = events.flatMap((e) => (e.type === 'process-recycled' ? [e.reason] : []));
  // What one Warden's pre-start costs (per standby turn; a landed turn pre-starts every Warden once).
  const standby = events.flatMap((e) => (e.type === 'standby' ? [e] : []));
  report.standbyPerWarden = standby.length
    ? {
        turns: standby.length,
        input: Math.round(standby.reduce((n, e) => n + e.input, 0) / standby.length),
        output: Math.round(standby.reduce((n, e) => n + e.output, 0) / standby.length),
        cacheRead: Math.round(standby.reduce((n, e) => n + e.cacheRead, 0) / standby.length),
        cacheWrite: Math.round(standby.reduce((n, e) => n + e.cacheWrite, 0) / standby.length),
      }
    : undefined;
} finally {
  await host.close();
}
console.log(JSON.stringify(report, null, 1));
