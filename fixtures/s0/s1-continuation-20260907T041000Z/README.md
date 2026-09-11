# Real two-admission continuation captures

Supervisor-authorized captures, 2026-09-07. Source preparation and Fable's deadline
latch received Astra's opposite-model review in Foundry
`docs/S1-recorder-correction-review.md`. Supervisor inspected source, plan commands,
17 independent guards and unchanged historical/script hashes before execution.
Exactly one capture per engine, sequentially; no retries or work-session changes.

| Path | Actual start / finish UTC | Result |
| --- | --- | --- |
| Claude | 04:10:04.291 / 04:10:31.466 | One process, two admissions/writes, two successful native results, owned exit |
| Codex MCP | 04:10:53.851 / 04:11:15.429 | One process, two admissions/writes, two matching task_complete terminals, owned exit |

Commands executed from sibling root:

```sh
bun scripts/s0/continuation-record.ts --capture claude s1-continuation-20260907T041000Z
bun scripts/s0/continuation-record.ts --capture codex-mcp s1-continuation-20260907T041000Z
```

Both plan modes were run first. Bun1.3.14, Claude Code2.1.258,
codex-cli0.153.4. Models actually emitted: claude-fable-5-1 and gpt-6-astra.
MCP emitted effortxhigh; Claude effort remains unknown despite requested max.
Both sentinel directories/file hashes remained unchanged. No observer failures.
Claude correlation is ordered-stream; no invented dedicated native turn ID.
MCP has distinct correlated native turn IDs and one stable thread binding.

Each task produced one joined normalized tool start/result with Bun version and
its own sentinel, plus the actual wire terminal in that admission's frame range.
Supervisor's independent Foundry `native-continuation-recordings.test.ts` checks
those relationships and pins final artifact hashes, not only the passed flag:

- Claude recording.json: `36932ab6a4642d033f8475911cad6421faf653dae2d7a350d5afffe81fc08ed2`
- MCP recording.json: `5f6d23a1ff1234e1fb0b31f2dd77ad530c8093da38e2ae350dd1f1fcec10ded7`

First two-case report `.foundry/qa/2026-09-07T04-12-31.978Z-G5/report.json`
passed with types/diff in Foundry. After hash pinning, all19 independent native
cases across six files pass their test command; combined cross-check reports
`.qa/s0-cross-2026-09-07T04-13-35.502Z/report.json` and
`.qa/s0-cross-2026-09-07T04-14-39.458Z/report.json` are FAILED because concurrent
Foundry learning implementation has incomplete runtime interfaces during its
typecheck. Do not call those full passing gate reports. Repeat combined checks
once that owned implementation settles. Old39 manifest files, including all13
historical artifacts, were unchanged before the explicit cross-check allowlist
addition. No recording or production engine was rewritten.

Bounded native continuation evidence awaits Fable's independent artifact review.
This is not native retention (tasks are independent), cancellation, usage/capacity,
account/subscription continuity, fork/rewind/subsessions, Foundry integration or
full parity. Foundry still uses registry0.1.0; I adoption and T callable scoped
native tools remain required. Do not run more captures under this authorization.
