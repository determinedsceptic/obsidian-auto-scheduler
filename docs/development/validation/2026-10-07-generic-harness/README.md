# Generic harness implementation and installation

- Author: Codex, with delegated implementation and independent review.
- Date: 2026-10-07, Asia/Shanghai.
- Accepted by: Alex Hu's instruction “开始做吧”.
- Base Git commit: `4e1d43e5a1a9832965f745e34817c02ebf6165bb`; implementation is in the working tree. Earlier uncommitted work is retained.
- Upstream: [accepted refactor](../../harness-refactor.md).
- Downstream: [current architecture](../../../architecture.md), [usage](../../../usage.md), installed runtime.

## Implemented

- Generic scoped discovery, structural reading, insert/replace/delete staging, commit, and undo.
- Four provider protocols share a complete tool-result execution loop. DeepSeek uses the Chat Completions path.
- Note headings are data. Copying leaves its source intact; ordinary editing does not invoke the scheduler or create Tasks headings.
- Explicit scheduling writes Day planner output. It accepts selected source blocks and habit references without implicitly scanning configured task/habit folders.
- Generic edits and scheduling can compose into one change set, one commit, and one undo. Prior temporal validators survive composition.
- Runtime Markdown skills replace bundled defaults and reload on every send.
- Durable snapshots, state-only transactions, stale-reference rejection, interrupted-write and interrupted-undo recovery, and persisted partial-operation locks.
- Host receipts survive provider failures, Clear, and sidebar close during a commit. Text-only turns explicitly report no files changed. Exact `/undo` and `undo` work offline and emit host results.

## Validation

| Check | Result | Evidence |
| --- | --- | --- |
| TypeScript | Passed | [typecheck.log](typecheck.log) |
| Full suite | 31 files, 476 tests passed | [tests.log](tests.log) |
| Compiled host simulation | Passed | [smoke.log](smoke.log) |
| Bundle/release integrity | Passed | [release-check.log](release-check.log) |
| Local package | Passed | [package.log](package.log) |
| Installed files | All three checksums match package | [installation.json](installation.json) |

The real `createAgentSession`/`runAgent` integration covers seven-destination copying under Tasks, Chinese, custom and nested-level headings for all four protocols. It checks source bytes, existing destination contents, calendar preservation, state, restart undo, scope, skill reload, state-only journal loading, checked multiline source items, composition into newly created notes, inherited time validation, and host write failures after mutation.

Compiled ChatView fixtures cover no-tool prose, write-result feedback, provider failure after commit, tool failure, quota and retry behavior, cancellation, partial writes across restart, local undo, runtime rules, and conversation ownership during Clear/onClose.

No paid provider call, real daily-note mutation, plugin data/credential read, or live Obsidian UI validation was performed during this refactor. Installation touched only `main.js`, `manifest.json`, and `styles.css`. Reload the plugin to activate it.

## Independent review and retained failure

A fresh GPT-6 Astra reviewer identified boundary-edit corruption, missing undo state checks, interrupted-undo recovery, legacy partial-lock bypasses, missing commit-time validation, a checkbox completion regex error, grouped task references, legacy operation ID mismatch, and dropped validators during composition. These findings were fixed with affected regression coverage. The reviewer reported no further critical storage or scope issue after checking the earlier fixes; the final composed-validator regression passes.

One compiled smoke assertion became obsolete after local undo began emitting host receipts: it asserted that the entire conversation contained no receipt during a later quota failure. The failure was retained here as a fixture issue. The corrected assertion records the prior count and verifies that quota failure emits no new receipt; it preserves the intended no-effect check.

## Practical limits

Actual model tool selection is not guaranteed by a harness or skill. Host results describe what executed even if model prose is inaccurate. One durable undo operation is retained, and newly created notes are restored to empty content instead of deleted. The new runtime is still version 0.6.0; exact source and installed build identities are recorded in [source-hashes.json](source-hashes.json) and [installation.json](installation.json).
