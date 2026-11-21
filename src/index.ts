// @inixiative/agent-session — drive coding-agent runtimes as persistent,
// streaming, event-captured sessions, over interchangeable transports.

// The secret scratch pad (AS-009): `$$word` secrets used by reference, never read.
export {
  formatScratchRef,
  isPrivatePath,
  type PrivatePathOptions,
  parseScratchRef,
  privatePathDenial,
  privatePathGate,
  type ScratchDagger,
  type ScratchPadSummary,
  type ScratchRef,
  type ScratchSource,
  type ScratchUse,
  SECRET_MARKER,
  SECRET_SCRATCH_GUIDANCE,
  SecretScratchError,
  SecretScratchPad,
} from '@inixiative/secret-scratch';
// Agent Client Protocol (ACP v1 over stdio: Antigravity CLI, Gemini CLI, etc.).
export {
  type AcpConfigOption,
  type AcpMcpServer,
  type AcpServerCapabilities,
  AcpSession,
  type AcpSessionConfig,
  type AcpSpawn,
  AGY_COMPETING_ENV,
  type AgyAcpLaunchOptions,
  agyAcpLaunch,
  GEMINI_CLI_COMPETING_ENV,
  type GeminiCliAcpLaunchOptions,
  geminiCliAcpLaunch,
} from './acp-session';
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
  CLAUDE_SESSION_SNAPSHOT_VERSION,
  CLAUDE_TEXT_ONLY_ARGS,
  type ClaudeAgentDefinition,
  ClaudeCodeSession,
  type ClaudeCodeSessionConfig,
  type ClaudeSessionExtension,
  type ClaudeSessionHost,
  type ClaudeSessionSnapshot,
  type PipedSubprocess,
  sweepOrphanedBaseContexts,
} from './claude-code-session';
export {
  type ClaudeInSessionConfig,
  ClaudeInSessionDecisions,
  IN_SESSION_AGENTS,
  IN_SESSION_HOST_CHARTER,
  IN_SESSION_SERVER,
  type InSessionSetup,
} from './claude-in-session';
export {
  CLAUDE_DECISION_CACHE_ENV,
  type ClaudePrimedConfig,
  ClaudePrimedSessions,
} from './claude-primed';
export { type ClaudeSubagentConfig, ClaudeSubagentSessions } from './claude-subagents';
export { parseClaudeUsage } from './claude-usage';
export {
  CODEX_DECISION_DISABLED_FEATURES,
  CODEX_DECISION_THREAD_CONFIG,
  type CodexPrimedConfig,
  CodexPrimedSessions,
  codexDecisionLaunchArgs,
  codexTokens,
} from './codex-primed';
// Codex CLI adapter: one persistent `codex app-server` JSON-RPC session.
export {
  type CodexApprovalPolicy,
  CodexAppServerSession,
  type CodexFileChange,
  type CodexSandbox,
  type CodexSessionConfig,
  type CodexSpawn,
  codexPermissions,
  type HostPermissionMode,
} from './codex-session';
// The provider-agnostic interface + event taxonomy.
export * from './harness-session';
export {
  JsonRpcClosedError,
  JsonRpcConnection,
  JsonRpcError,
  JsonRpcTimeoutError,
} from './json-rpc';
// The keeper: one small process per kept CLI, so a session outlives the process that started it.
export {
  attachKeeper,
  KEEPER_DEFAULT_ATTACH_DEADLINE_MS,
  KEEPER_DEFAULT_SPOOL_MAX_BYTES,
  type KeeperHandle,
  type KeeperSpawnOptions,
  type KeeperSubprocess,
  spawnThroughKeeper,
} from './keeper/client';
export {
  KEEPER_PROTOCOL,
  type KeeperFrame,
  type KeeperLaunch,
  type KeeperRequest,
} from './keeper/protocol';
// Subscription limits, polling, routing and pools.
export {
  claudeRateLimitSnapshot,
  claudeUsageSnapshot,
  codexLimitSnapshot,
  fullWindowsResetAt,
  type LimitRuntime,
  type LimitSnapshot,
  type LimitWindow,
  limitUtilization,
  mergeLimits,
  museLimitSnapshot,
} from './limits';
export { type LimitProbeOptions, probeClaudeLimits, probeCodexLimits } from './limits-probe';
export { MUSE_COMPETING_ENV } from './muse-env';
// Muse Code adapter: one `muse serve` host per session through Meta's @muse-code/sdk.
export {
  MUSE_SDK_VERSION,
  type MuseApprovalMode,
  type MuseConnect,
  type MuseHost,
  type MuseInitializeResult,
  type MuseLaunch,
  type MusePermissionProfile,
  type MusePermissions,
  type MuseReasoningEffort,
  MuseSession,
  type MuseSessionConfig,
  type MuseUserInputAnswer,
  type MuseUserInputHandler,
  type MuseUserInputQuestion,
  type MuseUserInputRequest,
  musePermissions,
  spawnMuseHost,
} from './muse-session';
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
  type InSessionCapacity,
  type InSessionRoleDown,
  type PrimedEvent,
  type PrimedSessions,
  type PrimedSnapshot,
  type PrimeSpec,
  primeHash,
} from './primed';
export {
  assessCandidate,
  type BillingMode,
  type CandidateRequest,
  DEFAULT_STRATEGY,
  type ExclusionReason,
  type OrderBy,
  type OrderingSpec,
  type OrderingTerm,
  type RankedCandidate,
  type RepositoryRoute,
  type ResolvedOrdering,
  ROUTING_STRATEGIES,
  type RoutingField,
  type RoutingRequest,
  type RoutingStrategy,
  rankCandidates,
  rankSubscriptionAccounts,
  repositoryIdentity,
  resolveOrdering,
  type SortDir,
  type SubscriptionCandidate,
  type UnknownUtilizationPolicy,
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
  ApiSession,
  type ApiSessionConfig,
  createSession,
  describeTransport,
  type TransportConfigs,
} from './transports';
