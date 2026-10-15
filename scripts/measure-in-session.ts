// Live comparison of Warden runtimes on this machine's Claude login (makes real calls).
//
//   bun scripts/measure-in-session.ts --mode in-session|primed [--threads 1] [--roles 23]
//     [--rounds 5] [--main claude-opus-5-5] [--subagent] [--context-kb 12] [--bin claude]
//
// Per main thread: one Claude Code main session (the executor) and `--roles` synthetic Wardens.
//   in-session  the Wardens are subagents held inside the main session's own process
//               (ClaudeInSessionDecisions): one process per thread.
//   primed      today's runtime: a primed Claude session per Warden key (ClaudePrimedSessions),
//               shared by every thread, sized as Foundry sizes it (max(16, 2 × roles + 8)).
// Measures setup (to every Warden held), per-call latency of full fan-outs (every Warden at once,
// all threads together), and resident memory of every process tree involved, idle and with a
// subagent running in each main thread. Prints numbers only, never prompts or answers.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ClaudeCodeSession,
  ClaudeInSessionDecisions,
  ClaudePrimedSessions,
  type PrimeSpec,
} from '../src';

const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback;
};
const mode = arg('mode', 'in-session') as 'in-session' | 'primed';
const threads = Number(arg('threads', '1'));
const roles = Number(arg('roles', '23'));
const rounds = Number(arg('rounds', '5'));
const mainModel = arg('main', 'claude-opus-5-5');
const contextKb = Number(arg('context-kb', '12'));
const withSubagent = process.argv.includes('--subagent');
const bin = arg('bin', 'claude');
const WARDEN = 'claude-haiku-5-5';
const BASE =
  'You assess one moment for one narrow domain and answer NO_COMMENT unless the moment breaks a rule below.';

const load = () => Bun.spawnSync(['/usr/sbin/sysctl', '-n', 'vm.loadavg']).stdout.toString().trim();

/** RSS (MB) of each pid's whole process tree. */
function treeRss(pids: number[]): number {
  const out = Bun.spawnSync(['/bin/ps', '-A', '-o', 'pid=,ppid=,rss=']).stdout.toString();
  const rows = out
    .trim()
    .split('\n')
    .map((l) => l.trim().split(/\s+/).map(Number) as [number, number, number]);
  const children = new Map<number, number[]>();
  for (const [pid, ppid] of rows) children.set(ppid, [...(children.get(ppid) ?? []), pid]);
  const rss = new Map(rows.map(([pid, , kb]) => [pid, kb]));
  let total = 0;
  const seen = new Set<number>();
  const walk = (pid: number) => {
    if (seen.has(pid)) return;
    seen.add(pid);
    total += rss.get(pid) ?? 0;
    for (const c of children.get(pid) ?? []) walk(c);
  };
  for (const pid of pids) walk(pid);
  return Math.round(total / 1024);
}

const filler = (role: number) =>
  Array.from(
    { length: Math.ceil((contextKb * 1024) / 90) },
    (_, i) =>
      `- Rule ${role}.${i}: changes under src/area${i % 40}/ keep their public names stable.`,
  ).join('\n');
const specs: PrimeSpec[] = Array.from({ length: roles }, (_, i) => ({
  key: `warden-${i}`,
  instructions: `You are Warden ${i}. Your domain: area ${i}. Answer NO_COMMENT or one short finding.`,
  context: `## Domain cache (warden-${i})\n${filler(i)}\n`,
}));
const standby = '\n## Your understanding of this thread\nNothing yet.\n';
const moment = (t: number, i: number, round: number) =>
  `\n## Message\nThread ${t}, round ${round}: please rename the settings button ${i}.\n`;

const pcts = (values: number[]) => {
  const s = [...values].sort((a, b) => a - b);
  const at = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? 0;
  return { n: s.length, p50: at(0.5), p95: at(0.95), max: s.at(-1) ?? 0 };
};

const pids: number[] = [];
const spawn = (
  argv: string[],
  options: { cwd: string; env: Record<string, string | undefined> },
) => {
  const child = Bun.spawn(argv, { ...options, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
  pids.push(child.pid);
  return child as never;
};

const report: Record<string, unknown> = {
  mode,
  threads,
  roles,
  rounds,
  mainModel,
  contextKb,
  loadBefore: load(),
};
const mains: ClaudeCodeSession[] = [];
const unsolicited: number[] = Array.from({ length: threads }, () => 0);
const hosts: ClaudeInSessionDecisions[] = [];
let primed: ClaudePrimedSessions | undefined;
const t0 = performance.now();
try {
  for (let t = 0; t < threads; t++) {
    const cwd = mkdtempSync(join(tmpdir(), 'measure-in-session-'));
    const session = new ClaudeCodeSession({
      bin,
      model: mainModel,
      cwd,
      maxTurns: null,
      permissionMode: 'bypassPermissions',
      persistSession: false,
      spawn,
    });
    if (mode === 'in-session') {
      const host = new ClaudeInSessionDecisions({
        model: WARDEN,
        effort: 'low',
        baseInstructions: BASE,
        setupDeadlineMs: 120_000,
      });
      session.extend(host);
      hosts.push(host);
    }
    session.onEvent((e) => {
      const raw = e.raw as { type?: string } | undefined;
      if (e.unattributedReason === 'no-admission' && raw?.type === 'result') unsolicited[t]!++;
    });
    mains.push(session);
  }
  await Promise.all(mains.map((s) => s.start()));
  if (mode === 'in-session') {
    hosts.forEach((h, t) => {
      h.prestart(
        `t${t}`,
        specs.map((spec) => ({ spec, standby })),
      );
    });
    const setup = await Promise.all(
      hosts.map(async (h) => {
        await h.ready(120_000);
        return {
          status: h.setup.status,
          ms: (h.setup.readyAt ?? Date.now()) - h.setup.startedAt,
          fromRootMs: h.setup.rootStartedAt
            ? (h.setup.readyAt ?? Date.now()) - h.setup.rootStartedAt
            : null,
          ...h.holding(),
        };
      }),
    );
    report.setup = setup;
  } else {
    primed = new ClaudePrimedSessions({
      bin,
      model: WARDEN,
      effort: 'low',
      cwd: mkdtempSync(join(tmpdir(), 'measure-primed-')),
      baseInstructions: BASE,
      maxConcurrent: 16,
      maxSessions: Math.max(16, 2 * roles + 8),
      timeoutMs: 30_000,
      spawn: (argv, options) => spawn([...argv, '--setting-sources', ''], options),
    });
    // Setup for primed: the main sessions answer one turn (their process is up), keys prime on first use.
    const st = performance.now();
    await Promise.all(mains.map((s) => s.send('Reply with exactly OK.')));
    report.setup = {
      mainFirstTurnMs: Math.round(performance.now() - st),
      note: 'primed keys prime on first decision',
    };
  }
  report.setupWallMs = Math.round(performance.now() - t0);
  report.rssIdleMb = treeRss(pids);

  const latencies: number[] = [];
  const cold: number[] = [];
  const failures: string[] = [];
  const roundWall: number[] = [];
  for (let round = 0; round < rounds; round++) {
    if (mode === 'in-session') {
      const end = Date.now() + 60_000;
      while (hosts.some((h) => h.holding().held < roles) && Date.now() < end) await Bun.sleep(100);
    }
    const rs = performance.now();
    await Promise.all(
      mains.flatMap((_, t) =>
        specs.map(async (spec, i) => {
          const start = performance.now();
          try {
            const r =
              mode === 'in-session'
                ? await hosts[t]!.decide(spec, {
                    input: moment(t, i, round),
                    standby,
                    timeoutMs: 30_000,
                  })
                : await primed!.decide(
                    { ...spec, key: `t${t}:${spec.key}` },
                    { input: `${standby}${moment(t, i, round)}`, timeoutMs: 30_000 },
                  );
            (r.prime === 'warm' ? latencies : cold).push(Math.round(performance.now() - start));
          } catch (e) {
            failures.push(String((e as Error).message).slice(0, 80));
          }
        }),
      ),
    );
    roundWall.push(Math.round(performance.now() - rs));
  }
  report.fanOut = {
    warm: pcts(latencies),
    cold: pcts(cold),
    roundWallMs: roundWall,
    failures: failures.length,
    failureSample: [...new Set(failures)].slice(0, 3),
  };
  report.rssAfterFanOutsMb = treeRss(pids);

  if (withSubagent) {
    const runs = mains.map((s) =>
      s
        .send(
          'Use the Agent tool once (subagent_type "general-purpose") with this task: "Run the shell command `sleep 45` with the Bash tool, then reply DONE." Wait for it, then reply with exactly FINISHED.',
          { timeout: 0 },
        )
        .catch(() => undefined),
    );
    await Bun.sleep(25_000);
    report.rssWithSubagentMb = treeRss(pids);
    // A fan-out while the subagents run.
    const during: number[] = [];
    await Promise.all(
      mains.flatMap((_, t) =>
        specs.map(async (spec, i) => {
          const start = performance.now();
          try {
            if (mode === 'in-session')
              await hosts[t]!.decide(spec, { input: moment(t, i, 99), standby, timeoutMs: 30_000 });
            else
              await primed!.decide(
                { ...spec, key: `t${t}:${spec.key}` },
                { input: `${standby}${moment(t, i, 99)}`, timeoutMs: 30_000 },
              );
            during.push(Math.round(performance.now() - start));
          } catch {
            /* counted by absence */
          }
        }),
      ),
    );
    report.fanOutDuringSubagent = pcts(during);
    await Promise.all(runs);
  }
  report.mainTurns = mains.map((s) => s.turns);
  report.unsolicitedMainTurns = unsolicited;
  report.processes = pids.length;
  report.loadAfter = load();
} finally {
  await Promise.all(hosts.map((h) => h.close()));
  await primed?.close();
  for (const s of mains) s.kill();
}
console.log(JSON.stringify(report, null, 1));
process.exit(0);
