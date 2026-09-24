// @inixiative/agent-session — drive coding-agent runtimes as persistent,
// streaming, event-captured sessions, over interchangeable transports.

// The provider-agnostic interface + event taxonomy.
export * from "./harness-session";

// Transports: how a session reaches its model, with declared capabilities.
export {
  TRANSPORTS,
  TransportUnavailableError,
  type TransportCapabilities,
  type TransportDescriptor,
  type TransportKind,
  type TransportRuntime,
} from "./transport";
export {
  createSession,
  describeTransport,
  AcpSession,
  ApiSession,
  type AcpSessionConfig,
  type ApiSessionConfig,
  type TransportConfigs,
} from "./transports";

// Claude Code adapter (persistent stream-json session, subscription auth).
export {
  ClaudeCodeSession,
  CLAUDE_TEXT_ONLY_ARGS,
  type ClaudeCodeSessionConfig,
} from "./claude-code-session";

// Claude through the Agent SDK (caller supplies `query`; zero dependencies here).
export {
  ClaudeAgentSdkSession,
  sdkOptionsFromArgv,
  type ClaudeAgentSdkCanUseTool,
  type ClaudeAgentSdkQuery,
  type ClaudeAgentSdkQueryFunction,
  type ClaudeAgentSdkSessionConfig,
} from "./claude-agent-sdk-session";

// Codex CLI adapter (persistent JSON-RPC session). CodexSession defaults to the
// mcp-server variant; CodexAppServerSession is the app-server one.
export {
  CodexSession,
  CodexMcpSession,
  CodexAppServerSession,
  type CodexSessionConfig,
  type CodexSpawn,
} from "./codex-session";

// Primed decision sessions: one live, warm session per middleware role.
export {
  DecisionError,
  primeHash,
  type DecisionAdmission,
  type DecisionFailure,
  type DecisionRequest,
  type DecisionResult,
  type PrimedEvent,
  type PrimedSessions,
  type PrimedSnapshot,
  type PrimeSpec,
} from "./primed";
export {
  CodexPrimedSessions,
  CODEX_DECISION_DISABLED_FEATURES,
  codexDecisionLaunchArgs,
  codexTokens,
  type CodexPrimedConfig,
} from "./codex-primed";
export { ClaudePrimedSessions, type ClaudePrimedConfig } from "./claude-primed";

// Subscription limits, polling, routing and pools.
export {
  claudeRateLimitSnapshot,
  claudeUsageSnapshot,
  codexLimitSnapshot,
  limitUtilization,
  mergeLimits,
  type LimitRuntime,
  type LimitSnapshot,
  type LimitWindow,
} from "./limits";
export { probeClaudeLimits, probeCodexLimits, type LimitProbeOptions } from "./limits-probe";
export {
  assessCandidate,
  rankCandidates,
  rankSubscriptionAccounts,
  repositoryIdentity,
  type CandidateRequest,
  type ExclusionReason,
  type RankedCandidate,
  type RepositoryRoute,
  type RoutingMode,
  type RoutingRequest,
  type SubscriptionCandidate,
} from "./routing";
export {
  SubscriptionPool,
  PoolExhaustedError,
  ContinuityError,
  type ContinuityRefusal,
  type FailureKind,
  type InstanceConfig,
  type InstanceStatus,
  type Lease,
  type PoolEvent,
  type PoolRequest,
  type PooledSessionConfig,
  type PooledTransport,
  type SubscriptionPoolOptions,
} from "./pool";

export { JsonRpcConnection, JsonRpcError, JsonRpcClosedError, JsonRpcTimeoutError } from "./json-rpc";
export { parseClaudeUsage } from "./claude-usage";
