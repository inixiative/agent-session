import { describe, expect, test } from "bun:test";
import { parseClaudeUsage } from "../src/claude-usage";

describe("parseClaudeUsage", () => {
  test("distinguishes missing counters from reported zero", () => {
    expect(parseClaudeUsage(undefined)).toBeUndefined();
    expect(parseClaudeUsage([])).toBeUndefined();
    const missing = parseClaudeUsage({ input_tokens: 5, output_tokens: 2 });
    expect(missing).not.toHaveProperty("cacheRead");
    const zero = parseClaudeUsage({ cache_read_input_tokens: 0, cache_creation_input_tokens: 12 });
    expect(zero).toMatchObject({ input: 0, output: 0, cacheRead: 0, cacheWrite: 12 });
  });

  test("retains unrecognized tags without treating them as counters", () => {
    const usage = { input_tokens: 1, cache_creation: null, server_tool_use: { web_search_requests: 3 }, service_tier: "priority" };
    expect(parseClaudeUsage(usage)).toEqual({ input: 1, output: 0, providerUsage: usage });
  });
});
