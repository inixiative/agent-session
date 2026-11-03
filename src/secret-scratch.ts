import { spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, isAbsolute, join, resolve, sep } from 'node:path';
import type { ToolGate, ToolRequest } from './harness-session';

/**
 * The secret scratch pad (AS-009): secrets a person hands an agent as `$$word` are lifted out of the
 * message into a private file per thread, and the agent uses them by reference without reading them.
 *
 * One pad per thread accumulates: a dagger per message that carried secrets, a numbered block per
 * secret, a blank line, the next message. A reference is thread, message and position; inside its
 * own thread it is written `†<message>.<n>`, anywhere else `†<thread>/<message>.<n>`.
 */

/** The marker: a word starting with it is a secret, up to the next whitespace. */
export const SECRET_MARKER = '$$';

/** What the agent is told, wherever the tool is offered: use the values, never read them. */
export const SECRET_SCRATCH_GUIDANCE =
  "A reference like †<message>.<n> in a message is a secret the person handed you, held in the thread's scratch pad. You never see the value and must not try to read it: use it. The normal path is env (set KEY in an env file) and then pipe from that env file (a command gets the value on its stdin; its output is thrown away and only the exit code comes back). write puts a value in a file. Pass consume: true on the last use to remove it from the pad. list shows what is pending, here or, given a thread, in another thread whose references you have. A file the pad has written to is then off limits to read, search or print, like files named .private, *.private or *.private.*: use it through pipe. A secret is one word after $$; a multi-line secret cannot be lifted.";

const REF = /^†?(?:([A-Za-z0-9_.:-]+)\/)?([A-Za-z0-9_.:-]+)\.(\d+)$/;
const ID = /^[A-Za-z0-9_:-][A-Za-z0-9_.:-]*$/;
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MARKED = /(^|\s)\$\$(\S+)/g;
const PAD_SUFFIX = '.pad';
/** A held value shorter than this is not scrubbed from text: it would match ordinary words. */
const SCRUB_MIN = 6;

export interface ScratchRef {
  readonly thread: string;
  readonly message: string;
  readonly position: number;
}

/** A dagger as the agent may see it: where it came from and what is pending, never a value. */
export interface ScratchDagger {
  readonly message: string;
  readonly at: string;
  /** The start of the message, with its secrets already replaced by references. */
  readonly excerpt: string;
  readonly positions: readonly number[];
}

export interface ScratchPadSummary {
  readonly thread: string;
  readonly daggers: readonly ScratchDagger[];
}

/** Where `pipe` reads its value: a held block, or a key already set in an env file. */
export type ScratchSource =
  | { readonly ref: string }
  | { readonly envFile: string; readonly key: string };

export interface ScratchUse {
  /** Remove the block from the pad once this use succeeds. */
  readonly consume?: boolean;
}

/** A failure that names references and paths only, never a value. */
export class SecretScratchError extends Error {
  override readonly name = 'SecretScratchError';
}

interface Dagger {
  message: string;
  at: string;
  excerpt: string;
  blocks: Map<number, string>;
}

/** `†<message>.<n>` inside `thread`, `†<thread>/<message>.<n>` from anywhere. */
export function formatScratchRef(ref: ScratchRef, from?: string): string {
  return from === ref.thread
    ? `†${ref.message}.${ref.position}`
    : `†${ref.thread}/${ref.message}.${ref.position}`;
}

/** A reference as written by the agent; a short one belongs to `thread`. */
export function parseScratchRef(text: string, thread: string): ScratchRef {
  const match = REF.exec(text.trim());
  if (!match) throw new SecretScratchError(`Not a scratch pad reference: ${clip(text)}`);
  const position = Number(match[3]);
  const ref = { thread: match[1] ?? thread, message: match[2]!, position };
  if (!ID.test(ref.thread) || !ID.test(ref.message) || position < 1)
    throw new SecretScratchError(`Not a scratch pad reference: ${clip(text)}`);
  return ref;
}

/** A path no agent reads: a `.private` segment, a name ending in `.private` or holding `.private.`, or an extra glob. */
export function isPrivatePath(path: string, extra: readonly string[] = []): boolean {
  const segments = path.split(/[\\/]+/).filter(Boolean);
  if (
    segments.some(
      (segment) =>
        segment === '.private' || segment.endsWith('.private') || segment.includes('.private.'),
    )
  )
    return true;
  return extra.some((pattern) => {
    const glob = new Bun.Glob(pattern);
    return glob.match(path) || glob.match(basename(path));
  });
}

const PATH_KEYS = [
  'file_path',
  'path',
  'paths',
  'notebook_path',
  'pattern',
  'glob',
  'include',
  'cwd',
] as const;

/** Every path and command word a tool call names. */
function namedTargets(request: Pick<ToolRequest, 'toolInput' | 'blockedPath'>): string[] {
  const input = request.toolInput;
  const changes = Array.isArray(input.changes) ? input.changes : [];
  const command = Array.isArray(input.command)
    ? input.command.filter((part): part is string => typeof part === 'string').join(' ')
    : input.command;
  return [
    request.blockedPath,
    ...PATH_KEYS.flatMap((key) => (Array.isArray(input[key]) ? input[key] : [input[key]])),
    ...changes.flatMap((change) => {
      const c = change as { path?: unknown; movePath?: unknown } | null;
      return [c?.path, c?.movePath];
    }),
    ...(typeof command === 'string' ? command.replace(/\\/g, '').split(/[\s'"`;|&<>()=]+/) : []),
  ].filter((value): value is string => typeof value === 'string' && value.length > 0);
}

export interface PrivatePathOptions {
  /** The scratch pad directory, private whatever its name. */
  readonly scratchDir?: string;
  /** Extra globs that are private too (`*.pem`). */
  readonly privatePaths?: readonly string[];
  /** Files the tool has written secrets into (`SecretScratchPad.heldFiles()`): used through pipe, never read. */
  readonly heldFiles?: readonly string[];
  /** Whether a call is the scratch tool's own (it names paths it writes, never reads). Default: none is. */
  readonly isOwnTool?: (
    request: Pick<ToolRequest, 'toolName' | 'toolServer' | 'toolMethod'>,
  ) => boolean;
}

/** A command word or path that names a held file: the same absolute path, or a relative path ending one. */
function namesHeldFile(target: string, held: readonly string[]): boolean {
  if (isAbsolute(target)) return held.includes(resolve(target));
  const tail = target.replace(/^(\.\/)+/, '');
  if (!tail || tail === '.' || tail.startsWith('..')) return false;
  return held.some((file) => file.endsWith(`${sep}${tail}`));
}

/** Why a tool call is refused for naming a private path or the scratch pad; undefined when it names none. */
export function privatePathDenial(
  request: Pick<
    ToolRequest,
    'toolInput' | 'blockedPath' | 'toolMethod' | 'toolName' | 'toolServer'
  >,
  options: PrivatePathOptions = {},
): string | undefined {
  if (options.isOwnTool?.(request)) return undefined;
  const scratchDir = options.scratchDir ? resolve(options.scratchDir) : undefined;
  const hit = namedTargets(request).find(
    (target) =>
      isPrivatePath(target, options.privatePaths) ||
      namesHeldFile(target, options.heldFiles ?? []) ||
      (scratchDir !== undefined &&
        isAbsolute(target) &&
        (resolve(target) === scratchDir || resolve(target).startsWith(scratchDir + sep))),
  );
  if (!hit) return undefined;
  return `${clip(hit)} is private: it is never read, searched or printed. Use the scratch pad's tools instead: pipe from an env file, or env, pipe or write a held reference. They never show a value.`;
}

/** A tool gate that denies every call naming a private path or the scratch pad. */
export function privatePathGate(options: PrivatePathOptions = {}): ToolGate {
  return (request) => {
    const message = privatePathDenial(request, options);
    return message ? { behavior: 'deny', message } : { behavior: 'allow' };
  };
}

/**
 * The pads of one directory: one file per thread, 0600 in a 0700 directory. Every pad change is a
 * synchronous read, edit and rewrite (a temporary file and a rename), so in one process no two
 * changes interleave and a turn path that cannot wait can lift.
 */
export class SecretScratchPad {
  private readonly _dir: string;

  constructor(dir: string) {
    this._dir = resolve(dir);
  }

  get dir(): string {
    return this._dir;
  }

  /**
   * Lift every `$$word` out of `text` into `thread`'s pad, under the dagger for `message`. With
   * `patterns` (global regexes, e.g. a caller's known token shapes), every match is lifted too, the
   * person having forgotten the marker; a match may span lines (a private key). Positions follow the
   * text's order; a match inside another lifted span is left to it. `recognised` counts the matches.
   */
  lift(
    text: string,
    at: { thread: string; message: string; now?: Date },
    options: { patterns?: readonly RegExp[] } = {},
  ): { text: string; refs: string[]; recognised: number } {
    const spans: Array<{
      start: number;
      end: number;
      value: string;
      marked: boolean;
    }> = [];
    for (const match of text.matchAll(MARKED)) {
      const lead = match[1] ?? '';
      spans.push({
        start: (match.index ?? 0) + lead.length,
        end: (match.index ?? 0) + match[0].length,
        value: match[2] ?? '',
        marked: true,
      });
    }
    for (const pattern of options.patterns ?? []) {
      if (!pattern.global) throw new SecretScratchError('A lift pattern must be global (/g).');
      for (const match of text.matchAll(pattern)) {
        if (!match[0]) continue;
        const start = match.index ?? 0;
        spans.push({
          start,
          end: start + match[0].length,
          value: match[0],
          marked: false,
        });
      }
    }
    if (!spans.length) return { text, refs: [], recognised: 0 };
    // Earliest first, the longer of two at one place; a span overlapping a kept one is dropped.
    spans.sort((a, b) => a.start - b.start || b.end - a.end);
    const kept: typeof spans = [];
    for (const span of spans)
      if (!kept.length || span.start >= kept[kept.length - 1]!.end) kept.push(span);
    checkId(at.thread, 'thread');
    checkId(at.message, 'message');
    const daggers = this._read(at.thread);
    let dagger = daggers.find((d) => d.message === at.message);
    const first = dagger ? Math.max(0, ...dagger.blocks.keys()) + 1 : 1;
    const refs = kept.map((_, i) =>
      formatScratchRef({ thread: at.thread, message: at.message, position: first + i }, at.thread),
    );
    let lifted = '';
    let cursor = 0;
    kept.forEach((span, i) => {
      lifted += text.slice(cursor, span.start) + refs[i];
      cursor = span.end;
    });
    lifted += text.slice(cursor);
    if (!dagger) {
      dagger = {
        message: at.message,
        at: (at.now ?? new Date()).toISOString(),
        excerpt: lifted.replace(/\s+/g, ' ').trim().slice(0, 80),
        blocks: new Map(),
      };
      daggers.push(dagger);
    }
    for (const [i, span] of kept.entries()) dagger.blocks.set(first + i, span.value);
    this._write(at.thread, daggers);
    return { text: lifted, refs, recognised: kept.filter((span) => !span.marked).length };
  }

  /** Every pad here (or one thread's) with what it holds pending, never the values. */
  list(thread?: string): ScratchPadSummary[] {
    const threads = thread ? [checkId(thread, 'thread')] : this.threads();
    return threads
      .map((id) => ({ thread: id, daggers: this._read(id).map(summary) }))
      .filter((pad) => pad.daggers.length > 0);
  }

  /** The threads that have a pad here. */
  threads(): string[] {
    let names: string[];
    try {
      names = readdirSync(this._dir);
    } catch {
      return [];
    }
    return names
      .filter((name) => name.endsWith(PAD_SUFFIX))
      .map((name) => name.slice(0, -PAD_SUFFIX.length))
      .filter((id) => ID.test(id))
      .sort();
  }

  /** Files the tool has written secrets into, absolute: the gate keeps them from being read. */
  heldFiles(): string[] {
    const text = readText(this._heldPath());
    if (!text) return [];
    try {
      const files = JSON.parse(text) as unknown;
      return Array.isArray(files) ? files.filter((f): f is string => typeof f === 'string') : [];
    } catch {
      throw new SecretScratchError('The held-files list is unreadable.');
    }
  }

  /** Write the value into a file: `replace` writes it exactly, `append` adds it on its own line. New files are 0600. */
  write(
    ref: string,
    from: string,
    path: string,
    options: ScratchUse & { mode?: 'replace' | 'append'; cwd?: string } = {},
  ): void {
    const target = parseScratchRef(ref, from);
    const value = this._held(target);
    const file = this._target(options.cwd, path);
    const before = options.mode === 'append' ? readText(file) : '';
    const lead = before && !before.endsWith('\n') ? '\n' : '';
    writeTarget(file, options.mode === 'append' ? `${before}${lead}${value}\n` : value);
    this._hold(file);
    if (options.consume) this._drop(target);
  }

  /** Set `KEY=value` in an env file: the line for KEY is replaced, or added at the end. */
  env(
    ref: string,
    from: string,
    path: string,
    key: string,
    options: ScratchUse & { cwd?: string } = {},
  ): void {
    if (!ENV_KEY.test(key)) throw new SecretScratchError(`Not an env key: ${clip(key)}`);
    const target = parseScratchRef(ref, from);
    const value = this._held(target);
    const file = this._target(options.cwd, path);
    const text = readText(file);
    const newline = text.includes('\r\n') ? '\r\n' : '\n';
    const lines = text.split(/\r?\n/);
    if (lines[lines.length - 1] === '') lines.pop();
    const line = `${key}=${envValue(value)}`;
    // Loaders take the last line for a key, so that is the one replaced.
    const at = lines.findLastIndex((l) => envLineKey(l) === key);
    if (at >= 0) lines[at] = line;
    else lines.push(line);
    writeTarget(file, `${lines.join(newline)}${newline}`);
    this._hold(file);
    if (options.consume) this._drop(target);
  }

  /**
   * Run `command` in a shell with the value on its stdin. Its output is thrown away; only the exit
   * code comes back. The value comes from a held block or a key already in an env file. A failed
   * command keeps its block, so it can be tried again.
   */
  async pipe(
    source: ScratchSource,
    from: string,
    command: string,
    options: ScratchUse & { cwd?: string; timeoutMs?: number } = {},
  ): Promise<{ exitCode: number }> {
    if ('ref' in source) {
      const target = parseScratchRef(source.ref, from);
      const result = await runWithStdin(command, this._held(target), options);
      if (options.consume && result.exitCode === 0) this._drop(target);
      return result;
    }
    if (!ENV_KEY.test(source.key))
      throw new SecretScratchError(`Not an env key: ${clip(source.key)}`);
    const file = this._target(options.cwd, source.envFile);
    if (!existsSync(file)) throw new SecretScratchError(`No env file at ${clip(source.envFile)}`);
    const line = readText(file)
      .split(/\r?\n/)
      .findLast((l) => envLineKey(l) === source.key);
    if (line === undefined)
      throw new SecretScratchError(`${source.key} is not set in ${clip(source.envFile)}`);
    return runWithStdin(command, envLineValue(line), options);
  }

  /** Remove a block; a dagger with no blocks left goes too, and an empty pad is deleted. */
  consume(ref: string, from: string): void {
    const target = parseScratchRef(ref, from);
    this._held(target);
    this._drop(target);
  }

  /** Delete a thread's pad. */
  clear(thread: string): void {
    rmSync(this._path(checkId(thread, 'thread')), { force: true });
  }

  /** Replace every held value of `thread` found in `text` with its reference. */
  scrub(thread: string, text: string): string {
    const pairs = this._read(checkId(thread, 'thread'))
      .flatMap((d) =>
        [...d.blocks].map(([position, value]) => ({
          value,
          ref: formatScratchRef({ thread, message: d.message, position }, thread),
        })),
      )
      .filter((pair) => pair.value.length >= SCRUB_MIN)
      .sort((a, b) => b.value.length - a.value.length);
    if (!pairs.length) return text;
    const refs = new Map(pairs.map((pair) => [pair.value, pair.ref]));
    const pattern = new RegExp(pairs.map((pair) => RegExp.escape(pair.value)).join('|'), 'g');
    return text.replace(pattern, (value) => refs.get(value) ?? value);
  }

  private _held(ref: ScratchRef): string {
    const value = this._read(ref.thread)
      .find((d) => d.message === ref.message)
      ?.blocks.get(ref.position);
    if (value === undefined)
      throw new SecretScratchError(
        `Nothing is held at ${formatScratchRef(ref)}: it was consumed, or the reference is wrong. Call list to see what is pending.`,
      );
    return value;
  }

  /** Re-read and drop the block, so a lift made while a pipe ran is kept. */
  private _drop(ref: ScratchRef): void {
    const daggers = this._read(ref.thread);
    daggers.find((d) => d.message === ref.message)?.blocks.delete(ref.position);
    this._write(ref.thread, daggers);
  }

  /** A file the agent names, never inside the pad directory. */
  private _target(cwd: string | undefined, path: string): string {
    const file = resolve(cwd ?? '.', path);
    if (file === this._dir || file.startsWith(this._dir + sep))
      throw new SecretScratchError('The scratch pad directory is not a target.');
    return file;
  }

  private _heldPath(): string {
    return join(this._dir, 'held-files.json');
  }

  private _hold(file: string): void {
    const files = this.heldFiles();
    if (files.includes(file)) return;
    mkdirSync(this._dir, { recursive: true, mode: 0o700 });
    writePrivate(this._heldPath(), JSON.stringify([...files, file].sort(), null, 2));
  }

  private _path(thread: string): string {
    return join(this._dir, `${thread}${PAD_SUFFIX}`);
  }

  private _read(thread: string): Dagger[] {
    try {
      return parsePad(readText(this._path(thread)));
    } catch (error) {
      if (error instanceof SecretScratchError) throw error;
      throw new SecretScratchError(`The pad for ${thread} is unreadable.`);
    }
  }

  private _write(thread: string, daggers: Dagger[]): void {
    const live = daggers.filter((d) => d.blocks.size > 0);
    if (!live.length) {
      rmSync(this._path(thread), { force: true });
      return;
    }
    mkdirSync(this._dir, { recursive: true, mode: 0o700 });
    chmodSync(this._dir, 0o700);
    writePrivate(this._path(thread), formatPad(thread, live));
  }
}

function checkId(id: string, what: string): string {
  if (!ID.test(id)) throw new SecretScratchError(`Not a ${what} id: ${clip(id)}`);
  return id;
}

function clip(text: string): string {
  return text.length > 120 ? `${text.slice(0, 117)}...` : text;
}

function summary(d: Dagger): ScratchDagger {
  return {
    message: d.message,
    at: d.at,
    excerpt: d.excerpt,
    positions: [...d.blocks.keys()].sort((a, b) => a - b),
  };
}

/** The pad as written: a line naming the thread, then per dagger its line, its blocks and a blank line. */
function formatPad(thread: string, daggers: Dagger[]): string {
  const body = daggers.map((d) =>
    [
      `†${d.message} (${d.at}, ${JSON.stringify(d.excerpt)})`,
      ...[...d.blocks]
        .sort(([a], [b]) => a - b)
        .map(([position, value]) => `[${position}] ${JSON.stringify(value)}`),
    ].join('\n'),
  );
  return `# secret scratch pad: thread ${thread}\n\n${body.join('\n\n')}\n`;
}

function parsePad(text: string): Dagger[] {
  const daggers: Dagger[] = [];
  let current: Dagger | undefined;
  for (const line of text.split('\n')) {
    const dagger = /^†(\S+) \((\S+), (".*")\)$/.exec(line);
    if (dagger) {
      current = {
        message: dagger[1]!,
        at: dagger[2]!,
        excerpt: JSON.parse(dagger[3]!) as string,
        blocks: new Map(),
      };
      daggers.push(current);
      continue;
    }
    const block = /^\[(\d+)\] (".*")$/.exec(line);
    if (block && current) {
      current.blocks.set(Number(block[1]), JSON.parse(block[2]!) as string);
      continue;
    }
    // Anything else but the heading and blank lines is damage: stop rather than rewrite without it.
    if (line !== '' && !line.startsWith('# '))
      throw new SecretScratchError('The pad is unreadable.');
  }
  return daggers;
}

function writePrivate(path: string, text: string): void {
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(temp, text, { mode: 0o600, flag: 'wx' });
    renameSync(temp, path);
    chmodSync(path, 0o600);
  } catch (error) {
    rmSync(temp, { force: true });
    throw new SecretScratchError(`Could not write ${clip(path)}: ${errorCode(error)}`);
  }
}

/** A file the agent named: written in place (a symlinked env file stays a link); a new one is 0600. */
function writeTarget(path: string, text: string): void {
  try {
    writeFileSync(path, text, { mode: 0o600 });
  } catch (error) {
    throw new SecretScratchError(`Could not write ${clip(path)}: ${errorCode(error)}`);
  }
}

/** A file's text; a missing file is empty, any other failure stops the operation. */
function readText(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return '';
    throw new SecretScratchError(`Could not read ${clip(path)}: ${errorCode(error)}`);
  }
}

function errorCode(error: unknown): string {
  return (error as NodeJS.ErrnoException | undefined)?.code ?? 'error';
}

/** A dotenv value: bare when plain, otherwise double-quoted with escapes. */
function envValue(value: string): string {
  if (/^[A-Za-z0-9_./:@+,=-]*$/.test(value)) return value;
  // Single quotes are literal in dotenv loaders and shells: no `$` expansion.
  if (!/['\n\r]/.test(value)) return `'${value}'`;
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r')}"`;
}

function envLineKey(line: string): string | undefined {
  return /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line)?.[1];
}

function envLineValue(line: string): string {
  const raw = line.slice(line.indexOf('=') + 1).trim();
  const double = /^"((?:[^"\\]|\\.)*)"\s*(?:#.*)?$/.exec(raw);
  if (double)
    return (double[1] ?? '').replace(/\\(.)/g, (_m, c: string) =>
      c === 'n' ? '\n' : c === 'r' ? '\r' : c,
    );
  const single = /^'([^']*)'\s*(?:#.*)?$/.exec(raw);
  if (single) return single[1] ?? '';
  if (raw.startsWith('"') || raw.startsWith("'"))
    throw new SecretScratchError(
      'The env value spans lines or is unterminated; it cannot be piped.',
    );
  return raw.replace(/\s+#.*$/, '');
}

function runWithStdin(
  command: string,
  value: string,
  options: { cwd?: string; timeoutMs?: number },
): Promise<{ exitCode: number }> {
  return new Promise((done, fail) => {
    const child = spawn('/bin/sh', ['-c', command], {
      cwd: options.cwd,
      stdio: ['pipe', 'ignore', 'ignore'],
      detached: true,
    });
    // The whole group dies on a timeout, so nothing the command started keeps the value.
    const timer = setTimeout(() => {
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    }, options.timeoutMs ?? 120_000);
    child.on('error', () => {
      clearTimeout(timer);
      fail(new SecretScratchError('The command could not start.'));
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      done({ exitCode: code ?? (signal ? 128 : 1) });
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end(value);
  });
}
