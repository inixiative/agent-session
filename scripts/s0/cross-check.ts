import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";

const root = resolve(import.meta.dir, "../..");
const startedAt = new Date().toISOString();
const dir = join(root, ".qa", `s0-cross-${startedAt.replaceAll(":", "-")}`);
mkdirSync(dir, { recursive: true });
async function snapshot() {
  const paths: string[] = [];
  for (const pattern of ["src/**/*.ts", "scripts/s0/**/*.ts", "tests/**/*.ts", "fixtures/s0/**/*", "tsconfig*.json", "package.json"]) {
    for await (const path of new Bun.Glob(pattern).scan({ cwd: root, onlyFiles: true })) paths.push(path);
  }
  const files: Record<string, string> = {};
  for (const path of [...new Set(paths)].sort()) files[path] = createHash("sha256").update(readFileSync(join(root, path))).digest("hex");
  return { sha256: createHash("sha256").update(JSON.stringify(files)).digest("hex"), files };
}
const before = await snapshot();
const allowed = ["native-recording-safety", "native-turn-ownership", "native-terminal-evidence", "native-historical-evidence", "native-continuation-ordering", "native-continuation-recordings", "native-compaction-evidence", "native-mcp-tool-normalization", "native-bridge-late-settlement"]
  .map(name => `fixtures/harness-qa/acceptance/${name}.test.ts`);
const requested = process.argv.slice(2);
const testFiles = requested.length ? requested : [allowed[0]];
if (testFiles.some(file => !allowed.includes(file))) throw new Error("Choose an explicit supported independent native acceptance file");
const command = ["bun", "scripts/harness-check.ts", "G5", ...testFiles];
const p = Bun.spawn(command, { cwd: resolve(root, "../foundry"), stdout: "pipe", stderr: "pipe" });
const [stdout, stderr, exitCode] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
const after = await snapshot();
writeFileSync(join(dir, "check.log"), stdout + "\n" + stderr);
const foundryReport = stdout.match(/Evidence: (.+\/report\.json)/)?.[1];
const passed = exitCode === 0 && before.sha256 === after.sha256;
writeFileSync(join(dir, "report.json"), JSON.stringify({ startedAt, finishedAt: new Date().toISOString(),
  command, foundryReport, exitCode, before, after, passed,
  testFiles, scope: "Only the explicitly listed unchanged independent tests; sibling manifest and Foundry source fingerprints retained." }, null, 2));
console.log(JSON.stringify({ passed, foundryReport, report: join(dir, "report.json") }));
process.exitCode = passed ? 0 : 1;
