Stdout frames of real `claude` 2.1.316 runs (Haiku, `--print --input-format stream-json`), recorded 2026-11-02 while a stream-json user message with `priority: "next"` was written into the running turn (`steer-written` marks the moment; `__STEER_UUID__` is its uuid). `init` frames are reduced to their session id; partial-message and thinking-progress frames are dropped.

- `fold-in`: the turn took the steer in after its tool result: one result.
- `follow-on`: the turn's reply was final when the steer arrived: it ran after the first result, as a second one.
- `withdraw`: as follow-on, then `cancel_async_message` (answered `cancelled: false`, the steer had started) and `interrupt`: the second result is `error_during_execution`, `aborted_streaming`.
