# Usage

## Settings

All paths are relative to the vault. Hidden folders and `..` are rejected.

| Setting | Default | Meaning |
| --- | --- | --- |
| Tasks folder | `Tasks` | Scan estimated source tasks in this folder and subfolders. |
| Habits folder | `Habits` | Read Markdown habit templates before every replan. |
| Fixed-events file | `Scheduler/Fixed.md` | Explicit busy time; missing means no events from this file. |
| Schedule file | `Scheduler/Schedule.md` | Dedicated output in single-file mode. |
| Output location | Single schedule file | Choose daily notes for date-based plans. AI actions enable daily-note output. |
| Daily notes folder | `DailyNotes` | Output filenames are `YYYY-MM-DD.md`. |
| Clean daily lists | On | Keep tracking in plugin data, not visible note metadata. |
| Working days | `1,2,3,4,5` | Monday through Friday; `0` means Sunday. |
| Working hours | `09:00-12:00,14:00-18:00` | Local time, 15-minute grid. |
| Daily capacity | 360 minutes | Occupied time and buffers inside working hours. |
| Event buffer | 15 minutes | Before and after fixed events. |
| Block buffer | 15 minutes | After each task or habitual block. |

Habits are fixed blocks; events and their buffers cannot overlap them. Habits outside work windows remain visible without consuming work-window capacity.

## Source tasks

```markdown
- [ ] Prepare a report <!-- as id=report remaining=120 priority=4 due=2026-10-07 earliest=2026-10-05 split=true min=30 -->
- [ ] Review slides <!-- as id=slides remaining=45 priority=3 split=false -->
```

| Field | Rule |
| --- | --- |
| `id` | Unique across source tasks; letters, numbers, `_`, `-`. `habit_` is reserved. |
| `remaining` | Required estimated minutes; positive multiple of 15. |
| `priority` | 1–5; 5 highest. Defaults to calendar priority or 3. |
| `due`, `earliest` | Optional local date or `YYYY-MM-DDTHH:mm`. Date-only deadlines include that date. |
| `split` | Defaults to true; false requires one continuous interval. |
| `min` | Defaults to 30 minutes; multiple of 15 and no greater than remaining. Set `min=15` for a 15-minute task. |

Checking the source task prevents further allocation. Completed blocks count toward the task's supplied remaining estimate in the active week. For handwritten sources, maintain `remaining` yourself; do not deduct completed blocks twice. AI task estimates are stored internally and account for earlier completed dates. Ordinary tasks and fenced examples without estimated-task metadata do not participate.

Tasks emoji and Dataview priority/due/start/scheduled fields are accepted. Explicit `as` constraints take precedence. See compatibility for full date-field mode.

## Fixed events

```markdown
# Fixed events
- 2026-10-05 10:00-11:00 Team meeting
- 2026-10-06 14:00-15:00 Appointment
```

Daily-note mode also reads handwritten time ranges under `# Day planner`, outside the generated region. Other daily-note sections are preserved. Full Gantt start/end fields can express busy time. There is no external calendar or ICS import.

## Habits

Run **Create habits template**, or place plain lists in any Markdown file under the configured habits folder:

```markdown
- 07:30-08:00 Morning walk (every day)
- 19:00-19:30 ⏫ Exercise (Mon, Wed, Fri)
- 22:00-22:15 🔽 Read a book (weekends)
```

Recurrence supports case-insensitive English weekday names/abbreviations, `daily`, `every day`, `weekdays`, and `weekends`. Existing Chinese suffixes and old explicit `habit` metadata remain supported. A missing suffix means every day. Fenced rows are examples and do not run. A checked checkbox in a template disables that source habit; checking an occurrence in a daily note completes only that day.

The AI tool always appends to `Habits/AI-Habits.md` (or the configured folder). It asks for missing fixed times; ordinary tasks use flexible working slots. Same-title habits in the same file are rejected as duplicates. To edit an existing habit, edit its template and replan. Changing title or source path changes identity; changing time or recurrence does not. Completed occurrences and past records survive replan.

## Applying and recovering

Manual commands show a read-only preview. AI creation validates then applies directly. Changes after preview invalidate it. Clean daily output preserves hand-authored content and supports ticking generated blocks; title/time edits invalidate the exact tracked region to prevent accidental overwrite.

In metadata mode, `locked=true` retains a manually positioned block. Clean lists do not display that metadata; undo before editing generated times or titles.

Every write saves the last operation's file contents and tracking first. **Undo last schedule** preflights all files and refuses to overwrite later edits. AI-created habits undo the template and plans together; manual replan does not undo a template you edited yourself. New files are restored to an empty note or `# Day planner` heading rather than deleted.

Obsidian does not provide an atomic transaction across multiple files. If a write fails, inspect the notes and run undo before editing them. If undo refuses because a file changed, back up current notes and plugin data, then compare the recorded before/after snapshots manually. Plugin `data.json` contains private task/backup information; do not post it publicly or delete it casually.
