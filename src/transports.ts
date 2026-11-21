// Construct a HarnessSession by transport kind. Switching how a model is
// reached is a change of `kind` (a routing decision), not of calling code.

import { AcpSession, type AcpSessionConfig } from './acp-session';
import {
  ClaudeAgentSdkSession,
  type ClaudeAgentSdkSessionConfig,
} from './claude-agent-sdk-session';
import { ClaudeCodeSession, type ClaudeCodeSessionConfig } from './claude-code-session';
import { CodexAppServerSession, type CodexSessionConfig } from './codex-session';
import type { HarnessSession } from './harness-session';
import { MuseSession, type MuseSessionConfig } from './muse-session';
import {
  TRANSPORTS,
  type TransportDescriptor,
  type TransportKind,
  TransportUnavailableError,
} from './transport';

export { AcpSession, type AcpSessionConfig } from './acp-session';

/** Direct metered API. Requires an explicit opt-in and an explicit key; never read from the environment. */
export interface ApiSessionConfig {
  provider: 'anthropic' | 'openai';
  model: string;
  apiKey: string;
  allowApiBilling: true;
  baseContext?: string;
  timeout?: number;
}

export interface TransportConfigs {
  'claude-cli': ClaudeCodeSessionConfig;
  'codex-app-server': CodexSessionConfig;
  'muse-serve': MuseSessionConfig;
  'claude-agent-sdk': ClaudeAgentSdkSessionConfig;
  acp: AcpSessionConfig;
  api: ApiSessionConfig;
}

/** Typed stub: constructing it throws TransportUnavailableError, even with the opt-in set. */
export class ApiSession {
  constructor(config: ApiSessionConfig) {
    if (config?.allowApiBilling !== true)
      throw new TransportUnavailableError(
        'api',
        'metered API billing requires allowApiBilling: true',
      );
    throw new TransportUnavailableError(
      'api',
      'the direct API transport is not implemented in this package; subscription transports never fall back to it',
    );
  }
}

export function describeTransport(kind: TransportKind): TransportDescriptor {
  const descriptor = TRANSPORTS[kind];
  if (!descriptor) throw Error(`Unknown transport "${String(kind)}"`);
  return descriptor;
}

export function createSession<K extends TransportKind>(
  kind: K,
  config: TransportConfigs[K],
): HarnessSession {
  switch (kind) {
    case 'claude-cli':
      return new ClaudeCodeSession(config as ClaudeCodeSessionConfig);
    case 'codex-app-server':
      return new CodexAppServerSession(config as CodexSessionConfig);
    case 'muse-serve':
      return new MuseSession(config as MuseSessionConfig);
    case 'claude-agent-sdk':
      return new ClaudeAgentSdkSession(config as ClaudeAgentSdkSessionConfig);
    case 'acp':
      return new AcpSession(config as AcpSessionConfig);
    case 'api':
      return new ApiSession(config as ApiSessionConfig) as unknown as HarnessSession;
    default:
      throw Error(`Unknown transport "${String(kind)}"`);
  }
}
