import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, readdirSync, lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { ContinuationCapture } from "./continuation";
import { continuationPlan, CONTINUATION_TASKS } from "./continuation-plan";
import { sanitizeArgv, sanitizeVersion } from "./lifecycle";
import { Sanitizer } from "./sanitize";

const sha = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");
/** Reserve before any sample/version/model process. Collisions never overwrite another run. */
export function reserveOutput(root: string, path: string, runId: string) {
  const plan = continuationPlan(path, runId);
  const parent = join(root, "fixtures/s0", runId);
  mkdirSync(parent, { recursive: true });
  const dir = join(root, plan.output);
  mkdirSync(dir); // exclusive; no recursive or existing-directory fallback
  let index = 0;
  return { dir, write(value: unknown, final = false) {
    const file = final ? "recording.json" : `${String(++index).padStart(4, "0")}.json`;
    writeFileSync(join(dir, file), JSON.stringify(value, null, 2), { flag: "wx" });
  } };
}
export function sampleManifest(dir: string) {
  const names = readdirSync(dir).sort();
  const files = CONTINUATION_TASKS.map(task => {
    const file = join(dir, task.file);
    try {
      const stat = lstatSync(file);
      // Never follow a replaced sentinel symlink or read arbitrary new files.
      return { file: task.file, hash: stat.isFile() && !stat.isSymbolicLink() && stat.size <= 4096 ? sha(readFileSync(file)) : null };
    } catch { return { file: task.file, hash: null }; }
  });
  return { alias: "<controlled-sample>", directoryEntriesHash: sha(JSON.stringify(names)), manifestHash: sha(JSON.stringify(files)), entryCount: names.length, files,
    unchanged: names.length === CONTINUATION_TASKS.length && files.every((file, i) => file.hash === sha(CONTINUATION_TASKS[i].content)) };
}

async function main(argv: string[]) {
  const [mode, path, runId] = argv;
  if (argv.length !== 3 || (mode !== "--plan" && mode !== "--capture")) throw Error("Use --plan or --capture, engine, new run ID; capture requires separate operator authorization");
  const plan = continuationPlan(path, runId);
  if (mode === "--plan") { console.log(JSON.stringify(plan, null, 2)); return; }
  // This branch is prepared for later authorization. Never invoked by preparation/check tests.
  const root = resolve(import.meta.dir, "../..");
  const output = reserveOutput(root, path, runId);
  const sample = mkdtempSync(join(tmpdir(), `agent-session-continuation-${path}-`));
  for (const task of CONTINUATION_TASKS) writeFileSync(join(sample, task.file), task.content, { flag: "wx" });
  const sanitizer = new Sanitizer("continuation");
  const version = (cmd: string[]) => {
    const p = Bun.spawnSync(cmd, { cwd: sample, stdout: "pipe", stderr: "pipe", timeout: 5000 });
    return { command: sanitizeArgv(cmd, sanitizer), exitCode: p.exitCode,
      value: sanitizeVersion(cmd[0], new TextDecoder().decode(p.stdout).trim()) };
  };
  const versions = { bun: version(["bun", "--version"]), cli: version([path === "claude" ? "claude" : "codex", "--version"]) };
  const revision = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: root, stdout: "pipe", stderr: "pipe" });
  const commit = new TextDecoder().decode(revision.stdout).trim();
  const sources = ["src/claude-code-session.ts", "src/codex-session.ts", "src/harness-session.ts", "src/turn-state.ts", "src/retained-evidence.ts",
    "scripts/s0/continuation-plan.ts", "scripts/s0/continuation.ts", "scripts/s0/continuation-record.ts", "scripts/s0/sanitize.ts", "scripts/s0/observation.ts", "scripts/s0/lifecycle.ts", "package.json"];
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const packageVersion = typeof pkg.version === "string" && /^\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(pkg.version) ? pkg.version : "unavailable";
  const provenance = { format: 4, evidenceSource: "native-cli", runId, path, startedAt: new Date().toISOString(),
    sourceRevision: /^[a-f0-9]{40}$/.test(commit) ? commit : "unavailable",
    sourceHashes: Object.fromEntries(sources.map(file => [file, sha(readFileSync(join(root, file)))])),
    package: { name: pkg.name === "@inixiative/agent-session" ? pkg.name : "unavailable", version: packageVersion, source: "sibling checkout, not installed in Foundry" },
    requested: plan.requested, versions, tasks: CONTINUATION_TASKS, before: sampleManifest(sample),
    limits: plan.limits, selectedModelEffort: "Only emitted native configuration frames constitute evidence; requests are not acknowledgments" };
  output.write({ ...provenance, status: "reserved-before-start" });
  // Explicit pinned-version contract: a mismatch is recorded as a preflight failure and no
  // model process is ever started. This experiment does not claim portability beyond the pin.
  const preflightFailures = [
    ...(versions.bun.exitCode ? ["bun --version exited non-zero"] : []),
    ...(versions.bun.value !== plan.preflight.pinnedBunVersion ? [`bun version ${versions.bun.value} is not the pinned ${plan.preflight.pinnedBunVersion}`] : []),
    ...(versions.cli.exitCode || versions.cli.value === "unavailable" ? ["native CLI version unavailable"] : []),
    ...(provenance.package.name === "unavailable" || packageVersion === "unavailable" ? ["sibling package identity unavailable"] : []),
  ];
  if (preflightFailures.length) {
    output.write({ ...provenance, status: "version-preflight-failed", preflight: plan.preflight, preflightFailures, modelProcessStarted: false }, true);
    console.log(JSON.stringify({ path, runId, status: "version-preflight-failed", preflightFailures, modelProcessStarted: false }));
    process.exitCode = 1; return;
  }
  const capture = new ContinuationCapture(plan.path, { cwd: sample,
    spawn: (cmd, opts) => Bun.spawn(cmd, { ...opts, stdin: "pipe", stdout: "pipe", stderr: "pipe" }),
    checkpoint: safe => {
      output.write({ ...provenance, capture: safe });
      if (!sampleManifest(sample).unchanged) throw Error("Controlled artifacts changed; no further admission");
    },
  });
  let result: ReturnType<ContinuationCapture["snapshot"]>;
  try {
    result = await capture.run();
    if (!capture.cleanupAllowed()) {
      try { output.write({ ...provenance, capture: result, status: "owned-outcome-unresolved-no-retry" }); }
      catch { /* A rejected evidence write never permits abandoning an owned process. */ }
      console.log(JSON.stringify({ path, runId, status: "owned-outcome-unresolved-no-retry", recording: plan.output }));
    }
  } finally {
    await capture.waitForCleanup(); // attached; late success can never restart run() or send task two
    await capture.closeOwned();
  }
  const after = sampleManifest(sample);
  const final = capture.snapshot();
  const passed = result.stop === "complete" && final.processExited && after.unchanged && !final.observerErrors.length
    && !final.diagnostics.observerFailures.synchronous && !final.diagnostics.observerFailures.asynchronous;
  output.write({ ...provenance, finishedAt: new Date().toISOString(), capture: final, after, passed }, true);
  console.log(JSON.stringify({ path, runId, passed, admittedSends: final.admittedSends, processExited: final.processExited, recording: plan.output }));
  process.exitCode = passed ? 0 : 1;
}
if (import.meta.main) await main(process.argv.slice(2));
