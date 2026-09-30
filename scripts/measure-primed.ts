// Live latency and cache measurement: today's one-process-per-decision
// `codex exec` against primed sessions. Uses the machine's own logins
// (~/.codex, ~/.claude); prints timings, token counts and model names only.
//
//   bun scripts/measure-primed.ts [--runs 4] [--model gpt-6-luna] [--effort low] [--claude haiku]

import { chmodSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CODEX_DECISION_DISABLED_FEATURES, ClaudePrimedSessions, CodexPrimedSessions, type PrimedSessions } from "../src";

const arg = (name: string, fallback?: string) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : fallback; };
const runs = Number(arg("runs", "4")), model = arg("model", "gpt-6-luna")!, effort = arg("effort"), claudeModel = arg("claude");
const dir = () => { const d = mkdtempSync(join(tmpdir(), "agent-session-measure-")); chmodSync(d, 0o700); return d; };
const context = Array.from({ length: 150 }, (_, i) =>
  `- Rule ${i}: files under src/module${i}/ belong to the ${["api", "db", "ui", "auth"][i % 4]} domain; prefer ${["small", "typed", "tested"][i % 3]} changes.`).join("\n");
const instructions = "You classify which domain owns a file path, using only the supplied domain rules. Reply with the domain name only.";
const question = (n: number) => `Which domain owns src/module${n * 7 + 3}/index.ts?`;
const median = (values: number[]) => { const s = [...values].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]!; };

async function baseline(): Promise<number[]> {
  const cwd = dir(), walls: number[] = [];
  for (let n = 0; n < runs; n++) {
    const t = performance.now();
    const proc = Bun.spawn(["codex", "exec", "--json", "--ephemeral", "--skip-git-repo-check", "--ignore-user-config", "--ignore-rules",
      "--sandbox", "read-only", "--cd", cwd, "--model", model, "-c", 'approval_policy="never"', "-c", 'web_search="disabled"',
      ...CODEX_DECISION_DISABLED_FEATURES.flatMap(f => ["--disable", f]), "-"], { cwd, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    proc.stdin.write(`${instructions}\n\n## Domain rules\n${context}\n\n${question(n)}`); proc.stdin.end();
    const events = (await new Response(proc.stdout).text()).split("\n").filter(Boolean).map(line => JSON.parse(line));
    await proc.exited;
    const wall = Math.round(performance.now() - t); walls.push(wall);
    const usage = events.find(e => e.type === "turn.completed")?.usage;
    console.log(JSON.stringify({ path: "codex exec", n, wallMs: wall, answer: events.find(e => e.item?.type === "agent_message")?.item.text,
      input: usage?.input_tokens, cached: usage?.cached_input_tokens }));
  }
  return walls;
}

async function primed(host: PrimedSessions, label: string): Promise<number[]> {
  const walls: number[] = [];
  for (let n = 0; n < runs + 1; n++) {
    const t = performance.now();
    const r = await host.decide({ key: "measure:aux:domain:paths", instructions, context }, { input: question(n) });
    const wall = Math.round(performance.now() - t);
    if (r.prime === "warm") walls.push(wall);
    console.log(JSON.stringify({ path: label, n, prime: r.prime, wallMs: wall, timing: r.timing, answer: r.content, model: r.model,
      input: r.tokens ? r.tokens.input + (r.tokens.cacheRead ?? 0) : undefined, cached: r.tokens?.cacheRead }));
    if (label.startsWith("claude")) await Bun.sleep(1_500);
  }
  await host.close();
  return walls;
}

const exec = await baseline();
const codex = await primed(new CodexPrimedSessions({ model, effort, cwd: dir() }), "codex primed");
const summary: Record<string, number> = { codexExecMedianMs: median(exec), codexPrimedWarmMedianMs: median(codex) };
if (claudeModel) summary.claudePrimedWarmMedianMs = median(await primed(new ClaudePrimedSessions({ model: claudeModel, cwd: dir() }), "claude primed"));
console.log(JSON.stringify({ summary, runs, model, effort: effort ?? "default", claude: claudeModel ?? null }));
