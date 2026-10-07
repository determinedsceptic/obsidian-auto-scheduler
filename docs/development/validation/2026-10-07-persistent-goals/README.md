# Persistent goal correction

- Author: Codex, following Alex Hu's repeated source-loss report.
- Date: 2026-10-07, Asia/Shanghai.
- Base commit: `4e1d43e5a1a9832965f745e34817c02ebf6165bb`; this working snapshot includes the previously authorized uncommitted harness refactor.
- Upstream: [accepted harness design](../../harness-refactor.md), prior generic-harness validation, and Alex's report that long tasks were assigned invented finite duration and disappeared from their original task list.
- Downstream: [architecture](../../../architecture.md), [usage](../../../usage.md), runtime installed in the undo vault, [source hashes](source-hashes.json), and [installation record](installation.json).
- Acceptance: implementation was requested by Alex; recorded checks passed; live provider behavior is not independently confirmed.

## Incident and correction

The previous adapter allowed new tasks without a visible source, accepted Day planner blocks as sources, and defaulted null total duration to a finite short-task duration. Source checks only covered edits composed with a schedule. A later generic edit could delete the source. Finite allocated/checked minutes could complete an unchecked source, and non-clean progress could disappear when historical notes left the planning horizon.

New flexible tasks require an open untimed checkbox outside Day planner under the user's existing or chosen heading. Exact staged source reads permit atomic source creation plus scheduling. Source occurrence/count identify duplicate rows; task IDs and progress survive an explicit source rename or a verified move. Rebinding cannot abandon a still-open source and transfer its history to another goal. Retired terminal sources retain history without occupying a new identical task's binding.

The workspace applies source conservation at staging and commit. Ordinary edits cannot remove pending checkboxes without preserving a source or first recording explicit completion/cancellation. Session blocks cannot replace sources. Unknown total duration remains null and requires a separately specified budget and pace; no default total is inserted. Budget exhaustion never determines source completion. Finite estimate exhaustion while the source is open produces review-needed status. A persisted session-ID ledger retains checked work across horizons and supports reversing explicitly unchecked observed sessions.

Post-write dependency drift now becomes a durable partial operation requiring recovery. Undo restores owned files/state without overwriting concurrently changed dependencies. New adapter-created notes restore empty on undo instead of leaving a managed-region sentinel.

## Independent review

A separate read-only agent inspected source binding, staged overlays, scheduling state, duplicate identity, progress history, and transaction recovery. Findings corrected here: rebind collisions, adoption of an already-existing duplicate as a move, terminal-source revival, source loss during commit, creation from terminal sources, and transfer of history away from an intact open source.

Remaining limits: whether a numeric duration/budget was actually supplied or agreed in natural language is a model policy judgment; numeric validator checks cannot prove that consent. The host enforces source persistence independently of a guessed estimate. A source explicitly marked terminal by ordinary editing updates task state atomically; existing calendar sessions are refreshed by the next explicit replan. Legacy `chat()` and manual compatibility APIs remain; active ChatView uses the new generic harness. This work did not read real personal notes, use a provider/API key, or reconstruct previously lost task rows.

## Validation

| Check | Result | Evidence |
| --- | --- | --- |
| TypeScript | Passed | [typecheck.log](typecheck.log) |
| Full unit/integration suite | 32 files, 500 tests passed | [tests.log](tests.log) |
| Compiled ChatView host simulation | Passed, including staged unknown goal + one confirmed session + later deletion rejection + local undo | [smoke.log](smoke.log) |
| Release checks | Passed; bundle includes binding tool and source/duration safeguards | [release-check.log](release-check.log) |
| Local package | Built | [package.log](package.log) |
| Runtime installation | Three runtime files backed up, installed, and checksums matched | [installation.json](installation.json) |

All LLM responses, vault bytes and provider state in automated checks are fixtures. These checks validate execution contracts and recovery, not the intent interpretation of a live DeepSeek response.

## Failed feedback retained

- Initial persistent-source integration run: 6 passed, 2 failed. Undo of a newly scheduled calendar note left an empty managed-region sentinel; fixed by recording `restored: ''` for new adapter files. A same-session test tried scheduling against a source read before its own completion commit; updated the fixture to re-read the committed source as required by snapshot semantics.
- Two prior checked-source tests expected adding a completed source to create a completed task record. The new contract rejects creating scheduled tasks from terminal sources; assertions now require failure, unchanged source, and no task state.
- After adding protection against transferring history from an intact source, one collision test failed only because an earlier protection returned a different error. The fixture now first cancels that task so the collision check is exercised independently. Final full checks are recorded above.

The old runtime backup is identified in installation.json. Plugin reloading remains a user action. Existing credentials/settings and personal note files were not opened or rewritten during installation.
