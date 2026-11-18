/**
 * The keeper's socket protocol: newline-delimited JSON frames over a unix socket.
 * `KEEPER_PROTOCOL` versions this framing only; the session snapshot has its own number.
 * A shape change here without a bump fails `tests/fixtures/keeper-framing.json`.
 */
export const KEEPER_PROTOCOL = 1;

/** The keeper's configuration, written once to its stdin at spawn so the token never reaches argv. */
export interface KeeperLaunch {
  readonly protocol: typeof KEEPER_PROTOCOL;
  readonly token: string;
  readonly socketPath: string;
  readonly cmd: readonly string[];
  readonly cwd?: string;
  readonly env: Readonly<Record<string, string>>;
  /** Past this many unacked bytes the keeper stops reading the CLI's output. */
  readonly spoolMaxBytes: number;
  /** Used while no daemon is attached and none set a deadline of its own. */
  readonly attachDeadlineMs: number;
  /** A file whose recent mtime extends the deadline while a Foundry boots. */
  readonly beatPath?: string;
  /** Files the keeper removes when it exits (its registration). */
  readonly cleanup?: readonly string[];
}

/** Client → keeper. */
export type KeeperRequest =
  | { readonly t: 'auth'; readonly token: string }
  /** Forward frames numbered above `after`, then live. Every attachment starts held. */
  | { readonly t: 'release'; readonly after: number }
  | { readonly t: 'hold' }
  /** Frames up to `through` are committed; the keeper drops them. */
  | { readonly t: 'ack'; readonly through: number }
  | { readonly t: 'in'; readonly seq: number; readonly data: string }
  | { readonly t: 'inEnd' }
  /** End the CLI (SIGTERM), as `kill()` always meant. */
  | { readonly t: 'kill' }
  | { readonly t: 'deadline'; readonly ms: number };

/** Keeper → client. */
export type KeeperFrame =
  | {
      readonly t: 'hello';
      readonly protocol: typeof KEEPER_PROTOCOL;
      readonly keeperPid: number;
      readonly cliPid: number;
      readonly cliStartTime: number;
      readonly epoch: number;
      /** Highest frame number acked so far. */
      readonly acked: number;
      /** Approval requests spooled and unanswered (`can_use_tool`, `hook_callback`). */
      readonly waiting: number;
    }
  | { readonly t: 'out'; readonly n: number; readonly data: string }
  | { readonly t: 'err'; readonly n: number; readonly data: string }
  | { readonly t: 'exit'; readonly n: number; readonly code: number }
  | { readonly t: 'inAck'; readonly seq: number }
  | { readonly t: 'held'; readonly forwarded: number }
  | { readonly t: 'refused'; readonly reason: string };

/** A numbered stream frame: one line of stdout or stderr, or the CLI's exit. */
export type KeeperStreamFrame = Extract<KeeperFrame, { n: number }>;

export function encodeFrame(frame: KeeperFrame | KeeperRequest): string {
  return `${JSON.stringify(frame)}\n`;
}

/** Splits a byte stream into frames; a partial frame waits for the next chunk. */
export function frameReader(onFrame: (frame: Record<string, unknown>) => void) {
  const decoder = new TextDecoder();
  let buffer = '';
  return (chunk: Uint8Array | string) => {
    buffer += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
    let index = buffer.indexOf('\n');
    while (index >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (line.trim()) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          parsed = undefined;
        }
        if (parsed && typeof parsed === 'object') onFrame(parsed as Record<string, unknown>);
      }
      index = buffer.indexOf('\n');
    }
  };
}

/** The socket name: a hash, so a long config directory still fits macOS's 104-byte `sun_path`. */
export function keeperId(seed: string): string {
  return new Bun.CryptoHasher('sha256').update(seed).digest('hex').slice(0, 16);
}
