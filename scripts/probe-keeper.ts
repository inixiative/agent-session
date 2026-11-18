// Live probe: a real Claude Code CLI kept across a host restart by the keeper. Uses the
// machine's own Claude login (~/.claude), model haiku. Prints outcomes and timings only.
//
//   bun scripts/probe-keeper.ts [--away 20000]
//
// 1. A turn running at detach finishes while nothing is attached and settles in the rebuilt
//    session under its admission id.
// 2. An approval asked and unanswered at detach holds the CLI's call while nothing is attached;
//    the rebuilt session asks its gate again, and the allowed call runs.

import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  attachKeeper,
  ClaudeCodeSession,
  type ClaudeCodeSessionConfig,
  type KeeperSubprocess,
  spawnThroughKeeper,
} from '../src';

const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback;
};
const awayMs = Number(arg('away', '20000'));
const until = async (check: () => boolean, withinMs: number, what: string) => {
  const end = Date.now() + withinMs;
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(100);
  }
};

async function probe(
  name: string,
  config: ClaudeCodeSessionConfig,
  prompt: string,
  setup: (first: ClaudeCodeSession) => () => boolean,
  rebuilt: (second: ClaudeCodeSession) => void,
  expectIn: string,
) {
  const dir = mkdtempSync(join(tmpdir(), 'agent-session-keeper-probe-'));
  chmodSync(dir, 0o700);
  let kept: KeeperSubprocess | undefined;
  const base: ClaudeCodeSessionConfig = { cwd: dir, model: 'haiku', ...config };
  const first = new ClaudeCodeSession({
    ...base,
    spawn: (cmd, opts) => {
      kept = spawnThroughKeeper(cmd, opts, { configDir: dir });
      return kept;
    },
  });
  const started = performance.now();
  let second: ClaudeCodeSession | undefined;
  try {
    const readyToDetach = setup(first);
    await first.start();
    const running = first.send(prompt);
    running.catch(() => {});
    await until(readyToDetach, 120_000, 'the moment to detach');
    const snapshot = await first.detach({ orphanDeadlineMs: awayMs + 60_000 });
    const detachedAt = performance.now();
    await Bun.sleep(awayMs);
    const again = await attachKeeper({
      socketPath: kept?.keeper?.socketPath ?? '',
      token: kept?.keeper?.token ?? '',
    });
    second = ClaudeCodeSession.fromSnapshot(snapshot, base);
    rebuilt(second);
    second.resume(again);
    const adopted = await second.adoptedTurn;
    const ok =
      adopted?.admissionId === snapshot.inflight?.admissionId &&
      adopted?.nativeOutcome === 'completed' &&
      adopted.content.includes(expectIn);
    console.log(
      JSON.stringify({
        probe: name,
        ok,
        cliPid: snapshot.cliPid,
        sameCli: again.pid === snapshot.cliPid,
        waitingAtAttach: again.keeper?.waiting,
        awayMs,
        detachAfterMs: Math.round(detachedAt - started),
        settleAfterAttachMs: Math.round(performance.now() - detachedAt - awayMs),
        nativeOutcome: adopted?.nativeOutcome,
      }),
    );
    return ok;
  } catch (error) {
    console.log(JSON.stringify({ probe: name, ok: false, error: (error as Error).message }));
    return false;
  } finally {
    second?.kill();
    first.kill();
    await Bun.sleep(500);
    rmSync(dir, { recursive: true, force: true });
  }
}

const marker = `kept-${Date.now().toString(36)}`;
const turn = await probe(
  'turn-survives',
  {},
  `Run this bash command: sleep 8; echo ${marker}. Then reply with only its output.`,
  (first) => {
    let toolStarted = false;
    first.onEvent((event) => {
      if (event.kind === 'tool_use') toolStarted = true;
    });
    return () => toolStarted;
  },
  () => {},
  marker,
);

const approval = await probe(
  'approval-held',
  { toolGate: true, permissionMode: 'default' },
  `Run this bash command: echo ${marker}. Then reply with only its output.`,
  (first) => {
    let asked = false;
    first.onToolRequest(() => {
      asked = true;
      return new Promise(() => {}); // nobody answers before the restart
    });
    return () => asked;
  },
  (second) => second.onToolRequest(() => ({ behavior: 'allow' })),
  marker,
);

process.exit(turn && approval ? 0 : 1);
