import type { SessionTokens } from "./harness-session";

/** Preserve the native payload as well as the counters consumers aggregate. */
export function parseClaudeUsage(value: unknown): SessionTokens | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const usage = value as Record<string, unknown>;
  const tokens: SessionTokens = {
    input: count(usage.input_tokens) ?? 0,
    output: count(usage.output_tokens) ?? 0,
    providerUsage: usage,
  };
  const creation = usage.cache_creation as Record<string, unknown> | undefined;
  const output = usage.output_tokens_details as Record<string, unknown> | undefined;
  const optional = {
    cacheRead: count(usage.cache_read_input_tokens),
    cacheWrite: count(usage.cache_creation_input_tokens),
    cacheWrite5m: count(creation?.ephemeral_5m_input_tokens),
    cacheWrite1h: count(creation?.ephemeral_1h_input_tokens),
    thinking: count(output?.thinking_tokens),
  };
  for (const [key, value] of Object.entries(optional)) {
    if (value !== undefined) Object.assign(tokens, { [key]: value });
  }
  return tokens;
}

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value : undefined;
}
