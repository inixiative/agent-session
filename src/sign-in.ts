/**
 * A subscription sign-in with no terminal of the person's own: `claude setup-token` (Anthropic's
 * inference-only, one-year token) or `codex login` runs on a pseudo-terminal in a directory of its
 * own. The caller shows the sign-in page, passes back the code it gives, and gets the tokens. The
 * machine's own logins are never read or written, and a printed token never reaches `onOutput`.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { PROFILE_VARIABLE } from './profile-variable';

export type SignInRuntime = keyof typeof PROFILE_VARIABLE;

export interface SignInTokens {
  accessToken: string;
  refreshToken?: string;
  idToken?: string;
}

/** A sign-in command on a terminal: what it prints, what is typed into it, how it ends. */
export interface SignInProcess {
  output: ReadableStream<Uint8Array>;
  write(text: string): void;
  exited: Promise<number>;
  kill(): void;
}

export interface SignInOptions {
  /** An existing private directory that holds only this sign-in. The caller removes it. */
  profileDirectory: string;
  /** The environment the CLI inherits; keys that would select another login or metered billing are dropped. */
  env?: Record<string, string | undefined>;
  /** Codex only: a page and a one-time code, for a person on another machine than the CLI. */
  deviceAuth?: boolean;
  /** What the CLI prints, a line at a time, with any token masked. */
  onOutput?: (text: string) => void;
  /** Runs the command; the default is Bun's pseudo-terminal. There is no time limit: `cancel`. */
  spawn?: (argv: string[], env: Record<string, string | undefined>) => SignInProcess;
}

export interface SignIn {
  /** The page to open. Rejects if the CLI ends without printing one. */
  url: Promise<string>;
  /** With `deviceAuth`, the code to enter on that page. */
  userCode: Promise<string>;
  /** Types the code the sign-in page shows into the CLI. */
  sendCode(code: string): void;
  result: Promise<SignInTokens>;
  cancel(): void;
}

const COMPETING_ENV = /^(ANTHROPIC_|OPENAI_|CODEX_|CLAUDE_CODE_|CLAUDE_CONFIG_DIR$)/;
const SETUP_TOKEN = /sk-ant-oat\d+-[A-Za-z0-9_-]{20,}/g;
const SIGN_IN_URL = /https:\/\/[^\s"'<>]*(?:oauth|authorize|auth\.openai\.com)[^\s"'<>]*/i;
const USER_CODE = /\b[A-Z0-9]{4}-[A-Z0-9]{4,5}\b/;
// why: the CLI places words with cursor-column moves, which would otherwise strip to run-together text.
const CURSOR_COLUMN = new RegExp(`${String.fromCharCode(27)}\\[\\d*G`, 'g');

// why: a wide terminal keeps a printed token and URL on one line.
const onTerminal = (argv: string[], env: Record<string, string | undefined>): SignInProcess => {
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  let open = true;
  const output = new ReadableStream<Uint8Array>({
    start(controller) {
      stream = controller;
    },
    cancel() {
      open = false;
    },
  });
  const close = () => {
    if (!open) return;
    open = false;
    stream.close();
  };
  const child = Bun.spawn(argv, {
    env,
    terminal: {
      cols: 4000,
      rows: 40,
      data: (_terminal, data) => {
        if (open) stream.enqueue(new Uint8Array(data));
      },
      exit: close,
    },
  });
  const exited = child.exited.then((code) => {
    setTimeout(close, 200);
    return code;
  });
  return {
    output,
    write: (text) => child.terminal?.write(text),
    exited,
    kill: () => child.kill(),
  };
};

const readCodexTokens = (directory: string): SignInTokens => {
  const file = join(directory, 'auth.json');
  if (!existsSync(file)) throw Error('codex login left no ChatGPT login');
  const { tokens } = JSON.parse(readFileSync(file, 'utf8')) ?? {};
  const { access_token, refresh_token, id_token } = tokens ?? {};
  if (!access_token || !refresh_token || !id_token)
    throw Error('codex login left no ChatGPT login');
  return { accessToken: access_token, refreshToken: refresh_token, idToken: id_token };
};

export const startSignIn = (runtime: SignInRuntime, options: SignInOptions): SignIn => {
  const { profileDirectory, deviceAuth, onOutput, spawn = onTerminal } = options;
  const argv =
    runtime === 'claude'
      ? ['claude', 'setup-token']
      : ['codex', 'login', ...(deviceAuth ? ['--device-auth'] : [])];
  const url = Promise.withResolvers<string>();
  const userCode = Promise.withResolvers<string>();
  let child: SignInProcess | undefined;
  let state: 'running' | 'ended' | 'cancelled' = 'running';

  const run = async (): Promise<SignInTokens> => {
    const env: Record<string, string | undefined> = {};
    for (const [key, value] of Object.entries(options.env ?? process.env))
      if (!COMPETING_ENV.test(key)) env[key] = value;
    env[PROFILE_VARIABLE[runtime]] = profileDirectory;
    if (runtime === 'codex')
      writeFileSync(
        join(profileDirectory, 'config.toml'),
        'cli_auth_credentials_store = "file"\n',
        { mode: 0o600 },
      );
    // why: spawned before the first await, so `sendCode` and `cancel` reach it from the start.
    child = spawn(argv, env);

    const decoder = new TextDecoder();
    let pending = '';
    let token: string | undefined;
    let page = false;
    const take = (raw: string) => {
      // why: a token is matched with every escape removed, so a cursor move cannot split it.
      const bare = stripVTControlCharacters(raw);
      const found = bare.match(SETUP_TOKEN)?.[0];
      token ??= found;
      const text = found
        ? bare.replace(SETUP_TOKEN, '[token captured]')
        : stripVTControlCharacters(raw.replace(CURSOR_COLUMN, ' '));
      const link = text.match(SIGN_IN_URL)?.[0];
      if (link) {
        page = true;
        url.resolve(link);
      }
      const code = deviceAuth && page && text.replace(SIGN_IN_URL, '').match(USER_CODE)?.[0];
      if (code) userCode.resolve(code);
      if (text) onOutput?.(text);
    };
    for await (const chunk of child.output) {
      pending += decoder.decode(chunk, { stream: true });
      const cut = Math.max(pending.lastIndexOf('\n'), pending.lastIndexOf('\r'));
      if (cut < 0) continue;
      take(pending.slice(0, cut + 1));
      pending = pending.slice(cut + 1);
    }
    take(pending + decoder.decode());
    const exit = await child.exited;
    if (state === 'cancelled') throw Error('Sign-in cancelled');
    const command = argv.slice(0, 2).join(' ');
    if (exit !== 0) throw Error(`${command} did not finish`);
    if (runtime === 'codex') return readCodexTokens(profileDirectory);
    if (!token) throw Error(`${command} did not print a token`);
    return { accessToken: token };
  };

  const result = run()
    .catch((error) => {
      child?.kill();
      throw error;
    })
    .finally(() => {
      if (state === 'running') state = 'ended';
      url.reject(Error('The sign-in ended without a page'));
      userCode.reject(Error('The sign-in ended without a code'));
    });
  // why: a caller may await only some of these; the rest must not end the process as unhandled.
  for (const promise of [url.promise, userCode.promise, result]) promise.catch(() => {});

  return {
    url: url.promise,
    userCode: userCode.promise,
    result,
    sendCode(code) {
      const text = code.trim();
      const typable = text && text.length <= 2_000 && !/[\p{Cc}]/u.test(text);
      if (!typable) throw Error('That is not a code');
      if (state !== 'running' || !child) throw Error('No sign-in is waiting');
      child.write(`${text}\r`);
    },
    cancel() {
      if (state !== 'running') return;
      state = 'cancelled';
      child?.kill();
    },
  };
};
