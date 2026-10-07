# Copy Tasks into the following seven days

- Author: Codex for Alex Hu
- Date: 2026-10-07 (Asia/Shanghai)
- Base commit: 4e1d43e5a1a9832965f745e34817c02ebf6165bb; working changes uncommitted.
- Upstream: user-reported copy request removed today’s tasks and wrote clock blocks instead of future Tasks rows.
- Implementation: src/daily-copy.ts, src/daily-edit.ts, src/llm.ts, src/main.ts, src/chat-view.ts.
- Downstream: tests/daily-copy.test.ts, docs/usage.md, dist/auto-scheduler.
- Acceptance: bug fix requested; native UI and live DeepSeek acceptance pending reload.

## Incident and correction

User observation: “把今天的tasks复制之后7天中” deleted source tasks and left no checklist rows in future Tasks sections. Real notes were not inspected or automatically restored in this change.

Code evidence: the available revision tool moved handwritten rows out of their source and created timed blocks. The earlier task-master correction anchored each task in one source note, and did not implement copying into every requested note. A separate literal-copy transaction now preserves source bytes and writes only destination Tasks sections. A host guard prevents a copy request from being executed through a move/create scheduling tool.

## Validation

Targeted suite: 4 files, 75 tests passed. Added nine regression cases covering all seven destination dates, exact source preservation, destination section preservation, one-step undo, repeat-copy deduplication, stale-source rejection, reference/date validation, AI-master references, CRLF, fenced/nested/source-managed exclusions, interrupted writes, DeepSeek-compatible tool routing and incorrect move-tool rejection. No provider API call or mutation of real daily-note contents was used for validation.
