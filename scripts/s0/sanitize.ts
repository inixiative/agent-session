// S0 observation only. No raw transcript, reasoning, environment or auth values leave memory.
import { CONTINUATION_TASKS } from "./continuation-plan";
export const PROMPT = "Disposable protocol probe. Use a shell tool to run exactly: bun --version && cat sentinel.txt . Read only this controlled directory. Do not edit files, inspect other directories, use agents, or do other work. Then respond briefly with S0_PROBE_OK and the two observed outputs.";
const tags = new Set(`native_status system init assistant user tool tool_use tool_result text thinking reasoning result success error stream_error session_start session_end session_compact codex/event session_configured task_started task_complete turn_started turn_complete item_started item_completed agent_message agent_message_delta agent_reasoning agent_reasoning_delta agent_reasoning_section_break agent_reasoning_raw_content agent_reasoning_raw_content_delta exec_command_begin exec_command_end exec_command_output_delta token_count token_usage usage tokenUsage command_execution commandExecution agentMessage mcp_tool_call_begin mcp_tool_call_end raw_response_item function_call function_call_output message completed failed interrupted in_progress cancelled initialize initialized notifications/initialized tools/list tools/call thread/start turn/start turn/started turn/completed item/started item/completed thread/tokenUsage/updated notification`.split(" "));
// Installed codex0.153.4 generated schema variants; unknown types still lose payload.
for (const tag of ["userMessage", "functionCallOutput", "local_shell_call", "custom_tool_call", "custom_tool_call_output"]) tags.add(tag);
const labels = new Set(`unknown pending resolved rejected open closed attempted not-dispatched timeout interrupt-request transport rpc blocked killed native-turn ordered-stream user assistant tool system final analysis success error failed completed interrupted in_progress cancelled end_turn tool_use stop_sequence max_tokens shell Bash Read exec_command functions.exec_command functions.exec codex codex-reply gpt-6-astra claude-fable-5-1 xhigh high max medium low minimal never danger-full-access bypassPermissions 2025-06-18 2.0`.split(" "));
const idKeys = new Set(`id admissionId nativeSessionId messageId rpcRequestId eventId session_id sessionId externalSessionId thread_id threadId conversationId turn_id turnId item_id itemId call_id callId tool_use_id parent_tool_use_id uuid request_id`.split(" "));
const numeric = new Set(`timestamp input output input_tokens output_tokens inputTokens outputTokens total_input_tokens total_output_tokens cached_input_tokens cache_read_input_tokens cache_creation_input_tokens reasoning_output_tokens total_tokens cachedInputTokens reasoningOutputTokens totalTokens exit_code exitCode duration_ms duration_api_ms num_turns code context_window model_context_window`.split(" "));
const booleans = new Set(`is_error isError toolError success`.split(" "));
const strings = new Set(`nativeOutcome localOutcome localFailure transportOutcome rpcOutcome correlation dispatch type kind subtype method role phase status stop_reason finish_reason name toolName tool model model_reasoning_effort reasoning_effort effort protocolVersion jsonrpc`.split(" "));
const textKeys = new Set(`text output stdout stderr aggregated_output delta command cmd content result message prompt arguments toolOutput`.split(" "));
const containers = new Set(`attempts terminal params msg event message content structuredContent result error data item turn thread info usage total_token_usage last_token_usage tokenUsage tokens input config capabilities clientInfo serverInfo tools toolInput inputSchema invocation arguments raw modelUsage cache_creation`.split(" "));
strings.add("unattributedReason");
for (const label of ["no-admission", "foreign-session", "foreign-turn", "duplicate-terminal", "after-terminal", "unrecognized-event", "unrecognized-terminal"]) labels.add(label);
for (const key of ["diagnostics", "observerFailures"]) containers.add(key);
for (const key of ["synchronous", "asynchronous"]) numeric.add(key);
const knownKeys = new Set([...idKeys, ...numeric, ...booleans, ...strings, ...textKeys, ...containers]);
const usageContexts = new Set(["usage", "tokens", "tokenUsage", "total_token_usage", "last_token_usage", "cache_creation"]);
const continuationTerminalFields = new Set(["api_error_status", "apiErrorStatus", "terminal_reason", "reason"]);
function typedNumber(key: string, context: string, raw: Record<string, unknown>): boolean {
  if (key === "synchronous" || key === "asynchronous") return context === "observerFailures";
  if (usageContexts.has(context)) return numeric.has(key);
  if (key === "timestamp") return typeof raw.kind === "string" && tags.has(raw.kind);
  if (key === "code") return context === "error";
  const tag = raw.type;
  if (["exit_code", "exitCode"].includes(key)) return ["exec_command_end", "command_execution", "commandExecution"].includes(String(tag));
  if (["duration_ms", "duration_api_ms", "num_turns"].includes(key)) return ["result", "task_complete", "exec_command_end"].includes(String(tag));
  return ["model_context_window", "context_window"].includes(key) && (tag === "task_started" || context === "info");
}

function shape(value: unknown, depth = 0): unknown {
  if (depth > 5) return "depth-limit";
  if (value === null) return "null";
  if (Array.isArray(value)) return { array: value.slice(0, 20).map(v => shape(v, depth + 1)), length: value.length };
  if (typeof value === "object") return { object: Object.entries(value).filter(([k]) => knownKeys.has(k))
    .map(([k, v]) => [k, shape(v, depth + 1)]), omittedKeys: Object.keys(value).filter(k => !knownKeys.has(k)).length };
  return typeof value;
}

export class Sanitizer {
  private ids = new Map<string, string>();
  constructor(private readonly profile: "single-turn" | "continuation" = "single-turn") {}
  ref(value: unknown): unknown {
    if (typeof value !== "string" && !(typeof value === "number" && Number.isFinite(value))) return undefined;
    const key = `${typeof value}:${value}`;
    if (!this.ids.has(key)) this.ids.set(key, `ref-${this.ids.size + 1}`);
    return this.ids.get(key);
  }
  text(value: string): string {
    if (value === PROMPT) return PROMPT;
    if (this.profile === "continuation" && CONTINUATION_TASKS.some(task => value === task.prompt)) return value;
    // Only controlled literals are retained, even inside tool output or errors.
    // Every other character is redacted; reasoning blocks never reach this branch.
    const literals = ["bun --version", "cat sentinel.txt", "S0_SENTINEL_OK", "S0_PROBE_OK", "1.3.14"];
    if (this.profile === "continuation") for (const task of CONTINUATION_TASKS) literals.push(`cat ${task.file}`, task.content.trim(), task.marker);
    const found = literals.filter(t => value.includes(t));
    return found.length ? found.join("\n") : "[redacted]";
  }
  clean(value: unknown, depth = 0, context = ""): unknown {
    if (depth > 18) return { omitted: "depth-limit" };
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "string") return this.text(value);
    if (typeof value === "number") return { shape: "number" };
    if (Array.isArray(value)) return value.slice(0, 500).map(v => this.clean(v, depth + 1));
    if (typeof value !== "object") return { shape: typeof value };
    const raw = value as Record<string, unknown>;
    const tag = raw.type ?? raw.kind;
    // Identity values are pseudonymized even for unknown or omitted item payloads.
    const identities = Object.fromEntries(Object.entries(raw).filter(([key]) => idKeys.has(key))
      .map(([key, val]) => [key, key === "id" && raw.jsonrpc === "2.0" && typeof val === "number"
        && Number.isSafeInteger(val) ? val : this.ref(val)]));
    if (raw.phase === "analysis" || raw.channel === "analysis" || (typeof tag === "string" && /reason|thinking/i.test(tag))) {
      return { ...identities, [raw.kind ? "kind" : "type"]: typeof tag === "string" && tags.has(tag) ? tag : "omitted", omitted: "reasoning" };
    }
    if (typeof tag === "string" && !tags.has(tag)) return { ...identities, type: "unknown", shape: shape(raw) };
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(raw)) {
      if (idKeys.has(key)) out[key] = identities[key];
      else if (this.profile === "continuation" && continuationTerminalFields.has(key)
        && (raw.type === "result" || context === "terminal")) {
        if ((key === "api_error_status" || key === "apiErrorStatus") && typeof val === "number" && Number.isInteger(val) && val >= 100 && val <= 599) out[key] = val;
        else if ((key === "terminal_reason" || key === "reason") && typeof val === "string") out[key] = val === "api_error" ? val : "unknown";
      }
      else if (strings.has(key) && typeof val === "string") out[key] = tags.has(val) || labels.has(val) ? val : "unknown";
      else if (typedNumber(key, context, raw) && typeof val === "number" && Number.isFinite(val)) out[key] = val;
      else if (booleans.has(key) && typeof val === "boolean") out[key] = val;
      else if (textKeys.has(key) && typeof val === "string") out[key] = this.text(val);
      else if (containers.has(key) && typeof val === "object") out[key] = this.clean(val, depth + 1, key);
      else if ((key === "command" || key === "cmd") && Array.isArray(val)) out[key] = val.map(v => typeof v === "string" ? this.text(v) : "[redacted]");
    }
    const omitted = Object.keys(raw).filter(k => !knownKeys.has(k) && !(this.profile === "continuation" && continuationTerminalFields.has(k))).length;
    if (omitted) out.omittedFieldCount = omitted;
    return out;
  }
}

export interface Frame { index: number; firstChunk: number; lastChunk: number; newline: boolean; at: string; value: unknown }
export class FrameRecorder {
  readonly frames: Frame[] = [];
  readonly chunks: Array<{ index: number; bytes: number; at: string }> = [];
  private decoder = new TextDecoder();
  private buffer = "";
  private first = 0;
  private open = false;
  constructor(private sanitizer: Sanitizer) {}
  chunk(bytes: Uint8Array) {
    const index = this.chunks.length;
    this.chunks.push({ index, bytes: bytes.byteLength, at: new Date().toISOString() });
    // Split on newline bytes, so an incomplete UTF8 prefix still owns its first
    // chunk even before TextDecoder produces a character.
    let start = 0;
    const append = (part: Uint8Array) => {
      if (!part.length) return;
      if (!this.open) { this.first = index; this.open = true; }
      this.buffer += this.decoder.decode(part, { stream: true });
    };
    for (let i = 0; i < bytes.length; i++) {
      if (bytes[i] !== 10) continue;
      append(bytes.subarray(start, i));
      this.buffer += this.decoder.decode();
      this.line(this.buffer, index, true);
      this.buffer = ""; this.open = false; start = i + 1;
    }
    append(bytes.subarray(start));
  }
  private line(line: string, lastChunk: number, newline: boolean) {
    if (!line.trim()) return;
    let value: unknown;
    try { value = this.sanitizer.clean(JSON.parse(line)); }
    catch { value = { malformedJson: true, bytes: new TextEncoder().encode(line).length }; }
    this.frames.push({ index: this.frames.length, firstChunk: this.first, lastChunk, newline, at: new Date().toISOString(), value });
  }
  end() {
    this.buffer += this.decoder.decode();
    this.line(this.buffer, this.chunks.length - 1, false); this.buffer = "";
  }
}
