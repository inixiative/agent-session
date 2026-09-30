// Construct a HarnessSession by transport kind. Switching how a model is
// reached is a change of `kind` (a routing decision), not of calling code.

import { ClaudeCodeSession, type ClaudeCodeSessionConfig } from "./claude-code-session";
import { ClaudeAgentSdkSession, type ClaudeAgentSdkSessionConfig } from "./claude-agent-sdk-session";
import { CodexAppServerSession, CodexMcpSession, type CodexSessionConfig } from "./codex-session";
import type { HarnessSession } from "./harness-session";
import { TRANSPORTS, TransportUnavailableError, type TransportDescriptor, type TransportKind } from "./transport";

/** Agent Client Protocol agent launched over stdio. Typed for callers; not implemented. */
export interface AcpSessionConfig {
  /** Agent command, e.g. ["gemini", "--experimental-acp"]. */
  command: readonly string[];
  cwd?: string;
  env?: Record<string, string | undefined>;
  timeout?: number;
}

/** Direct metered API. Requires an explicit opt-in and an explicit key; never read from the environment. */
export interface ApiSessionConfig {
  provider: "anthropic" | "openai";
  model: string;
  apiKey: string;
  allowApiBilling: true;
  baseContext?: string;
  timeout?: number;
}

export interface TransportConfigs {
  "claude-cli": ClaudeCodeSessionConfig;
  "codex-mcp": CodexSessionConfig;
  "codex-app-server": CodexSessionConfig;
  "claude-agent-sdk": ClaudeAgentSdkSessionConfig;
  "acp": AcpSessionConfig;
  "api": ApiSessionConfig;
}

/** Typed stub: constructing it throws TransportUnavailableError. */
export class AcpSession {
  constructor(_config: AcpSessionConfig) {
    throw new TransportUnavailableError("acp", "no ACP client is implemented in this package; use claude-cli, claude-agent-sdk or codex-app-server");
  }
}

/** Typed stub: constructing it throws TransportUnavailableError, even with the opt-in set. */
export class ApiSession {
  constructor(config: ApiSessionConfig) {
    if (config?.allowApiBilling !== true) throw new TransportUnavailableError("api", "metered API billing requires allowApiBilling: true");
    throw new TransportUnavailableError("api", "the direct API transport is not implemented in this package; subscription transports never fall back to it");
  }
}

export function describeTransport(kind: TransportKind): TransportDescriptor {
  const descriptor = TRANSPORTS[kind];
  if (!descriptor) throw Error(`Unknown transport "${String(kind)}"`);
  return descriptor;
}

export function createSession<K extends TransportKind>(kind: K, config: TransportConfigs[K]): HarnessSession {
  switch (kind) {
    case "claude-cli": return new ClaudeCodeSession(config as ClaudeCodeSessionConfig);
    case "codex-mcp": return new CodexMcpSession(config as CodexSessionConfig);
    case "codex-app-server": return new CodexAppServerSession(config as CodexSessionConfig);
    case "claude-agent-sdk": return new ClaudeAgentSdkSession(config as ClaudeAgentSdkSessionConfig);
    case "acp": return new AcpSession(config as AcpSessionConfig) as unknown as HarnessSession;
    case "api": return new ApiSession(config as ApiSessionConfig) as unknown as HarnessSession;
    default: throw Error(`Unknown transport "${String(kind)}"`);
  }
}
