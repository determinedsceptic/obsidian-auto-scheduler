# Editable daily notes

Author: Codex for Alex Hu. Date: 2026-10-07.
Base commit: `c49e06eb2cb5aaed2eefd54683d1d48df4222db7`.
Upstream: an unrelated text edit was rejected because a manually changed calendar row no longer matched hidden event metadata; the user requested freely editable diaries and clarified that Git tracks the plugin only.
Downstream: tracking reconciliation, generic note preparation, task-source lifecycle, scheduler, runtime skills, and installed plugin.

## Changes

- Generic tools can edit every authorized daily-note section, including Day planner and bound task sources. The old calendar equality check and rehydration lock are removed.
- Actual note bytes are authoritative. Missing, edited, duplicated or differently annotated event rows discard old buffer hints independently; no old time or buffer is guessed onto a changed row. Exact unique matches retain current checkbox/completion state. Stale generated spans become handwritten content.
- Generic preparation prunes obsolete metadata in the same transaction as the edit. Scheduling retains its original tracking baseline for conflict checks and a separate reconciled next state. Session context locally filters saved events against current note bytes and sends only surviving rows/buffers.
- Explicit source edits preserve exact bindings or uniquely verified moves; otherwise they detach the binding without rejecting the note edit. Task ID, effort, completion history and session paths remain. Detached tasks receive no new allocation until explicitly rebound; existing unlocked sessions remain preferred soft blocks and may yield to fixed commitments without invented replacements. Completed and explicitly locked history stays protected.
- Scheduling still conserves every bound source. Runtime instructions distinguish an explicit content edit from scheduling side effects. Completion is never inferred from allocated or exhausted minutes.
- Ordinary edits require no recovery command. Optional metadata reset now uses a state-only NoteWorkspace transaction and normal undo journal, without rewriting the note or changing state outside the journal.
- Git ignore rules explicitly exclude personal daily folders, hidden vault configuration and root plugin state from the development repository.

## Evidence

- `npm run typecheck`: passed after the final interface and reset-command changes.
- `npm run package`: passed for the installed runtime.
- Read-only independent review by `editable_diary_review` found no blocking issue in actual-note preservation, source identity, detached scheduling, composition, undo, scope or context. The reviewer did not implement the changes; a separate review of the final state-only reset also found no blocker.
- Read-only Git provenance audit by `diary_git_privacy` found no personal `DailyNotes`, `Daily-Record`, `.obsidian` or `data.json` paths in tracked files or Git history. Date-named Markdown under the older validation directory is documented synthetic compatibility data, not personal diary contents. The prior public commit contains only plugin code, docs, skills, scripts and tests.
- Installation: the plugin was disabled, its three runtime files were backed up locally, replacement was atomic, and packaged/installed SHA-256 hashes matched. After enabling, Obsidian's command palette showed the updated optional metadata command and the assistant reopened.

No tests were added or run, and no inference or diary edit was invoked for validation. Existing tests for the former strict ownership policy were not exercised in this request; this record makes no suite-pass claim. No personal note snapshots, vault paths, state files, credentials or local backup paths are included here.

Installed `main.js` SHA-256: `023c093425e05222af7d60ab4943e4eb6bee98226ce732a9334f46595b15a976`.
