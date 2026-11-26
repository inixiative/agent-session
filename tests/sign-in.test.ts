import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type SignInProcess, startSignIn } from '../src/sign-in';

const TOKEN = `sk-ant-oat01-${'x'.repeat(40)}`;
const PAGE = 'https://claude.ai/oauth/authorize?abc';
let directory: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'sign-in-'));
});
afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

const fakeCli = () => {
  let out!: ReadableStreamDefaultController<Uint8Array>;
  let exit!: (code: number) => void;
  let open = true;
  const seen = { argv: [] as string[], env: {} as Record<string, string | undefined> };
  const typed: string[] = [];
  const say = (text: string) => out.enqueue(new TextEncoder().encode(text));
  const end = (code: number) => {
    if (!open) return;
    open = false;
    try {
      out.close();
    } catch {
      // The reader already cancelled it.
    }
    exit(code);
  };
  const process: SignInProcess = {
    output: new ReadableStream<Uint8Array>({
      start(controller) {
        out = controller;
      },
    }),
    write: (text) => typed.push(text),
    exited: new Promise<number>((resolve) => {
      exit = resolve;
    }),
    kill: () => end(143),
  };
  const spawn = (argv: string[], env: Record<string, string | undefined>) => {
    seen.argv = argv;
    seen.env = env;
    return process;
  };
  return { spawn, seen, typed, say, end, isRunning: () => open };
};

describe('startSignIn', () => {
  test('claude: shows the page, types the code, returns the token and never prints it', async () => {
    const cli = fakeCli();
    const output: string[] = [];
    const signIn = startSignIn('claude', {
      profileDirectory: directory,
      env: { PATH: '/bin', ANTHROPIC_API_KEY: 'other', CLAUDE_CODE_OAUTH_TOKEN: 'other' },
      onOutput: (text) => output.push(text),
      spawn: cli.spawn,
    });

    cli.say(`\u001b[1mPaste\u001b[7Gcode\u001b[0m\n${PAGE}\n`);
    expect(await signIn.url).toBe(PAGE);
    signIn.sendCode(' the-code ');
    cli.say(`Your token:\n${TOKEN.slice(0, 20)}`);
    cli.say(`${TOKEN.slice(20)}\n`);
    cli.end(0);

    expect(await signIn.result).toEqual({ accessToken: TOKEN });
    expect(cli.typed).toEqual(['the-code\r']);
    expect(cli.seen.argv).toEqual(['claude', 'setup-token']);
    expect(cli.seen.env).toEqual({ PATH: '/bin', CLAUDE_CONFIG_DIR: directory });
    expect(output.join('')).toContain('Paste code');
    expect(output.join('')).toContain('[token captured]');
    expect(output.join('')).not.toContain('sk-ant-oat');
  });

  test('codex device sign-in: page, one-time code, tokens from its own home', async () => {
    const cli = fakeCli();
    const signIn = startSignIn('codex', {
      profileDirectory: directory,
      deviceAuth: true,
      spawn: cli.spawn,
    });

    cli.say('Open https://auth.openai.com/codex/device\nEnter code ABCD-12345\n');

    expect(await signIn.url).toBe('https://auth.openai.com/codex/device');
    expect(await signIn.userCode).toBe('ABCD-12345');
    writeFileSync(
      join(directory, 'auth.json'),
      JSON.stringify({ tokens: { access_token: 'a', refresh_token: 'r', id_token: 'i' } }),
    );
    cli.end(0);
    expect(await signIn.result).toEqual({ accessToken: 'a', refreshToken: 'r', idToken: 'i' });
    expect(cli.seen.argv).toEqual(['codex', 'login', '--device-auth']);
    expect(cli.seen.env.CODEX_HOME).toBe(directory);
    expect(readFileSync(join(directory, 'config.toml'), 'utf8')).toContain('"file"');
  });

  test('a CLI that fails rejects the page and the result', async () => {
    const cli = fakeCli();
    const signIn = startSignIn('claude', { profileDirectory: directory, spawn: cli.spawn });

    cli.end(1);

    await expect(signIn.result).rejects.toThrow('claude setup-token did not finish');
    await expect(signIn.url).rejects.toThrow('without a page');
  });

  test('cancel ends the command, and no code can follow', async () => {
    const cli = fakeCli();
    const signIn = startSignIn('claude', { profileDirectory: directory, spawn: cli.spawn });

    signIn.cancel();

    await expect(signIn.result).rejects.toThrow('cancelled');
    expect(() => signIn.sendCode('late')).toThrow('No sign-in is waiting');
  });

  test.each(['', 'two\rlines', 'x'.repeat(2_001)])('refuses %j as a code', async (code) => {
    const cli = fakeCli();
    const signIn = startSignIn('claude', { profileDirectory: directory, spawn: cli.spawn });

    expect(() => signIn.sendCode(code)).toThrow('That is not a code');
    expect(cli.typed).toEqual([]);
    signIn.cancel();
    await expect(signIn.result).rejects.toThrow('cancelled');
  });

  test('a missing CLI fails the sign-in, not the caller', async () => {
    const signIn = startSignIn('claude', {
      profileDirectory: directory,
      spawn: () => {
        throw Error('no claude');
      },
    });

    await expect(signIn.result).rejects.toThrow('no claude');
    expect(() => signIn.sendCode('late')).toThrow('No sign-in is waiting');
  });

  test('a failure inside the host stops the CLI', async () => {
    const cli = fakeCli();
    const signIn = startSignIn('claude', {
      profileDirectory: directory,
      onOutput: () => {
        throw Error('socket closed');
      },
      spawn: cli.spawn,
    });

    cli.say(`${PAGE}\n`);

    await expect(signIn.result).rejects.toThrow('socket closed');
    expect(cli.isRunning()).toBe(false);
  });
});
