# Clean daily notes in Gantt Calendar

This opt-in source patch extends **Gantt Calendar 1.6.2**, pinned to
`a06130967bd862a642416e10970ca4bf4cfc7e11`. It does not add a plugin or change Auto Scheduler's Markdown output.

Under `# Day planner` in date-named notes, the patched parser reads:

```markdown
- [ ] 12:40 - 13:10 🔼 Lunch walk
- [ ] 09:00 - 09:30 ⏫ Submit application 📅 2026-10-20
- [x] 18:40 - 19:10 🔼 Dinner walk ✅ 2026-10-04
```

The file supplies the session date; clocks supply its start/end. A start-only appointment defaults to 30 minutes. The real deadline, priority and completion remain separate. Explicit start/scheduled date fields retain their existing behavior. Other sections, fenced examples, invalid dates and invalid intervals do not receive inferred dates.

Set Gantt Calendar's date filter and Gantt start field to **startDate**, its Gantt end field to **scheduledDate**, and its global task prefix filter to empty. Clear any unwanted status/tag filters. Completed rows remain subject to its status filter.

Completion/reopening preserves the clean row without serializing inferred date fields. Other edits to inferred intervals are refused: edit their daily note or use Auto Scheduler to move/replan them. This avoids adding duplicate date metadata or leaving a task under the wrong day's filename. Auto Scheduler still protects generated times/titles against untracked manual edits.

## Build and update an existing installation

Use a separate checkout at the pinned revision, install its locked dependencies, then run the helper from Auto Scheduler's root:

```sh
git -C ../obsidian-gantt-calendar worktree add --detach ../gantt-calendar-clean a06130967bd862a642416e10970ca4bf4cfc7e11
cd ../gantt-calendar-clean
npm ci --ignore-scripts
cd ../obsidian-auto-scheduler
node scripts/build-gantt-compat.mjs ../gantt-calendar-clean /absolute/path/to/vault
```

The helper applies the patch, copies the shared adapter, builds, runs the Gantt regression suite, backs up the installed bundle under ignored `local-test-vaults/install-backups/`, and updates only `gantt-calendar/main.js`. It does not read credentials or modify notes/settings. Save open notes and fully reload Obsidian afterwards.

This is a local compatibility build, not an upstream feature. Updating Gantt Calendar from the community store replaces the patched bundle; rebuild/reinstall for the supported revision. New upstream versions require reviewing and rebasing the patch.

## Other calendar views

Day Planner's Multi-Day View natively reads these clean rows. Set Daily Notes to `DailyNotes`, format `YYYY-MM-DD`; enabled Periodic Notes daily settings override the core settings and must match. A three-day range begins at today and avoids hiding today's Sunday column beyond the right edge of a full-week view. Full-week users can scroll horizontally.

Calendar is a date navigator and note activity indicator, not an hourly task calendar. Clicking an existing date opens its daily note; its dots represent note activity/tasks rather than timed blocks. Use Day Planner or the patched Gantt day/week views for times.

Validated in the `undo` vault on Obsidian 1.13.7: Calendar 1.5.10, Day Planner 0.28.0, and patched Gantt Calendar 1.6.2.
