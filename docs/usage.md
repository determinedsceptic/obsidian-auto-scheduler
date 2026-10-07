# Usage

## Active AI chat

The assistant uses host tools rather than special phrases or fixed note headings:

1. `discover_notes` locates notes inside the authorized scope.
2. `read_note` returns an outline, full document, section, or Markdown block with a version-bound reference.
3. `stage_note_changes` prepares insertions, replacements, and deletions without writing.
4. `bind_task_source` stages a source binding or rebind for an existing scheduler task without allocating time.
5. `plan_schedule` stages Day planner changes only when time allocation was explicitly requested. It can compose with an already staged note edit or binding.
6. `commit_changes` checks every read dependency and plugin-state version, then writes and returns a durable receipt.
7. `undo_operation` restores the latest identified operation when its current files and state still match.

A staged result is not a commit. The sidebar derives success, changed files, state changes, warnings, links, and undo availability from the host receipt. Model text cannot manufacture these facts. If the model request fails after a commit, the receipt remains visible.

### Note structure

Headings, filenames, lists, checkboxes, and paragraphs are arbitrary user organization. The same tools can edit `# Tasks`, `## Research`, `## 待办`, a paragraph, or a list under another heading without assigning special meaning to those locations. Active chat preserves unrelated frontmatter, headings, nesting and line endings. It does not automatically create `# Tasks`, move untimed checkboxes, or turn a normal note edit into a schedule.

A task or goal that will be scheduled has one persistent, user-visible unchecked, untimed checkbox (`[ ]`) in the section the user chooses. The checkbox remains there while dated Day planner rows represent work sessions. Scheduling alone never moves, deletes, or completes the source. A Day planner section cannot hold that untimed checkbox because the active adapter rejects source bindings there.

The host also protects this invariant during generic note editing: an open task's source cannot disappear. The user can explicitly edit or move it, complete it with `[x]`, or cancel it with `[-]`. Deleting a source with pending work requires first saving one of those terminal states, followed by an explicit deletion request. Scheduled sessions by themselves never justify removing the source.

To copy content, ask the assistant to read the source and stage insertions at the requested destinations. To move content, it must stage both destination insertion and source deletion. Either operation can be reviewed and undone as one transaction.

### Scope

The default chat scope contains:

- the currently open Markdown note, when one is open;
- valid `YYYY-MM-DD.md` notes in the configured daily-note folder.

Use **Additional note folders** to grant access to other folders. Paths remain vault-relative; hidden paths and `..` are rejected. A folder setting grants discovery/read/write scope, but the model receives note content only after a read tool call. Merely opening a note or discovering its path does not send the body.

The configured task and habit folders remain inputs to the manual scheduler. Active scheduling still checks its fixed-event and daily-note dependencies locally. None of these paths automatically expands model-visible scope, and trusted dependency bytes are not returned by a tool.

### Runtime skills

With no custom skill files, the installed note-editing and scheduling skills are used. **Runtime skill files** accepts vault-relative Markdown paths. If any are configured, they replace all bundled defaults and are reloaded on every send. This makes instruction changes effective without a plugin rebuild.

Skill files are sent to the configured provider. They can advise where or how to edit, but cannot grant scope, bypass snapshots, write a note, or claim a commit.

## Scheduling from chat

The assistant calls `plan_schedule` only for an explicit request to allocate time. Its normalized input can include:

- flexible tasks with `minutes` (a known total or `null` when genuinely unknown), priority, splitting, minimum block, deadline, earliest start, `rollingMinutes`, `dailyMinutes`, and source-binding information;
- exact one-off events with optional `beforeMinutes` and `afterMinutes`;
- habit rows selected from any authorized note or section.
- `flexibleRefs` for read handwritten calendar rows whose times the user explicitly described as approximate or movable.

The active adapter always renders date-based Day planner output, regardless of the legacy manual **Output location** or **Output format** setting. Source notes are read dependencies and stay byte-for-byte unchanged unless the user requested a generic edit.

For a new schedulable task, the assistant stages an unchecked, untimed checkbox outside Day planner with `stage_note_changes`. It then reads the staged overlay with `read_note(documentRef, mode: "document", changeSetRef: stagedChangeSetRef)`, takes that checkbox's returned `blockRef`, and calls `plan_schedule` with `sourceRef: blockRef` and the exact same `changeSetRef`. One `commit_changes` call saves the source and sessions together, so one undo restores both. An existing bound task may pass `sourceRef: null` to retain its binding. A selected legacy task with no binding must be explicitly bound to a read checkbox block; titles alone are insufficient.

`bind_task_source` accepts `{taskId, sourceRef, changeSetRef, title}` and only stages a binding change. Use it to bind a legacy task or rebind an existing task after its source is renamed or moved. `changeSetRef` is the exact staged edit reference for that `sourceRef`, or `null` for a source read from saved content; `title` is the new title or `null`. Rebinding preserves the scheduler task's ID, budget, and history and does not allocate time. After a staged rename or move, read the staged document to obtain the new checkbox `blockRef`, then pass that reference and the same staged `changeSetRef` to `bind_task_source`. To schedule in the same transaction, pass the binding result's `changeSetRef` to `plan_schedule`, use `sourceRef: null` for the now-bound existing task, and commit the final combined change set once.

The scheduler retains existing AI task state and existing habit occurrences. New recurring habit occurrences enter active chat scheduling through explicit `habitRefs`; the manual scheduler continues to scan the configured habits folder. The configured templates also identify existing plain handwritten habits through a unique match of occurrence date, times, and title, without adding missing occurrences. Unknown or ambiguous handwritten events remain hard. A source-linked task uses an internal ID independent of its title, so equal titles in distinct source blocks are allowed. If the source checkbox later changes completion state, a subsequent plan reconciles it from the exact stored source text. Completing a session block does not complete or remove its source.

The proposed result gives separate counts for persistent source checkboxes, scheduled session blocks, and pending or unscheduled budget, along with day-capacity statistics. This keeps “one saved task” distinct from “several sessions scheduled for it.” No output claim means “committed” until `commit_changes` succeeds. Immediately before commit, the host rechecks the local date, time zone, exact-event starts and newly added unlocked blocks.

### Start-only events

An explicit event such as “Exercise tomorrow at 19:00” uses **Default duration** when no duration was supplied. The initial default is 30 minutes, so the staged row is `19:00 - 19:30`. An undated event uses the next occurrence of its start time. Exact events must start inside the seven-day horizon, cannot be in the past, and cannot overlap fixed time or its configured buffer.

### Fixed appointments take precedence

An unfinished habit's displayed time is a preference. A fixed appointment and its buffers override overlapping habit occurrences and flexible task sessions regardless of numerical priority. Unaffected habits stay in place; displaced occurrences are reported as unscheduled, without deleting their templates or task sources. The scheduler does not invent replacement habit times. Completed records and locked non-habit blocks remain protected, and two hard appointments still produce a conflict.

For a train departing at 14:00 and arriving at 17:00 with one hour on both sides, the event keeps its actual `14:00 - 17:00` row and reserves `13:00 - 18:00`. With clean daily lists enabled, resolved buffers are retained in plugin tracking rather than displayed in the note. Later planning, restarts, and undo preserve them. Metadata mode retains the inline comments. Missing or null buffers use **Buffer around fixed events**; explicit `0` is supported.

Use **Clean event display in current daily note** to remove old inline event markers from the open dated note while retaining their buffers and an undo journal. This command changes only validated event markers. Clean tracked event rows support checkbox changes; after manually changing their times or titles, use the existing tracking recovery command before planning again.

For other handwritten approximate plans, the assistant passes previously read `flexibleRefs` only when the user declared them movable. If a hard appointment overlaps one, its clock reservation is released and its unchecked reminder remains in the note. No task heading name or activity keyword determines certainty.

For a flexible task with known total effort, `minutes` is that total. For genuinely unknown total effort, `minutes` is `null`; the active adapter does not apply **Default duration** as a total estimate. Before scheduling it, the user must confirm both `rollingMinutes`, the time budget for the current seven-day horizon or another agreed cadence, and `dailyMinutes`, the maximum to reserve on one day. A single session is valid, such as `rollingMinutes: 30` with `dailyMinutes: 30`. These values express budget and pace only: they do not imply total effort, percent complete, or a finish date. Without both confirmed values, the assistant saves the persistent source and asks one focused question for the missing budget and pace.

## Undo and recovery

Use **Undo last operation** in the sidebar or command palette without a provider. Exact chat inputs `undo` and `/undo` are also intercepted locally before key lookup or inference. Other wording, including a natural-language request that combines undo with more work, goes through the normal harness and must use the exact current operation ID.

Undo covers the latest durable operation across conversations. It checks all files and state first and refuses to overwrite later edits. A newly created note is restored to an empty note when no original bytes existed; undo does not delete it.

Before any file or state mutation, the host saves a durable journal. State-only operations, such as retaining a valid task that did not fit this week, are recoverable after restart. If a multi-file write stops partway through, its receipt says `partial`; subsequent commits remain blocked until the operation is undone or otherwise recovered. A restart retains that recovery lock and journal.

Chat history itself remains in memory and resets when the plugin or Obsidian restarts. Operation recovery is stored separately and survives.

## Providers and model discovery

Add or edit a provider under plugin settings. The installed code contains templates for supported protocols and endpoints. Opening the assistant or provider editor loads the configured endpoint's model list when supported. **Refresh models** repeats that metadata request. Cached choices remain available if discovery fails, and a manual model ID is an advanced fallback.

A model-list entry confirms only that the endpoint advertised an ID; it does not prove text generation or tool support. Choose a model that implements function tools for the selected protocol.

Use **Auto Scheduler: Check API connection (no token)** to make an unauthenticated connection check. An HTTP response proves network reachability, not key validity, model access, quota, or tool behavior.

## Manual offline scheduler

Manual scheduling does not use AI chat. It continues to scan the configured folders and files using the compatibility schemas below.

| Setting | Default | Manual/local meaning |
| --- | --- | --- |
| Tasks folder | `Tasks` | Scan estimated task metadata in this folder and subfolders. |
| Habits folder | `Habits` | Scan recurring fixed-time Markdown rows. |
| Fixed-events file | `Scheduler/Fixed.md` | Read explicit busy intervals; a missing file means none. |
| Schedule file | `Scheduler/Schedule.md` | Output target in legacy single-file mode. |
| Output location | Single schedule file | Manual choice between one file and dated daily notes. |
| Daily notes folder | `DailyNotes` | Dated output and the active chat's Day planner destination. |
| Clean daily lists | On | Store generated identity in plugin tracking instead of visible comments. |
| Working days | `1,2,3,4,5` | Monday–Friday; `0` is Sunday. |
| Working hours | `09:00-12:00,14:00-18:00` | Local time on a 15-minute grid. |
| Daily capacity | 360 minutes | Occupied time and buffers inside working hours. |
| Default duration | 30 minutes | Fallback for tasks, events, and habits without an end. |
| Event buffer | 15 minutes | Reserved before and after fixed events. |
| Block buffer | 15 minutes | Reserved after flexible tasks and habits. |

Run **Preview weekly schedule**, inspect additions, removals, errors, capacity, and unscheduled work, then choose **Apply schedule**. The horizon is today plus six days.

### Estimated tasks

```markdown
- [ ] Prepare a report <!-- as id=report remaining=120 priority=4 due=2026-10-07 earliest=2026-10-05 split=true min=30 -->
- [ ] Review slides <!-- as id=slides remaining=45 priority=3 split=false -->
```

| Field | Rule |
| --- | --- |
| `id` | Unique letters, numbers, `_`, or `-`; `habit_` is reserved. |
| `remaining` | Required positive minutes, in multiples of 15. |
| `priority` | 1–5; calendar priority or 3 is used when omitted. |
| `due`, `earliest` | Optional local date or `YYYY-MM-DDTHH:mm`. |
| `split` | Defaults to true; false requires one continuous interval. |
| `min` | Minimum block, default 30, a multiple of 15 and no longer than remaining. |

Checking the source task prevents future allocation. Ordinary tasks and fenced examples without compatible metadata are ignored by the manual task scanner. Tasks emoji and supported Dataview priority/due/start/scheduled fields remain compatible.

### Habits

```markdown
- 07:30-08:00 Morning walk (every day)
- 19:00-19:30 ⏫ Exercise (Mon, Wed, Fri)
- 22:00-22:15 🔽 Read a book (weekends)
```

Rows can live in any Markdown file under the configured habits folder. English or Chinese day names, `daily`, `every day`, `weekdays`, and `weekends` are supported. No suffix means every day. Fenced rows are inactive examples; a checked template checkbox disables that source habit. Checking a daily occurrence completes only that occurrence.

Active chat may instead pass an explicitly read habit row or section from another authorized note. It does not force that note into a particular filename or heading.

### Fixed events and handwritten occupied time

```markdown
# Fixed events
- 2026-10-05 10:00-11:00 Team meeting
- 2026-10-06 14:00 Appointment
```

A start-only fixed row uses **Default duration**. Daily-note mode also reads handwritten clock ranges under `# Day planner`, outside the generated region. Other sections remain unchanged. There is no external calendar or ICS import.

## Calendar compatibility

Clean daily output uses compact rows such as `- [ ] 12:40 - 13:10 🔼 Lunch walk`. Day Planner reads this format. The optional [Gantt Calendar compatibility build](../integrations/gantt-calendar/README.md) reads the note date and clock range while preserving task deadlines and completion. Legacy full date-field output remains available to the manual scheduler.

Task deadlines remain independent of scheduled block ends. The scheduler is deterministic and capacity-aware, but greedy rather than globally optimal. Unallocated work remains explicit instead of overlapping fixed time or disappearing.

## Historical examples

The screenshots and deterministic fixtures under `examples/` were captured before the generic harness replaced specialized daily-task and habit routes. They remain historical validation artifacts for UI and calendar formatting. Current chat should be judged by staged changes and host receipts, not by reproducing the old prompt-to-file routing.
