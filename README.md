# Auto Scheduler

Auto Scheduler edits Obsidian notes through a tool-driven assistant and turns explicitly selected work into a seven-day Day planner schedule. The scheduler itself is local and deterministic; AI chat is optional and uses a provider you configure.

Desktop only; minimum Obsidian version **1.6.6**.

## What it does

- **Edit ordinary Markdown without prescribing its layout.** Chat can discover authorized notes, read a document, heading or block, stage exact changes, inspect them, and commit them. A heading such as `## Research`, `# Tasks`, or `## 待办` is user data rather than a host requirement.
- **Keep daily notes editable.** Every authorized section, including Day planner, can be edited directly. Old schedule metadata never locks the note; changed or ambiguous rows are authoritative and lose obsolete bindings.
- **Schedule only when requested.** `plan_schedule` turns explicit task constraints, exact events and selected habit rows into compatible `# Day planner` clock entries. Active chat does not create a `# Tasks` section, move ordinary checkboxes, or reorganize source notes.
- **Fixed appointments take precedence.** Exact events and their own before/after buffers override unfinished habits and movable sessions. Habit templates and task sources remain intact; completed records and other fixed commitments remain protected.
- **Keep execution verifiable.** The host retains durable commit receipts. Chat shows concise Markdown replies, with a brief actual outcome if an operation is incomplete or the model stops after writing. Routine host diagnostics stay out of the transcript.
- **Protect concurrent edits.** Every commit rechecks the note versions and plugin state that were read. Multi-file writes have a durable recovery record, including state-only scheduling changes.
- **Undo the latest operation.** The sidebar and command palette work offline. Exact chat commands `undo` and `/undo` also run locally; natural-language rollback requests go through the assistant tools.
- **Keep legacy local scheduling.** The manual preview command still scans configured task, habit and fixed-event sources and schedules the current local day plus six more days.

## Installation

The project is preparing its first community-directory submission and is not yet listed in Obsidian's Community plugins browser.

Build from source or install `main.js`, `manifest.json`, and `styles.css` from a published [GitHub release](https://github.com/determinedsceptic/obsidian-auto-scheduler/releases):

1. Create `<vault>/.obsidian/plugins/auto-scheduler/`.
2. Copy the three plugin files into that folder.
3. Reload Obsidian and enable **Auto Scheduler** under **Settings → Community plugins**.
4. Try it in a separate vault and back up plugin data with your notes.

GitHub's source-code ZIP is not an installable plugin because it does not contain the built `main.js`.

## Quick start

1. Click the calendar-clock ribbon icon or run **Auto Scheduler: Open AI assistant**.
2. Add a provider in plugin settings, enter a key if the endpoint requires one, and select a tool-capable model. The included provider templates come from the installed code. Model discovery reads the configured provider's model list when supported; a manual model ID remains available as a fallback.
3. Open the note you want to work with. By default, chat can access that current note and valid dated notes in the configured daily-note folder. Add other vault-relative folders explicitly under **Additional note folders**.
4. Try: **“Under my Research heading, add two review items. Then schedule 90 minutes for the first one.”** The assistant should show a staged change, commit it, and return links to changed notes.
5. Use **Undo last operation**, `undo`, or `/undo` to restore the latest committed operation if the affected files have not changed since it ran.

Chat follows a generic transaction loop:

```text
discover -> read -> stage -> commit -> host receipt
                         \
                          plan_schedule -> same change set and receipt
```

Discovery does not send an entire vault to the model. Host context includes saved task summaries and matching event rows/buffers; other note bodies are sent through authorized read tools. References are tied to the bytes read, so edits based on an outdated read are rejected.

## Runtime skills

The plugin ships default note-editing and scheduling instructions. **Runtime skill files** accepts up to eight vault-relative Markdown files. When this list is non-empty, those files replace the bundled defaults and are reloaded on every send, so changing them requires no rebuild or restart.

Skills guide the model's choices but cannot enlarge file scope, bypass snapshot checks, or create a successful receipt. Their contents are sent to the selected provider as instructions; ordinary note contents remain untrusted data.

## Manual offline scheduling

Local scheduling needs no provider, account, key, or network connection. Configure the task folder, habit folder, fixed-events file, work windows, capacity and output settings, then run **Preview weekly schedule** and **Apply schedule**.

Estimated source tasks use the compatibility metadata format:

```markdown
- [ ] Prepare a report <!-- as id=report remaining=120 priority=4 split=true min=30 -->
- [ ] Review the slides <!-- as id=slides remaining=45 priority=3 split=false -->
```

Habit templates remain plain Markdown:

```markdown
- 19:00-19:30 Evening walk (every day)
- 07:30-08:00 ⏫ Exercise (Mon, Wed, Fri)
- 22:00-22:15 🔽 Read a book (weekends)
```

The manual scheduler retains the existing Tasks/Dataview, habit, fixed-event, Day Planner and Gantt compatibility schemas. These compatibility parsers do not make `# Tasks` a requirement for active chat.

## Transactions and recovery

The model first stages concrete file and state changes. `commit_changes` then checks every dependency, validates scheduler time assumptions, saves a durable undo record, and performs compare-and-write updates. File edits and an explicit schedule can share one change set and one undo operation.

Obsidian has no atomic multi-file write API. If a later file fails, the operation is recorded as partial and further commits are blocked until recovery. Restart preserves committed, state-only and partial-operation recovery data. Undo refuses to overwrite later user edits.

When an operation created a note that did not exist, undo restores an empty note. It does not delete the file.

## Commands

| Command | Purpose |
| --- | --- |
| Open AI assistant | Open the chat sidebar. |
| Start new AI conversation | Start a separate in-memory conversation. |
| Clear AI conversation | Cancel local waiting and clear the selected messages and draft. |
| Preview weekly schedule | Preview the offline scheduler's seven-day result. |
| Clean daily schedule format | Remove legacy display metadata from tracked daily output. |
| Clean event display in current daily note | Hide old inline event markers while retaining matching buffer metadata. |
| Clear optional schedule metadata in current daily note | Reset matching hints with an undo journal; ordinary edits need no reset. |
| Undo last operation | Restore the latest durable file and state transaction when safe. |

## Privacy and provider access

Optional chat sends conversation messages, selected runtime skills, host context, and content returned by explicit read tools to the configured endpoint. The current open note is in scope by default but is not sent merely because it is open. Additional note folders must be configured explicitly. Scheduler dependencies such as configured fixed-event inputs may be checked locally without being exposed to the model.

Opening provider configuration or the assistant may query that provider's model-list endpoint. These metadata requests do not run text generation. Provider retention, access and billing policies apply.

There is no plugin telemetry, advertising, remote code execution, automatic self-update, or access outside the vault. Keys use Obsidian Keychain when available; otherwise they remain in memory until reload. Chat history is in memory and resets when the plugin reloads or Obsidian restarts.

Read [privacy and recovery](docs/privacy.md) before using AI with private notes.

## Scheduling behavior and limits

- Active chat scheduling always writes Day planner-compatible daily notes, independent of legacy single-file/manual output settings.
- The horizon is the current local day plus six days. Flexible work and exact events use a 15-minute grid; habits support exact minutes.
- Priority, deadlines, earliest starts, capacity, work windows, fixed events, habits and buffers constrain a deterministic greedy schedule. Work may remain unscheduled and is reported.
- Exact events and newly added flexible blocks are rechecked immediately before commit so a staged start cannot silently pass while waiting.
- Monthly/yearly recurrence, overnight intervals, external calendar sync, ICS import and background monitoring are not supported.
- Weeks containing a local daylight-saving transition are rejected.

## Historical screenshots

Images under `docs/screenshots/` and the `examples/` fixtures document the pre-refactor specialized chat flow. They remain useful as historical UI and calendar-format records, but their prompts and automatic file-routing behavior are not a promise that the current generic harness reproduces those examples exactly.

![Historical pre-refactor study-plan fixture](docs/screenshots/study-plan.png)

## Development

Node **22 or 24** and npm are recommended.

```sh
npm ci --ignore-scripts
npm run typecheck
npm test
npm run smoke
npm run release:check
npm run package
```

The installation files are generated in `dist/auto-scheduler/`. See [usage](docs/usage.md), [architecture](docs/architecture.md), [CONTRIBUTING.md](CONTRIBUTING.md), and [release preparation](docs/releasing.md).

## License and acknowledgements

[MIT](LICENSE), copyright 2026 Alex Hu. This is an independent community project, not an official Obsidian product.

[Day Planner](https://github.com/ivan-lednev/obsidian-day-planner), [Gantt Calendar](https://github.com/sustcsugar/obsidian-gantt-calendar), and [Copilot](https://github.com/logancyang/obsidian-copilot) informed interoperability and provider-configuration work. Their implementations are not bundled or vendored. See [acknowledgements](docs/acknowledgements.md).
