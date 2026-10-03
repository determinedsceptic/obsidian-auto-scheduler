# Usage

## Settings

All paths are relative to the vault. Hidden folders and `..` are rejected.

To use DeepSeek in AI chat, open **Settings → Community plugins → Auto Scheduler → Add provider**, choose **DeepSeek**, enter your DeepSeek API key, and select **Model for chat** from the list before saving. Editing a saved provider automatically loads its model list; a newly entered key loads models after leaving the key field. **Refresh model list** reloads provider models directly into that dropdown; the manual-ID fallback is collapsed under **Advanced: custom model IDs**. The template offers `deepseek-flash` and `deepseek-v4-pro` through the Chat Completions API. Switch between saved models or providers with the **Model** selector above the sidebar conversation; **Chat model** in plugin settings remains available. The sidebar's **Configure provider / API key** button edits the active provider. Model discovery can refresh the list; model IDs can also be edited manually. API use may be billed by DeepSeek.

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
| Default duration | 30 minutes | Used when a task, event or habit has no explicit duration; 15–1440 minutes, in multiples of 15. |
| Event buffer | 15 minutes | Before and after fixed events. |
| Block buffer | 15 minutes | After tasks and habits when reserving flexible work; adjacent habits may follow each other directly. |

Habits are fixed blocks with minute precision; events and their buffers cannot overlap them. Habit titles may contain ordinary parentheses. Adjacent habits can form a confirmed sequence, while actual overlaps are rejected. Habits outside work windows remain visible without consuming work-window capacity.

## Automatic model discovery

API keys authenticate requests; the plugin obtains model IDs from the configured provider's `/models` endpoint. Opening the assistant loads the active provider's list automatically and saves it for later selection. Switching providers loads that provider's list. **Refresh models** in the sidebar refreshes the catalog without running inference. Provider configuration also loads the list when opened for a saved provider, or when you leave a newly entered key field.

Up to 1,000 returned/saved model IDs are supported; the old 100-choice truncation is removed. Your selected model is preserved. Discovery failure leaves cached choices and the active model intact. An endpoint with no model-list support can still use presets or the collapsed manual-ID fallback. If a provider reports more pages, discovery currently loads its first page and reports that limitation.

A model-list entry is API availability metadata, not proof of text output or tool calling. Image/audio/embedding entries may appear; choose a model that supports the configured API protocol and function tools. OpenAI documents the endpoint in its [API reference](https://developers.openai.com/api/reference/resources/models/methods/list).

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

## Events with only a start time

Ask **“Exercise tomorrow at 19:00.”** The AI calls `create_events` with an unspecified duration; the host uses **Default duration**, initially 30 minutes. The reply reports the actual date, **19:00–19:30**, and the default-duration assumption, then opens the daily note. An explicit duration or end time takes precedence. If a one-off event has no date, the host uses the next occurrence of its start time (today or tomorrow) and reports the assumption. Contradictory dates still require clarification.

One-off events retain their exact start even outside working hours. Flexible work is replanned around them. A conflict with an existing event, habit, protected block, or event buffer rejects the operation before any note changes. Cross-midnight intervals are rejected; specify a shorter same-day duration. Chat-created one-off events must start within the next seven local dates and cannot be in the past. Times use the existing 15-minute grid.

Start-only handwritten rows also reserve the configured default without rewriting their source:

```markdown
# Day planner
- [ ] 11:30 Appointment
```

The fixed-events file accepts `- 2026-10-05 11:30 Appointment`. Habit templates accept `- 19:00 Exercise (Mon, Wed, Fri)`. Recurring AI habits may omit duration too: the host writes an explicit end time to their template and reports the default. Changing the setting changes how handwritten start-only rows are interpreted on the next replan; saved AI events and habits already have explicit end times.

One-off event rows are ordinary fixed appointments; edit them directly in the daily note. They are not flexible AI tasks or generated habit occurrences. Ordinary flexible tasks without an estimate use the same configured default, reported in the answer. With no date, they use the next available working slot. Mixed requests use one validated operation for tasks, events and habits, with a shared undo backup.

## Habits

Run **Create habits template**, or place plain lists in any Markdown file under the configured habits folder:

```markdown
- 07:30-08:00 Morning walk (every day)
- 19:00-19:30 ⏫ Exercise (Mon, Wed, Fri)
- 22:00-22:15 🔽 Read a book (weekends)
```

Recurrence supports case-insensitive English weekday names/abbreviations, `daily`, `every day`, `weekdays`, and `weekends`. Existing Chinese suffixes and old explicit `habit` metadata remain supported. A missing suffix means every day. Fenced rows are examples and do not run. A checked checkbox in a template disables that source habit; checking an occurrence in a daily note completes only that day.

AI creation writes one file per specific habit title, such as `Habits/Lunch walk.md`, `Habits/Dinner walk.md`, and `Habits/Strength training.md`. Each file begins with the same title as its filename and stores editable Markdown lists. Create habits template opens an inactive example at `Habits/Habit template.md`. Existing `AI-Habits.md`, `Habits.md`, `Template.md`, and custom filenames remain readable. It asks for missing start times or recurrence; ordinary tasks use flexible working slots. Same-title habits in the same file are rejected as duplicates. To edit an existing habit, edit its template and replan. Changing title or source path changes identity; changing time or recurrence does not. Completed occurrences and past records survive replan.

## Applying and recovering

Manual commands show a read-only preview. AI creation and revision validate then apply directly. Changes after preview invalidate it. Clean daily output preserves hand-authored content and supports ticking generated blocks; title/time edits invalidate the exact tracked region to prevent accidental overwrite.

In metadata mode, `locked=true` retains a manually positioned block. Clean lists do not display that metadata; undo before editing generated times or titles.

Every write saves the last operation's file contents and tracking first. **Undo last schedule** preflights all files and refuses to overwrite later edits. AI-created habits undo the template and plans together; manual replan does not undo a template you edited yourself. New files are restored to an empty note or `# Day planner` heading rather than deleted.

Obsidian does not provide an atomic transaction across multiple files. If a write fails, inspect the notes and run undo before editing them. If undo refuses because a file changed, back up current notes and plugin data, then compare the recorded before/after snapshots manually. Plugin `data.json` contains private task/backup information; do not post it publicly or delete it casually.

## Read and revise existing daily tasks

Ask “What is in today’s plan?” to use `read_daily_plan`. Ask “Move today’s unfinished ordinary tasks to tomorrow and continue long-term tasks over later days” to read first, then use `revise_daily_tasks`. You can also rename an unfinished task or change its priority. No copy/paste of existing tasks is required.

The host derives paths from the configured daily-note folder and date. Reads expose at most 100 checkbox summaries from `Day planner`, ignoring fenced examples and unrelated sections; the recognized habits section is returned separately as habit context. Chat edits accept only references returned by that send’s reads and refuse stale notes/tracking/task state. Up to three sequential reads are allowed per send across Responses, Chat Completions, Anthropic and Gemini.

For AI tasks, carry-over preserves the original ID, total effort and deadline. Completed blocks stay in their original notes and reduce remaining effort. Target date is an earliest start, allowing long work to continue over later days within the seven-day scheduling window. Habits are loaded from their templates. Handwritten ordinary checkboxes are imported as flexible tasks; timed rows preserve duration and missing durations use **Default duration**, reported in the answer. Selected unfinished source rows are removed; other sections and completed rows remain.

Read dates are limited to the past 30 days and next seven dates; target dates are in the next seven dates. Existing AI total effort cannot yet be changed through chat. Protected source-managed, linked, nested, locked, completed and habitual items must be edited in their source/template where appropriate. Conflicting existing deadlines reject the revision rather than silently dropping the deadline. Unscheduled effort remains saved for a later replan and is reported explicitly. **Undo last schedule** restores the source, destination and AI task state together.

Plain handwritten Tasks/Dataview date and priority fields are accepted on carry-over. Their deadlines and earliest-start constraints are retained; moving beyond the existing deadline is rejected. Management comments and source links remain protected.

## Habit guidelines without clock times

`save_habit_guidelines` stores 1–20 decomposed action items or non-time constraints under `## Habit guidelines` in separate files named after their specific habit titles in the configured habits folder. The assistant lists executable sequences separately from rules and conditions; it must not copy the input paragraph as one item. Plain Markdown bullet lists, grouped under Schedule actions and Rules / conditions, keep the template editable without internal ACTION/RULE tags. Older blockquote templates remain readable and convert on the next save. Exact repeats are deduplicated. Meals, rest offsets, walk durations, weekday training and dietary conditions should be preserved as supplied; they are not interpreted as medical advice.

Daily reads include only explicitly recognized habits sections in addition to task summaries. For whole-plan carry-over, `revise_daily_tasks.guidelines` stages these rules alongside task edits so a single action/undo covers everything. Without editable tasks, use the standalone guideline tool. A guideline-only action stores the list once in the template; daily schedule notes contain only actual scheduled blocks, not copied guideline prose. Every local replan loads fixed-time habit rows from the template; each new daily note shows the resulting time blocks. For the example routine, the assistant lists lunch → rest 10–20 minutes → 30-minute walk; dinner → rest 10–20 minutes → 30-minute walk; and Monday/Wednesday/Friday strength training after the evening walk. Meal end times and a chosen rest duration are required before exact blocks can be created. Strength training uses the configured Default duration when none is given and reports that assumption. Dietary limits and conditional snack guidance stay under Rules/conditions, outside the timed list.

Clean schedules retain visible task deadlines using the public Tasks `📅` syntax. The original task deadline also appears in tool reads and reports. Gantt block-end fields continue to describe scheduled slots; they are not substituted for the task deadline. Tracking and undo preserve the exact former display, including older notes whose deadlines were stored but not visible.

Ask “Add my saved habits to the schedule” to index every Markdown file in the configured habits folder with `read_habits`, then apply fixed-time rows with `schedule_existing_habits`. This writes and opens dated notes without duplicating templates. Relative action lists are converted using confirmed meal anchors; genuinely missing anchors are requested explicitly. The index is independent of daily-note filenames and chat memory.
