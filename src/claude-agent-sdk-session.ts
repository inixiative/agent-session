// ---------------------------------------------------------------------------
// ClaudeAgentSdkSession — Claude through @anthropic-ai/claude-agent-sdk
// ---------------------------------------------------------------------------
//
// The Agent SDK drives the same Claude Code runtime and yields the same
// stream-json messages. This transport feeds SDK `query()` through a
// process-shaped bridge, so ClaudeCodeSession's classification, admission and
// ownership evidence apply unchanged. The caller supplies `query` (this
// package keeps zero dependencies):
//
//   import { query } from "@anthropic-ai/claude-agent-sdk";
//   const session = new ClaudeAgentSdkSession({ query, model: "sonnet", cwd });
//
// Launch options come from the same argv the CLI transport would use, mapped
// to SDK options; unmapped flags pass through `extraArgs`. Adds per-call
// approvals (`canUseTool`) and SDK-native interrupt. Limit polling
// (`get_usage`) is not exposed by the SDK Query API and is refused.
// ---------------------------------------------------------------------------

import { ClaudeCodeSession, type ClaudeCodeSessionConfig, type PipedSubprocess } from "./claude-code-session";
import { TRANSPORTS } from "./transport";

/** The subset of the SDK's Query this transport uses. */
export interface ClaudeAgentSdkQuery extends AsyncIterable<unknown> {
  interrupt(): Promise<void>;
  close?(): void;
}
export type ClaudeAgentSdkQueryFunction = (params: { prompt: AsyncIterable<unknown>; options: Record<string, unknown> }) => ClaudeAgentSdkQuery;
export type ClaudeAgentSdkCanUseTool = (toolName: string, input: Record<string, unknown>, context: unknown) => Promise<unknown>;

export interface ClaudeAgentSdkSessionConfig extends Omit<ClaudeCodeSessionConfig, "spawn"> {
  /** `query` from @anthropic-ai/claude-agent-sdk. */
  query: ClaudeAgentSdkQueryFunction;
  /** Per-call tool approval. Consulted only when permissionMode is not "bypassPermissions". */
  canUseTool?: ClaudeAgentSdkCanUseTool;
  /** Use the SDK's bundled CLI instead of resolving `bin` on PATH. Default false. */
  bundledCli?: boolean;
  /** Additional SDK options, passed verbatim (e.g. hooks). Mapped options take precedence. */
  sdkOptions?: Record<string, unknown>;
}

const SDK_OWNED = new Set(["--print", "--verbose"]);
const SDK_OWNED_VALUE = new Set(["--input-format", "--output-format"]);

/** Map a ClaudeCodeSession argv (without the binary) to SDK options. Exported for tests. */
export function sdkOptionsFromArgv(argv: readonly string[]): Record<string, unknown> {
  const options: Record<string, unknown> = {};
  const extraArgs: Record<string, string | null> = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]!;
    const hasValue = i + 1 < argv.length && !argv[i + 1]!.startsWith("--");
    const value = () => argv[++i]!;
    if (SDK_OWNED.has(flag)) continue;
    if (SDK_OWNED_VALUE.has(flag)) { i++; continue; }
    switch (flag) {
      case "--model": options.model = value(); break;
      case "--max-turns": options.maxTurns = Number(value()); break;
      case "--permission-mode": {
        options.permissionMode = value();
        if (options.permissionMode === "bypassPermissions") options.allowDangerouslySkipPermissions = true;
        break;
      }
      case "--resume": options.resume = value(); break;
      case "--fork-session": options.forkSession = true; break;
      case "--append-system-prompt": options.systemPrompt = { type: "preset", preset: "claude_code", append: value() }; break;
      case "--no-session-persistence": options.persistSession = false; break;
      case "--strict-mcp-config": options.strictMcpConfig = true; break;
      case "--mcp-config": {
        const parsed = JSON.parse(value()) as { mcpServers?: Record<string, unknown> };
        options.mcpServers = parsed.mcpServers ?? {};
        break;
      }
      case "--tools": {
        // `--tools ""` (text-only) is an empty list; the SDK spells that `tools: []`.
        const list = argv[i + 1] !== undefined && !argv[i + 1]!.startsWith("--") ? value() : "";
        options.tools = list ? list.split(",") : [];
        break;
      }
      default: extraArgs[flag.replace(/^--/, "")] = hasValue ? value() : null;
    }
  }
  if (Object.keys(extraArgs).length) options.extraArgs = extraArgs;
  return options;
}

function bridge(config: ClaudeAgentSdkSessionConfig): NonNullable<ClaudeCodeSessionConfig["spawn"]> {
  return (cmd, { cwd, env }) => {
    const encoder = new TextEncoder();
    let out!: ReadableStreamDefaultController<Uint8Array>, err!: ReadableStreamDefaultController<Uint8Array>;
    let finish!: (code: number) => void, finished = false;
    const exited = new Promise<number>(resolve => { finish = resolve; });
    const stdout = new ReadableStream<Uint8Array>({ start(c) { out = c; } });
    const stderr = new ReadableStream<Uint8Array>({ start(c) { err = c; } });
    const end = (code: number) => {
      if (finished) return; finished = true;
      try { out.close(); } catch { /* closed */ }
      try { err.close(); } catch { /* closed */ }
      finish(code);
    };
    const emit = (message: unknown) => { if (!finished) out.enqueue(encoder.encode(JSON.stringify(message) + "\n")); };

    const inbox: unknown[] = [];
    let wake: (() => void) | undefined, inputEnded = false;
    const prompt: AsyncIterable<unknown> = { async *[Symbol.asyncIterator]() {
      while (true) {
        while (inbox.length) yield inbox.shift();
        if (inputEnded) return;
        await new Promise<void>(resolve => { wake = resolve; });
      }
    } };

    const stringEnv = Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
    const options: Record<string, unknown> = { ...config.sdkOptions, ...sdkOptionsFromArgv(cmd.slice(1)), cwd, env: stringEnv,
      ...(config.canUseTool ? { canUseTool: config.canUseTool } : {}),
      ...(config.bundledCli ? {} : { pathToClaudeCodeExecutable: Bun.which(cmd[0]!) ?? cmd[0] }) };
    let query: ClaudeAgentSdkQuery;
    try { query = config.query({ prompt, options }); }
    catch (error) {
      queueMicrotask(() => { err.enqueue(encoder.encode(String((error as Error).message ?? error))); end(1); });
      query = { interrupt: async () => {}, async *[Symbol.asyncIterator]() {} };
    }
    void (async () => {
      try { for await (const message of query) emit(message); end(0); }
      catch (error) { if (!finished) err.enqueue(encoder.encode(String((error as Error)?.message ?? error))); end(1); }
    })();

    const respond = (requestId: string, error?: string) => emit({ type: "control_response",
      response: error ? { subtype: "error", request_id: requestId, error } : { subtype: "success", request_id: requestId, response: {} } });
    const process: PipedSubprocess = {
      stdin: {
        write(data: string) {
          for (const line of data.split("\n")) {
            if (!line.trim()) continue;
            const message = JSON.parse(line) as Record<string, unknown>;
            if (message.type === "user") {
              inbox.push({ ...message, parent_tool_use_id: null, session_id: "" });
              wake?.(); wake = undefined;
            } else if (message.type === "control_request") {
              const id = String(message.request_id);
              const subtype = (message.request as Record<string, unknown> | undefined)?.subtype;
              if (subtype === "interrupt") query.interrupt().then(() => respond(id), e => respond(id, String((e as Error)?.message ?? e)));
              else queueMicrotask(() => respond(id, `Control request ${String(subtype)} is not exposed by the Agent SDK transport`));
            }
          }
        },
        flush() {},
        end() { inputEnded = true; wake?.(); wake = undefined; },
      },
      stdout, stderr, exited,
      kill() {
        inputEnded = true; wake?.(); wake = undefined;
        try { query.close?.(); } catch { /* already closed */ }
        end(143);
      },
    };
    return process;
  };
}

export class ClaudeAgentSdkSession extends ClaudeCodeSession {
  override get transport() { return TRANSPORTS["claude-agent-sdk"]; }
  private readonly _sdk: ClaudeAgentSdkSessionConfig;

  constructor(config: ClaudeAgentSdkSessionConfig) {
    if (typeof config?.query !== "function") throw Error("ClaudeAgentSdkSession requires `query` from @anthropic-ai/claude-agent-sdk");
    const { query: _query, canUseTool: _canUseTool, bundledCli: _bundled, sdkOptions: _options, ...session } = config;
    super({ ...session, spawn: bridge(config) });
    this._sdk = config;
  }

  /** get_usage is not reachable through the SDK Query API. */
  override async readLimits(): Promise<never> {
    throw Error("Limit polling is not exposed by the Agent SDK transport; use the claude-cli transport or rate_limit events");
  }

  protected override _construct(config: ClaudeCodeSessionConfig): ClaudeCodeSession {
    const { spawn: _spawn, ...rest } = config;
    return new ClaudeAgentSdkSession({ ...rest, query: this._sdk.query, canUseTool: this._sdk.canUseTool, bundledCli: this._sdk.bundledCli, sdkOptions: this._sdk.sdkOptions });
  }
}
