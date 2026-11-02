import { afterEach, describe, expect, test } from 'bun:test';
import {
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  isPrivatePath,
  parseScratchRef,
  privatePathDenial,
  privatePathGate,
  SecretScratchError,
  SecretScratchPad,
} from '../src';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'scratch-'));
  dirs.push(dir);
  return dir;
};
const setup = () => {
  const root = tempDir();
  return { root, pad: new SecretScratchPad(join(root, '.private', 'scratch')) };
};

describe('lift', () => {
  test('replaces each $$word with a reference and accumulates a dagger per message', async () => {
    const { root, pad } = setup();
    const first = await pad.lift('use $$ghp_abc123 and $$rw_xyz now', {
      thread: 'thr_1',
      message: 'turn_a',
    });
    expect(first.text).toBe('use †turn_a.1 and †turn_a.2 now');
    expect(first.refs).toEqual(['†turn_a.1', '†turn_a.2']);
    await pad.lift('$$second-secret', { thread: 'thr_1', message: 'turn_b' });
    const file = readFileSync(join(root, '.private', 'scratch', 'thr_1.pad'), 'utf8');
    expect(file).toContain('†turn_a (');
    expect(file).toContain('[1] "ghp_abc123"');
    expect(file).toContain('[2] "rw_xyz"');
    expect(file).toContain('\n\n†turn_b (');
    expect(statSync(join(root, '.private', 'scratch', 'thr_1.pad')).mode & 0o777).toBe(0o600);
    const [summary] = await pad.list('thr_1');
    expect(summary?.daggers.map((d) => [d.message, d.positions])).toEqual([
      ['turn_a', [1, 2]],
      ['turn_b', [1]],
    ]);
    expect(JSON.stringify(await pad.list())).not.toContain('ghp_abc123');
  });

  test('leaves text without a marker alone and writes nothing', async () => {
    const { pad } = setup();
    expect(await pad.lift('costs $5 and $$ alone', { thread: 't', message: 'm' })).toEqual({
      text: 'costs $5 and $$ alone',
      refs: [],
    });
    expect(await pad.threads()).toEqual([]);
  });

  test('a mid-word $$ is not a marker', async () => {
    const { pad } = setup();
    const out = await pad.lift('a$$b $$c', { thread: 't', message: 'm' });
    expect(out.text).toBe('a$$b †m.1');
  });
});

describe('use', () => {
  test('env sets KEY in an env file, replacing its line; consume removes the block, then the dagger', async () => {
    const { root, pad } = setup();
    await pad.lift('$$tok-1 $$tok-2', { thread: 't', message: 'm' });
    writeFileSync(join(root, '.env.local'), 'A=1\nTOKEN=old\n');
    await pad.env('†m.1', 't', '.env.local', 'TOKEN', { cwd: root, consume: true });
    expect(readFileSync(join(root, '.env.local'), 'utf8')).toBe('A=1\nTOKEN=tok-1\n');
    expect((await pad.list('t'))[0]?.daggers[0]?.positions).toEqual([2]);
    await pad.env('m.2', 't', '.env.local', 'MULTI', { cwd: root });
    await pad.consume('†m.2', 't');
    expect(await pad.list('t')).toEqual([]);
    expect(await pad.threads()).toEqual([]);
  });

  test('env quotes a value that needs it, and pipe reads it back from the env file', async () => {
    const { root, pad } = setup();
    await pad.lift('$$-----BEGIN\\nKEY', { thread: 't', message: 'm' });
    // a value with a real newline, as a pasted key would carry after JSON round-trip
    await pad.env('m.1', 't', 'keys.env', 'K', { cwd: root });
    const out = join(root, 'out.txt');
    const { exitCode } = await pad.pipe({ envFile: 'keys.env', key: 'K' }, 't', `cat > ${out}`, {
      cwd: root,
    });
    expect(exitCode).toBe(0);
    expect(readFileSync(out, 'utf8')).toBe('-----BEGIN\\nKEY');
  });

  test('pipe runs the command with the value on stdin and returns only the exit code', async () => {
    const { root, pad } = setup();
    await pad.lift('$$s3cr3t-value', { thread: 't', message: 'm' });
    const out = join(root, 'piped');
    expect(await pad.pipe({ ref: '†m.1' }, 't', `cat > ${out}; echo loud`, { cwd: root })).toEqual({
      exitCode: 0,
    });
    expect(readFileSync(out, 'utf8')).toBe('s3cr3t-value');
    expect(await pad.pipe({ ref: '†m.1' }, 't', 'exit 3', { consume: true })).toEqual({
      exitCode: 3,
    });
    expect((await pad.list('t'))[0]?.daggers[0]?.positions).toEqual([1]);
  });

  test('write replaces exactly or appends on its own line; a new file is 0600', async () => {
    const { root, pad } = setup();
    await pad.lift('$$abc-123', { thread: 't', message: 'm' });
    await pad.write('m.1', 't', 'key.txt', { cwd: root });
    expect(readFileSync(join(root, 'key.txt'), 'utf8')).toBe('abc-123');
    expect(statSync(join(root, 'key.txt')).mode & 0o777).toBe(0o600);
    await pad.write('m.1', 't', 'key.txt', { cwd: root, mode: 'append' });
    expect(readFileSync(join(root, 'key.txt'), 'utf8')).toBe('abc-123\nabc-123\n');
  });

  test('a symlinked env file stays a link', async () => {
    const { root, pad } = setup();
    await pad.lift('$$abc-123', { thread: 't', message: 'm' });
    writeFileSync(join(root, 'real.env'), '');
    symlinkSync(join(root, 'real.env'), join(root, '.env'));
    await pad.env('m.1', 't', '.env', 'K', { cwd: root });
    expect(lstatSync(join(root, '.env')).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(root, 'real.env'), 'utf8')).toBe('K=abc-123\n');
  });

  test('another thread is reached with the full reference', async () => {
    const { root, pad } = setup();
    await pad.lift('$$left-over', { thread: 'old_thread', message: 'm' });
    await pad.write('†old_thread/m.1', 'new_thread', 'f', { cwd: root, consume: true });
    expect(readFileSync(join(root, 'f'), 'utf8')).toBe('left-over');
    expect(await pad.threads()).toEqual([]);
  });

  test('errors name the reference, never a value', () => {
    const { pad } = setup();
    pad.lift('$$super-secret-value', { thread: 't', message: 'm' });
    const thrown = (act: () => unknown) => {
      try {
        act();
      } catch (error) {
        return error as Error;
      }
      throw Error('expected a throw');
    };
    const missing = thrown(() => pad.write('m.9', 't', '/nonexistent/x'));
    expect(missing).toBeInstanceOf(SecretScratchError);
    expect(missing.message).toContain('m.9');
    const failed = thrown(() => pad.write('m.1', 't', '/nonexistent/dir/x'));
    expect(failed.message).not.toContain('super-secret-value');
    expect(() => parseScratchRef('../etc/passwd.1', 't')).toThrow(SecretScratchError);
  });

  test('a lift made while a pipe runs is kept when the pipe consumes', async () => {
    const { pad } = setup();
    pad.lift('$$first-one', { thread: 't', message: 'm' });
    const running = pad.pipe({ ref: 'm.1' }, 't', 'sleep 0.2; cat > /dev/null', { consume: true });
    pad.lift('$$second-one', { thread: 't', message: 'n' });
    expect(await running).toEqual({ exitCode: 0 });
    expect(pad.list('t')[0]?.daggers.map((d) => d.message)).toEqual(['n']);
  });

  test('a CRLF env file keeps its line endings', () => {
    const { root, pad } = setup();
    pad.lift('$$abc-123', { thread: 't', message: 'm' });
    writeFileSync(join(root, 'w.env'), 'A=1\r\n');
    pad.env('m.1', 't', 'w.env', 'B', { cwd: root });
    expect(readFileSync(join(root, 'w.env'), 'utf8')).toBe('A=1\r\nB=abc-123\r\n');
  });

  test('scrub replaces held values with their references', async () => {
    const { pad } = setup();
    await pad.lift('$$ghp_abcdef $$ab', { thread: 't', message: 'm' });
    expect(await pad.scrub('t', 'token ghp_abcdef here, ab stays')).toBe(
      'token †m.1 here, ab stays',
    );
  });

  test('clear deletes a pad', async () => {
    const { pad } = setup();
    await pad.lift('$$abc-123', { thread: 't', message: 'm' });
    await pad.clear('t');
    expect(await pad.threads()).toEqual([]);
  });
});

describe('review fixes', () => {
  test('a file the tool wrote is off limits to read, and is used through pipe', async () => {
    const { root, pad } = setup();
    pad.lift('$$tok-12345', { thread: 't', message: 'm' });
    pad.env('m.1', 't', '.env.local', 'TOKEN', { cwd: root, consume: true });
    const heldFiles = pad.heldFiles();
    expect(heldFiles).toEqual([join(root, '.env.local')]);
    const deny = (input: Record<string, unknown>) =>
      privatePathDenial({ toolName: 'X', toolInput: input }, { heldFiles });
    expect(deny({ file_path: join(root, '.env.local') })).toBeDefined();
    expect(deny({ command: 'cat .env.local' })).toBeDefined();
    expect(deny({ command: 'cat ./.env.local' })).toBeDefined();
    expect(deny({ command: 'cat .env.example' })).toBeUndefined();
    const out = join(root, 'o');
    await pad.pipe({ envFile: '.env.local', key: 'TOKEN' }, 't', `cat > ${out}`, { cwd: root });
    expect(readFileSync(out, 'utf8')).toBe('tok-12345');
  });

  test('a value with $ is single-quoted, and quoted values with comments read back', async () => {
    const { root, pad } = setup();
    pad.lift('$$pa$word $$it\'s"x', { thread: 't', message: 'm' });
    pad.env('m.1', 't', 'a.env', 'A', { cwd: root });
    pad.env('m.2', 't', 'a.env', 'B', { cwd: root });
    expect(readFileSync(join(root, 'a.env'), 'utf8')).toBe('A=\'pa$word\'\nB="it\'s\\"x"\n');
    writeFileSync(
      join(root, 'a.env'),
      `${readFileSync(join(root, 'a.env'), 'utf8')}C="q v" # note\nC=last\n`,
    );
    const out = join(root, 'o');
    for (const [key, want] of [
      ['A', 'pa$word'],
      ['B', `it's"x`],
      ['C', 'last'],
    ] as const) {
      await pad.pipe({ envFile: 'a.env', key }, 't', `cat > ${out}`, { cwd: root });
      expect(readFileSync(out, 'utf8')).toBe(want);
    }
  });

  test('the pad directory is never a target, and an unreadable pad stops instead of being overwritten', () => {
    const { root, pad } = setup();
    pad.lift('$$abc-123', { thread: 't', message: 'm' });
    expect(() => pad.write('m.1', 't', join(pad.dir, 'other.pad'))).toThrow(SecretScratchError);
    writeFileSync(join(pad.dir, 'bad.pad'), '†m (x, "e")\n[1] "unterminated\n');
    expect(() => pad.list('bad')).toThrow('unreadable');
    expect(root).toBeTruthy();
  });

  test('scrub does not corrupt a reference holding a shorter value', () => {
    const { pad } = setup();
    pad.lift('$$turn_a $$xturn_a-long', { thread: 't', message: 'turn_a' });
    expect(pad.scrub('t', 'xturn_a-long and turn_a')).toBe('†turn_a.2 and †turn_a.1');
  });
});

describe('private paths', () => {
  test('a .private segment, a name ending in .private or holding .private., or an extra glob', () => {
    for (const path of [
      '.private/notes.md',
      'a/.private',
      'keys.private',
      'app.private.pem',
      '/x/.private/scratch/t.pad',
    ])
      expect(isPrivatePath(path)).toBe(true);
    for (const path of ['src/privateRoutes.ts', 'isPrivate.test.ts', 'private/readme.md'])
      expect(isPrivatePath(path)).toBe(false);
    expect(isPrivatePath('certs/server.pem', ['*.pem'])).toBe(true);
  });

  test('the gate denies reads and commands naming one, and lets the scratch tool through', async () => {
    const gate = privatePathGate();
    const read = await gate({
      stage: 'pre-use',
      toolName: 'Read',
      toolInput: { file_path: '/r/keys.private' },
    });
    expect(read.behavior).toBe('deny');
    const cat = await gate({
      stage: 'pre-use',
      toolName: 'Bash',
      toolInput: { command: 'cat .private/scratch/t.pad | head' },
    });
    expect(cat.behavior).toBe('deny');
    const codex = await gate({
      stage: 'permission',
      toolName: 'commandExecution',
      toolInput: { command: ['sh', '-c', 'cat app.private.pem'] },
    });
    expect(codex.behavior).toBe('deny');
    const fine = await gate({
      stage: 'pre-use',
      toolName: 'Bash',
      toolInput: { command: 'ls src' },
    });
    expect(fine.behavior).toBe('allow');
    const own = {
      toolName: 'mcp__foundry__secret_scratch',
      toolServer: 'foundry',
      toolMethod: 'secret_scratch',
      toolInput: { path: 'keys.private' },
    };
    expect(privatePathDenial(own)).toBeDefined();
    const isOwnTool = (r: { toolServer?: string; toolMethod?: string }) =>
      r.toolServer === 'foundry' && r.toolMethod === 'secret_scratch';
    expect(privatePathDenial(own, { isOwnTool })).toBeUndefined();
    expect(privatePathDenial({ ...own, toolServer: 'other' }, { isOwnTool })).toBeDefined();
    expect(
      (
        await gate({
          stage: 'pre-use',
          toolName: 'Bash',
          toolInput: { command: 'cat .pri\\vate/x' },
        })
      ).behavior,
    ).toBe('deny');
  });

  test('the scratch directory is private whatever its name', () => {
    const scratchDir = '/state/pads';
    expect(
      privatePathDenial(
        { toolName: 'Read', toolInput: { file_path: '/state/pads/t.pad' } },
        { scratchDir },
      ),
    ).toBeDefined();
  });
});
