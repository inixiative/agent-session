// @inixiative/agent-session — drive coding-agent CLIs as persistent,
// streaming, event-captured sessions.

// The provider-agnostic interface + event taxonomy.
export * from "./harness-session";

// Claude Code adapter (persistent stream-json session, subscription auth).
export {
  ClaudeCodeSession,
  type ClaudeCodeSessionConfig,
} from "./claude-code-session";

// Codex CLI adapter (persistent JSON-RPC session). CodexSession defaults to the
// mcp-server variant; CodexAppServerSession is the experimental app-server one.
export {
  CodexSession,
  CodexMcpSession,
  CodexAppServerSession,
  type CodexSessionConfig,
  type CodexSpawn,
} from "./codex-session";
