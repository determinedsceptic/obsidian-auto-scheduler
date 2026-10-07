# Clean fixed-event display

Author: Codex for Alex Hu. Date: 2026-10-07.
Base commit: `4e1d43e5a1a9832965f745e34817c02ebf6165bb`; changes are included with the accumulated authorized plugin corrections.
Upstream: the user's report of visible `as-event` characters in a fixed appointment.
Downstream: `src/event-tracking.ts`, scheduling transactions, plugin commands, and the installed local plugin.

## Changes

- Clean daily lists store per-event buffer metadata in plugin tracking. Note rows retain actual start/end times and reminder content. Metadata mode still keeps inline comments.
- Virtual rehydration restores event metadata before planning and before managed-region early returns. State normalization retains event-only records, and both commit paths retain full tracking snapshots for undo.
- Exact, unique row anchors accept checkbox and supported completion-date changes. Ambiguous rows and changed times/titles fail conservatively and use the existing tracking recovery flow.
- The local **Clean event display in current daily note** command migrates old inline markers through the normal staged transaction, dependency checks, and durable undo journal without an API request.
- Authorized current-horizon model context and scheduling results expose resolved buffers so later requests do not depend on visible metadata comments.

## Evidence

- `npm run typecheck`: passed after the final source/interface changes.
- `npm run package`: passed after the final source changes.
- `git diff --check`: passed.
- Independent read-only review by `github_sync_audit` found no blocking issue in display, persistence, rehydration, transaction, undo, or command wiring. The reviewer did not implement these changes.
- Installation: the plugin was disabled, its three runtime files were backed up locally, new files were copied atomically and verified by SHA-256, and the plugin was enabled again. The new command appeared in Obsidian's command palette.
- The requested local cleanup completed through that command. Obsidian showed a plain appointment row and the successful cleanup notice; a narrow read confirmed the stored Markdown row had no event comment. The command retained the parsed before/after buffers in the same journaled transaction. No unrelated note edits were requested.

No behavioral tests were added or run for this correction, and no LLM inference was invoked. Replanning/restart/undo behavior was reviewed in source, not exercised against personal notes. Private vault paths, backup paths, note contents, and plugin state are omitted from this public record.

Installed file hashes:

| File | SHA-256 |
| --- | --- |
| `main.js` | `5fe8d47e8c9518141cc8a29d58d6395ee62137dbb71a5d9901dd766d1b4c512d` |
| `manifest.json` | `9ebe8c2c60d43d6851b6849e62b17f9389275fe5c9fa582f50cb94d9b0177764` |
| `styles.css` | `ee843255192ecd00c2bb810eebf96f3ffaba3241ebdf4537c055d607dc0f5def` |
