# AS-009: Secret scratch pad

**Status:** ✅ Built (0.10.0, 2026-11-02): `src/secret-scratch.ts`. Foundry turns it on with a setting: Foundry FEAT-005.

## Goal

A session option, off by default, that lets a user hand secrets to an agent without the agent ever reading them. Any agent-session consumer can turn it on; Foundry is the first.

- **Lift.** `liftSecrets(text, { messageId })` takes every word starting with `$$` (the marker ends at whitespace), appends it to the session's scratch pad and returns the text with each one replaced by a reference: `$$ghp_abc…` → `†turn-8f2c.1`. The caller lifts before anything records the message.
- **The scratch pad.** One private file per session (0600, no symlinks, errors never echo contents) that accumulates. Each message that carried secrets adds a dagger naming that message, one numbered block per secret, then a blank line:

  ```
  †turn-8f2c (2026-11-02 14:03, "here's the GitHub App key…")
  [1] ghp_abc123…
  [2] -----BEGIN PRIVATE KEY----- …

  †turn-91d0 (2026-11-02 14:20, "railway token")
  [1] rw_xyz…
  ```

  Consuming a block removes it; a dagger with no blocks left is removed too. An empty pad means nothing is pending.
- **The tool.** `secret_scratch` works on blocks by reference and never returns a value:
  - `write { ref, path, mode: replace | append }`: the value into a file (created 0600).
  - `env { ref, path, key }`: `KEY=value` added or replaced in an env file.
  - `pipe { ref, command }`: the command runs with the value on stdin; returns the exit code only.
  - `list`: the daggers and block numbers, never contents.
  - Every operation but `list` takes `consume: true`, which removes the block after it succeeds. Consuming is explicit because one token often goes to two places (`.env.local` and Railway).
- **The block.** A built-in tool gate denies every other tool call that names the scratch pad or a private path: Read, Grep, Edit, Write, and a shell command whose text names one. A path is private when a segment is named `.private` or ends in `.private`, or a name contains `.private.`, plus any globs the caller adds (`privatePaths`). The scratch pad lives under a `.private` directory, so one rule covers both.

## Why

- Secrets pasted into chat land where nobody can clean them: the model's context, the harness transcript, Archive's capture. Lifting before the message is recorded is the only point where none of them has seen it.
- A tool that returns nothing is the simplest way to let the agent use a value it never reads, on every runtime that calls tools. Rewriting shell commands to drop their output would need a new gate decision (`ToolDecision` is allow / deny, `src/harness-session.ts:401`) and has no Codex equivalent.
- It belongs here, not in Foundry: it is about what a session may see and do, and agent-session already owns a session's tools and gates. Other consumers get it by turning the option on.

## Existing machinery to use

| Concern | Primitive |
|---|---|
| Serving the tool to Claude | `ClaudeSessionExtension` (`src/claude-code-session.ts:184`): an in-process SDK MCP server (`mcpServers`, `mcp()`) |
| Serving the tool to Codex | A stdio MCP server in the Codex launch config, with `approval_mode = "approve"` for this tool only, the way Foundry #267 serves its own tools to Codex |
| The block | `ToolGates` (`src/tool-gate.ts`): composes in order, first deny wins |
| The private file | Foundry's `writePrivateJson` / `readPrivateJson` pattern (`packages/foundry/src/client/private-file.ts`): moves down here and Foundry imports it |

## Limits

- Under Codex full access (`approvalPolicy: 'never'`) no approval reaches the gates (`src/codex-session.ts:982`), so the block doesn't hold there. The scratch tool still works; reading the pad is only discouraged. Foundry honours the host's chosen mode, so this is documented, not forced.
- It stops accidental exposure, not a determined agent: `cp` of a file the tool wrote, or `cat $(ls)`, gets past a text match. Signets and the runner are the structural control.
- Typing straight into a harness doesn't lift anything: only messages sent through a consumer that calls `liftSecrets` do.

## Acceptance

- [ ] Off by default; on, a session serves `secret_scratch` and the gate on Claude and Codex.
- [ ] `liftSecrets("use $$a and $$b", { messageId: "turn-1" })` returns `use †turn-1.1 and †turn-1.2` and appends one dagger with two blocks.
- [ ] `write`, `env` and `pipe` never return a value; a bad reference fails without echoing anything; `list` shows references only.
- [ ] `consume: true` removes the block, and the dagger once empty.
- [ ] Read, Grep, Edit and a `cat` naming the pad or a `.private` path are denied (Claude; Codex with approvals on).
- [ ] The pad file is 0600. The consumer chooses its directory (`scratchDir`) and removes it when the work ends; the pad survives a session restart on the same directory.

## As built (2026-11-02)

- `SecretScratchPad(dir)`: `lift` (synchronous, so a turn path that cannot wait can call it), `list`, `threads`, `env`, `write`, `pipe` (async), `consume`, `clear`, `scrub`, `heldFiles`. A reference is thread, message, position: `†<message>.<n>` inside its thread, `†<thread>/<message>.<n>` from anywhere, so a leftover pad can be found and used from another thread.
- The pad is plain text, one per thread (`<thread>.pad`), values JSON-encoded on their block line; a line it doesn't recognise makes the pad unreadable rather than being dropped on the next rewrite. Only a missing file reads as empty: any other read failure stops the operation.
- `env` writes single quotes when a value holds `$` (no expansion), double quotes with escapes when it holds `'` or a newline, and replaces the last line for the key (loaders take the last). `pipe` reads a key back the same way, kills the whole process group on a timeout, and keeps the block when the command fails.
- Files `env` and `write` touched are recorded (`held-files.json`); `privatePathDenial` refuses a call that names one, a `.private` path, an extra glob or the pad directory. The tool's own calls are exempt only through the caller's `isOwnTool`; the pad directory is never a target.
- **Recognised secrets (0.11.0, Aron 2026-11-02: "Foundry can try and do those for you").** `lift(text, at, { patterns })` also lifts every match of the caller's global regexes, so a token the person forgot to mark (or a private key spanning lines) goes to the pad too, in text order; a match inside a lifted span is left to it, and `recognised` counts them so the caller can remind the person.
- Not done, by design: a multi-line `$$` secret cannot be lifted (one word after `$$`; recognised patterns may span lines); a mid-word or quoted `$$` is not a marker; trailing punctuation is part of the word.
- Limits: a pipe command can still copy a value out (`cat > file`), and the exit code is a one-byte channel. The gate reads names, not contents: a directory-wide search can still reach a held file. Codex under full access asks no approvals, so the gate never sees its calls.
- Reviewed adversarially before release; the findings fixed are in the PR.
