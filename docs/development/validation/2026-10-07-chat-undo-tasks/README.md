# Chat undo and ordinary Tasks entries

- Author: Codex for Alex Hu
- Date: 2026-10-07 (Asia/Shanghai)
- Base commit: 4e1d43e5a1a9832965f745e34817c02ebf6165bb; changes remain uncommitted.
- Upstream: user report that chat cannot undo and ordinary tasks are absent from Tasks.
- Implementation: src/llm.ts, src/chat-view.ts, src/main.ts, src/transaction.ts, src/daily-edit.ts, src/daily.ts, src/study-goals.ts, src/ai-result.ts.
- Downstream: docs/usage.md; dist/auto-scheduler installation files.
- Acceptance: implementation requested by Alex; native UI acceptance remains pending after plugin reload.

## Evidence

- `npm run typecheck`: passed.
- `npm test`: 24 files, 369 tests passed.
- `npm run package`: built main.js and packaged the three installation files.
- Four protocol fixtures (including DeepSeek-compatible Chat Completions) advertise and accept undo; malformed and combined mutations are rejected.
- Undo restores original notes and AI task state after restart. Later manual edits block rollback before any write; the backup remains available.
- Ordinary tasks receive one master checkbox even without available capacity, use one identity across Tasks/time blocks, retain completed effort, and restore source/destination notes on undo.
- Legacy master creation, same-title conflict rejection, master completion, source-note revision, and YAML-frontmatter preservation covered.
- History notes are read for completed effort but are not added to this week’s scheduling documents solely because they hold a master task.

No live provider inference or mutation of real daily notes was used for validation. Native Obsidian UI and live DeepSeek tool selection have not been exercised for this change.
