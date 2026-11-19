// A timeline of one in-session host's setup on this machine's Claude login (makes real calls).
//
//   bun scripts/diagnose-setup.ts [--roles 32] [--dispatchers 32] [--builders 6] [--model claude-haiku-5-5]
//     [--main <model>] [--deadline-ms 120000] [--context-kb 12] [--bin claude]
//
// Records every spawn the host's hook saw (who asked, which agent type, allowed or refused and
// why), every `next`/`moment`/`answer` call, every task start and end the CLI reported, and when
// each role was first held. Prints counts and the timeline's gaps, never prompts or answers.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeCodeSession, ClaudeInSessionDecisions, type PrimeSpec } from '../src';

const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback;
};
const roles = Number(arg('roles', '32'));
const dispatchers = Number(arg('dispatchers', String(roles)));
const builders = Number(arg('builders', '1'));
const model = arg('model', 'claude-haiku-5-5');
const main = arg('main', model);
const deadline = Number(arg('deadline-ms', '120000'));
const contextKb = Number(arg('context-kb', '12'));
const bin = arg('bin', 'claude');

const filler = (role: number) =>
  Array.from(
    { length: Math.ceil((contextKb * 1024) / 80) },
    (_, i) =>
      `- Rule ${role}.${i}: changes under src/area${i % 40}/ keep their public names stable.`,
  ).join('\n');
const specs: PrimeSpec[] = Array.from({ length: roles }, (_, i) => ({
  key: `warden-${i}`,
  instructions: `You are Warden ${i}. Your domain: area ${i}. Answer NO_COMMENT or one short finding.`,
  context: `## Domain cache (warden-${i})\n${filler(i)}\n`,
}));

const t0 = Date.now();
const at = () => Date.now() - t0;
type Row = { t: number; what: string; [k: string]: unknown };
const rows: Row[] = [];
const host = new ClaudeInSessionDecisions({
  model,
  effort: 'low',
  baseInstructions: 'You assess one moment for one narrow domain and answer NO_COMMENT.',
  setupDeadlineMs: deadline,
  dispatchers,
  builders,
  maxSubagents: roles * 6 + 2 * dispatchers + 2 * builders + 4,
  onSetup: (s) => rows.push({ t: at(), what: 'setup', status: s.status }),
  onEvent: (e) => {
    if (e.type !== 'standby') rows.push({ t: at(), what: `event:${e.type}` });
  },
});
// The host's own hook and MCP handler, wrapped: what each caller asked and what it was told.
const pre = host.preToolUse.bind(host);
host.preToolUse = (input) => {
  const out = pre(input);
  const tool = String(input.tool_name ?? '');
  const ti = (input.tool_input ?? {}) as Record<string, unknown>;
  rows.push({
    t: at(),
    what: 'hook',
    tool: tool.replace('mcp__foundry-wardens__', ''),
    by: input.agent_id ? 'agent' : 'main',
    type: ti.subagent_type,
    description: ti.description,
    background: ti.run_in_background,
    decision: (out as { permissionDecision?: string } | undefined)?.permissionDecision ?? 'none',
    reason: (out as { permissionDecisionReason?: string } | undefined)?.permissionDecisionReason,
  });
  return out;
};
const frame = host.frame.bind(host);
host.frame = (raw) => {
  if (raw.type === 'system' && typeof raw.subtype === 'string' && raw.subtype.startsWith('task_'))
    rows.push({ t: at(), what: raw.subtype, status: raw.status, kind: raw.subagent_type });
  if (raw.type === 'rate_limit_event')
    rows.push({ t: at(), what: 'rate_limit', info: raw.rate_limit_info });
  return frame(raw);
};

const cwd = mkdtempSync(join(tmpdir(), 'diagnose-setup-'));
const stderr: string[] = [];
const session = new ClaudeCodeSession({
  bin,
  model: main,
  cwd,
  maxTurns: null,
  permissionMode: 'bypassPermissions',
  persistSession: false,
});
session.onEvent((e) => {
  const raw = e.raw as Record<string, unknown> | undefined;
  if (raw?.type === 'result')
    rows.push({
      t: at(),
      what: 'main-result',
      text: String(raw.result ?? '').slice(0, 60),
      error: raw.is_error,
    });
  if (raw?.api_error_status)
    rows.push({ t: at(), what: 'api-error', status: raw.api_error_status });
});
session.extend(host);
const held: Array<{ t: number; held: number }> = [];
const sampler = setInterval(() => {
  const h = host.holding().held;
  if (held.at(-1)?.held !== h) held.push({ t: at(), held: h });
}, 250);
try {
  await session.start();
  host.prestart(
    't',
    specs.map((spec) => ({ spec, standby: '' })),
  );
  await host.ready(deadline + 5_000);
} finally {
  clearInterval(sampler);
  const count = (pred: (r: Row) => boolean) => rows.filter(pred).length;
  const spawns = (type: string, decision: string) =>
    count((r) => r.what === 'hook' && r.type === type && r.decision === decision);
  const first = (pred: (r: Row) => boolean) => rows.find(pred)?.t;
  const last = (pred: (r: Row) => boolean) => rows.filter(pred).at(-1)?.t;
  const reasons = new Map<string, number>();
  for (const r of rows)
    if (r.what === 'hook' && r.decision === 'deny')
      reasons.set(
        `${r.tool}/${r.type ?? ''}: ${r.reason}`,
        (reasons.get(`${r.tool}/${r.type ?? ''}: ${r.reason}`) ?? 0) + 1,
      );
  console.log(
    JSON.stringify(
      {
        config: { roles, dispatchers, builders, model, main },
        status: host.setup.status,
        holding: host.holding(),
        capacity: host.snapshot().capacity,
        builderSpawns: {
          allowed: spawns('foundry-root', 'allow'),
          denied: spawns('foundry-root', 'deny'),
        },
        dispatcherSpawns: {
          allowed: spawns('foundry-dispatch', 'allow'),
          denied: spawns('foundry-dispatch', 'deny'),
        },
        wardenSpawns: {
          allowed: spawns('foundry-warden', 'allow'),
          denied: spawns('foundry-warden', 'deny'),
        },
        nextCalls: count((r) => r.what === 'hook' && r.tool === 'next'),
        momentCalls: count((r) => r.what === 'hook' && r.tool === 'moment'),
        otherToolCalls: rows
          .filter(
            (r) =>
              r.what === 'hook' &&
              !['Agent', 'Task', 'next', 'moment', 'answer'].includes(String(r.tool)),
          )
          .map((r) => `${r.by}:${r.tool}:${r.decision}`)
          .slice(0, 12),
        denyReasons: Object.fromEntries(reasons),
        builderAsks: rows
          .filter((r) => r.what === 'hook' && r.type === 'foundry-root')
          .map(
            (r) =>
              `${r.t} by=${r.by} desc=${JSON.stringify(r.description)} bg=${r.background} -> ${r.decision}`,
          ),
        taskStarted: count((r) => r.what === 'task_started'),
        taskEnded: rows
          .filter((r) => r.what === 'task_notification')
          .reduce<Record<string, number>>((by, r) => {
            const k = String(r.status);
            by[k] = (by[k] ?? 0) + 1;
            return by;
          }, {}),
        firstTaskEndedAtMs: first((r) => r.what === 'task_notification'),
        timesMs: {
          firstBuilderSpawn: first((r) => r.what === 'hook' && r.type === 'foundry-root'),
          lastBuilderSpawn: last((r) => r.what === 'hook' && r.type === 'foundry-root'),
          firstDispatcherSpawn: first((r) => r.what === 'hook' && r.type === 'foundry-dispatch'),
          lastDispatcherSpawn: last((r) => r.what === 'hook' && r.type === 'foundry-dispatch'),
          firstWardenSpawn: first((r) => r.what === 'hook' && r.type === 'foundry-warden'),
          lastWardenSpawn: last((r) => r.what === 'hook' && r.type === 'foundry-warden'),
          firstMoment: first((r) => r.what === 'hook' && r.tool === 'moment'),
          lastMoment: last((r) => r.what === 'hook' && r.tool === 'moment'),
        },
        heldOverTime: held,
        mainResults: rows.filter((r) => r.what === 'main-result').map((r) => `${r.t}:${r.text}`),
        rateLimits: rows
          .filter((r) => r.what === 'rate_limit' || r.what === 'api-error')
          .slice(0, 5),
        events: rows
          .filter((r) => r.what.startsWith('event:'))
          .reduce<Record<string, number>>((by, r) => {
            by[r.what] = (by[r.what] ?? 0) + 1;
            return by;
          }, {}),
        stderrTail: stderr.join('').slice(-400),
      },
      null,
      1,
    ),
  );
  await host.close().catch(() => undefined);
  session.kill();
}
process.exit(0);
