# Clean daily calendar compatibility

Author: Codex for Alex Hu. Date: 2026-10-04.
Upstream: `integrations/gantt-calendar/README.md`, `docs/compatibility.md`.
Acceptance: automated checks and native UI verification passed; no daily-note rewrite.

## Diagnosis and changes

- Gantt Calendar 1.6.2's native parser reads date fields, not clean clock ranges. Its month view was also showing November rather than the current October.
- Added an explicit opt-in source patch pinned to `a06130967bd862a642416e10970ca4bf4cfc7e11`. Date-named Day Planner notes infer start/end without copying the session end into the task deadline. Completion writes preserve the concise row. Other inferred interval edits are explicitly refused rather than rebuilding the row with duplicate metadata.
- Day Planner 0.28.0 was indexing the actual daily notes. A full-week view placed Sunday outside the visible horizontal area. Switched the existing vault to three days; reload preserves the setting.
- Calendar 1.5.10 was indexing dated notes correctly. Verified a date click opens `DailyNotes/YYYY-MM-DD.md`; hourly block rendering is outside that plugin's behavior.
- Auto Scheduler's Vitest discovery is now scoped to its own `tests/` directory. Before this change it also discovered the separate Gantt Jest worktree's suites, which fail under Vitest despite passing under their own Jest runner. No assertions were removed; both suites are run independently.

## Validation

```sh
npm run typecheck
npm run test
node scripts/build-gantt-compat.mjs local-test-vaults/gantt-compat
```

- Auto Scheduler: 322 tests, including seven new compact interval cases.
- Patched Gantt Calendar: TypeScript/build passed; 22 suites and 393 tests passed, including actual parser and completion write-back coverage.
- Native Obsidian 1.13.7 in `undo`: Gantt monthly view shows scheduled tasks on their note dates; sidebar timeline shows all five of today's task intervals including two completed habits; Gantt bar view indexes the daily rows. Enabled both todo/done in the day, week, month and Gantt status filters to avoid hiding completed habits.
- Native Multi-Day View: October 4–6 columns display their corresponding tasks at the right times and preserve completion marks.
- Calendar: date click opens the correct file in `DailyNotes`.
- Installed bundle backed up under ignored `local-test-vaults/install-backups/`; seven daily Markdown file hashes match the pre-install snapshot.

## Limits

This is a local compatibility build, not an upstream release. Store updates replace it. New upstream revisions require revalidation. Date fields are inferred only under `# Day planner` in valid date-named notes; explicit start/scheduled fields retain precedence. A start-only row defaults to 30 minutes; invalid and overnight unsupported ranges are ignored. Hourly calendar editing of inferred intervals is not supported; use the daily note or Auto Scheduler. Status/tag filters still control visibility; the validated vault now includes todo and done in its day/week/month/Gantt filters.
