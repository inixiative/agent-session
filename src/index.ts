// @inixiative/agent-session — drive coding-agent runtimes as persistent,
// streaming, event-captured sessions, over interchangeable transports.

// Claude through the Agent SDK (caller supplies `query`; zero dependencies here).
export {
  type ClaudeAgentSdkCanUseTool,
  type ClaudeAgentSdkQuery,
  type ClaudeAgentSdkQueryFunction,
  ClaudeAgentSdkSession,
  type ClaudeAgentSdkSessionConfig,
  sdkOptionsFromArgv,
} from './claude-agent-sdk-session';
// Claude Code adapter (persistent stream-json session, subscription auth).
export {
  CLAUDE_TEXT_ONLY_ARGS,
  ClaudeCodeSession,
  type ClaudeCodeSessionConfig,
} from './claude-code-session';
export { type ClaudePrimedConfig, ClaudePrimedSessions } from './claude-primed';
export { parseClaudeUsage } from './claude-usage';
export {
  CODEX_DECISION_DISABLED_FEATURES,
  CODEX_DECISION_THREAD_CONFIG,
  type CodexPrimedConfig,
  CodexPrimedSessions,
  codexDecisionLaunchArgs,
  codexTokens,
} from './codex-primed';

// Codex CLI adapter (persistent JSON-RPC session). CodexSession defaults to the
// mcp-server variant; CodexAppServerSession is the app-server one.
export {
  CodexAppServerSession,
  CodexMcpSession,
  CodexSession,
  type CodexSessionConfig,
  type CodexSpawn,
} from './codex-session';
// The provider-agnostic interface + event taxonomy.
export * from './harness-session';
export {
  JsonRpcClosedError,
  JsonRpcConnection,
  JsonRpcError,
  JsonRpcTimeoutError,
} from './json-rpc';
// Subscription limits, polling, routing and pools.
export {
  claudeRateLimitSnapshot,
  claudeUsageSnapshot,
  codexLimitSnapshot,
  type LimitRuntime,
  type LimitSnapshot,
  type LimitWindow,
  limitUtilization,
  mergeLimits,
} from './limits';
export { type LimitProbeOptions, probeClaudeLimits, probeCodexLimits } from './limits-probe';
export {
  ContinuityError,
  type ContinuityRefusal,
  type FailureKind,
  type InstanceConfig,
  type InstanceStatus,
  type Lease,
  type PoolEvent,
  PoolExhaustedError,
  type PooledSessionConfig,
  type PooledTransport,
  type PoolRequest,
  SubscriptionPool,
  type SubscriptionPoolOptions,
} from './pool';
// Primed decision sessions: one live, warm session per middleware role.
export {
  type DecisionAdmission,
  DecisionError,
  type DecisionFailure,
  type DecisionRequest,
  type DecisionResult,
  type PrimedEvent,
  type PrimedSessions,
  type PrimedSnapshot,
  type PrimeSpec,
  primeHash,
} from './primed';
export {
  assessCandidate,
  type CandidateRequest,
  type ExclusionReason,
  type RankedCandidate,
  type RepositoryRoute,
  type RoutingMode,
  type RoutingRequest,
  rankCandidates,
  rankSubscriptionAccounts,
  repositoryIdentity,
  type SubscriptionCandidate,
} from './routing';
// Transports: how a session reaches its model, with declared capabilities.
export {
  TRANSPORTS,
  type TransportCapabilities,
  type TransportDescriptor,
  type TransportKind,
  type TransportRuntime,
  TransportUnavailableError,
} from './transport';
export {
  AcpSession,
  type AcpSessionConfig,
  ApiSession,
  type ApiSessionConfig,
  createSession,
  describeTransport,
  type TransportConfigs,
} from './transports';
