import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeCodeSession } from '../src/claude-code-session';
import { SessionDetached, SessionTurnError } from '../src/harness-session';
import { attachKeeper, type KeeperSubprocess, spawnThroughKeeper } from '../src/keeper/client';

// A Claude session through the real keeper process, with a stand-in stream-json CLI: the turn
// running at detach finishes while no session holds the CLI, and the rebuilt session settles it.

const FAKE_CLI = new URL('./fixtures/fake-stream-json-cli.ts', import.meta.url).pathname;
const dirs: string[] = [];
const sessions: ClaudeCodeSession[] = [];
afterEach(async () => {
  for (const session of sessions.splice(0)) session.kill();
  await Bun.sleep(100);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test('a turn running at detach finishes unwrapped and settles in the rebuilt session', async () => {
  const configDir = mkdtempSync(join(tmpdir(), 'kpi-'));
  dirs.push(configDir);
  let kept: KeeperSubprocess | undefined;
  const config = { cwd: configDir, model: 'haiku' };
  const first = new ClaudeCodeSession({
    ...config,
    spawn: (_cmd, opts) => {
      kept = spawnThroughKeeper([process.execPath, FAKE_CLI], opts, { configDir });
      return kept;
    },
  });
  sessions.push(first);
  await first.start();
  const running = first.send('slow:600 a long task');
  await Bun.sleep(150);

  const snapshot = await first.detach({ orphanDeadlineMs: 60_000 });
  const lost = await running.then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(lost).toBeInstanceOf(SessionTurnError);
  expect((lost as SessionTurnError).cause).toBeInstanceOf(SessionDetached);
  const admissionId = snapshot.inflight?.admissionId;
  expect(admissionId).toBeString();

  // The answer arrives while nothing is attached; the keeper holds it.
  await Bun.sleep(800);
  const handle = kept?.keeper;
  const again = await attachKeeper({
    socketPath: handle?.socketPath ?? '',
    token: handle?.token ?? '',
  });
  expect(again.pid).toBe(snapshot.cliPid as number);
  const second = ClaudeCodeSession.fromSnapshot(JSON.parse(JSON.stringify(snapshot)), config);
  sessions.push(second);
  second.resume(again);
  const adopted = await second.adoptedTurn;
  expect(adopted?.admissionId).toBe(admissionId);
  expect(adopted?.content).toStartWith('done: ');

  // And the same CLI takes the next message.
  const next = await second.send('one more');
  expect(next.content).toStartWith('done: ');
});
