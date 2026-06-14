// @inixiative/agent-session — drive coding-agent CLIs as persistent,
// streaming, event-captured sessions.

// The provider-agnostic interface + event taxonomy.
export * from "./harness-session";

// Claude Code adapter (persistent stream-json session, subscription auth).
export {
  ClaudeCodeSession,
  type ClaudeCodeSessionConfig,
} from "./claude-code-session";
