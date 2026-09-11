import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";

const root = resolve(import.meta.dir, "../..");
const at = new Date().toISOString();
const output = join(root, ".qa", `s0-${at.replaceAll(":", "-")}`);
mkdirSync(output, { recursive: true });
async function fingerprint() {
  const h = createHash("sha256");
  const paths: string[] = [];
  for (const pattern of ["src/**/*.ts", "scripts/s0/**/*.ts", "tests/**/*.ts", "fixtures/s0/**/*", "tsconfig*.json", "package.json"]) {
    for await (const path of new Bun.Glob(pattern).scan({ cwd: root, onlyFiles: true })) paths.push(path);
  }
  for (const path of [...new Set(paths)].sort()) { h.update(path); h.update(readFileSync(join(root, path))); }
  return h.digest("hex");
}
const before = await fingerprint();
const checks: Array<{ command: string[]; startedAt: string; exitCode: number; log: string }> = [];
for (const cmd of [
  ["bun", "test"],
  ["bun", "../foundry/node_modules/typescript/bin/tsc", "--noEmit", "--project", "tsconfig.json", "--typeRoots", "../foundry/node_modules/@types"],
  ["bun", "../foundry/node_modules/typescript/bin/tsc", "--noEmit", "--project", "tsconfig.s0.json", "--typeRoots", "../foundry/node_modules/@types"],
  ["git", "diff", "--check"],
]) {
  const start = new Date().toISOString();
  const p = Bun.spawn(cmd, { cwd: root, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  const file = `${checks.length + 1}.log`;
  writeFileSync(join(output, file), stdout + "\n" + stderr);
  checks.push({ command: cmd, startedAt: start, exitCode, log: file });
}
const after = await fingerprint();
const passed = before === after && checks.every(c => c.exitCode === 0);
writeFileSync(join(output, "report.json"), JSON.stringify({ startedAt: at, finishedAt: new Date().toISOString(),
  before, after, passed, checks, expectedCapabilityFailures: 2,
  interpretation: "Integrity, sanitization and replay checks only. Two S4 test.failing accounting regressions remain unresolved. Offline S1 evidence is not native capability acceptance." }, null, 2));
console.log(JSON.stringify({ passed, report: join(output, "report.json") }));
process.exitCode = passed ? 0 : 1;
