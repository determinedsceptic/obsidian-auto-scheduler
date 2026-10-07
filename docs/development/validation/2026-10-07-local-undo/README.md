# Local chat undo command

- Author: Codex for Alex Hu
- Date: 2026-10-07 (Asia/Shanghai)
- Base commit: 4e1d43e5a1a9832965f745e34817c02ebf6165bb; working changes uncommitted.
- Upstream: user typed `undo`; model returned prose without executing the available undo tool.
- Implementation: src/chat-commands.ts, src/chat-view.ts.
- Downstream: tests/chat-commands.test.ts, docs/usage.md, dist/auto-scheduler.
- Acceptance: fix requested; native UI acceptance pending plugin reload.

## Cause and correction

Advertising an undo tool leaves execution dependent on model tool selection. Explicit standalone undo commands now dispatch directly to the existing serialized host rollback before reading provider configuration or keys. Button and typed command share one path, with an operation snapshot guard. Normal questions, negations and multi-action requests do not trigger local rollback. Source backups and manual-edit protection are unchanged.

## Evidence

- `npm run typecheck`: passed.
- `npm test -- tests/chat-commands.test.ts tests/chat-undo.test.ts`: 2 files, 32 tests passed.
- Tests instantiate the actual ChatView with a mocked Obsidian host and call its send entry point: `undo` executes the host callback without key reads or API requests, records the host result, reports missing-backup/manual-edit failures and prevents repeated concurrent sends.
- Existing host rollback/protocol tests retained. No real notes were restored or changed during testing.
