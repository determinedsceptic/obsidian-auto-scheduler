# Privacy and recovery

## What stays local

Markdown parsing, task priorities, fixed events, habits, available-time calculation, scheduling, preview, tracking, and undo run locally. Offline commands need no provider account or network. The runtime uses public Obsidian APIs and does not read outside the vault.

Plugin `data.json` contains settings, AI task records, clean-list tracking, and the latest before/after recovery snapshots. Those snapshots can include note text. Back up and protect this file with your vault. It is not an API-key store. It is not safe to attach an unredacted copy to a public issue.

Chat messages are held in memory and clear when the chat view closes. There is no telemetry, advertising, background inference, or automatic retry. Opening AI configuration or the assistant can query provider model metadata.

## Optional AI requests

Chat sends contact the inference endpoint. Model discovery contacts the configured provider automatically when opening the assistant, editing a saved provider, or leaving a newly entered key field; sidebar/configuration refresh buttons can also request it. The selected provider receives the chat, local date/time, working-day/hour/capacity settings, bundled habits skill, and configured vault-relative habit and daily-note paths. Existing task lists are not included automatically in every request. When the model calls `read_daily_plan`, the plugin reads the requested dated note and sends only checkbox summaries under its `Day planner` section: titles, completion, duration, deadlines, priority and local edit references. When present, the explicitly named habit guidelines section (Habits and guidelines, Habit guidelines, Habits and plans, or 习惯与计划) is included as bounded habit context. Unrelated sections, whole note bodies, the tracking store and absolute filesystem paths stay local. Reading is bounded to the past 30 days and next seven local dates. These summaries are included in subsequent tool rounds for that send and are not saved in chat history. Anything you type into chat is sent to that provider.

The plugin uses Obsidian `requestUrl`. Hosted addresses must use HTTPS; HTTP is permitted only for localhost. Model discovery requests `/models`, not an inference. Provider errors are reported without reflecting keys or raw server bodies into user-facing messages. A successful discovery request does not prove that a selected model supports tool calling.

Providers may require accounts, retain requests, and charge for API calls. Check your selected service's current terms and privacy policy. This plugin does not proxy requests through its maintainer or bundle a subscription.

## Keys

Keys are scoped by plugin namespace, provider, protocol, and endpoint binding. The host Keychain API is used when available; on older hosts keys live in session memory and must be re-entered after reload. Keys are not written to notes, data.json, logs, or source control. Changing the address or protocol does not reuse the old key at the new destination. Keychain entries stay on the device rather than syncing with the vault.

## Writes and undo

Model tool parameters are strict input data, not executable code. The host chooses output paths and rejects unknown fields, invalid estimates, ambiguous note tracking, conflicts, and concurrent changes. Before writing, it saves recovery data durably. Multi-file writes can still be interrupted; the latest undo record is kept for recovery. Undo checks current contents and refuses to overwrite unrelated edits.

The plugin keeps one undo operation, not a full version history. Maintain independent backups of notes and plugin data.

AI revisions use references from a fresh read, not arbitrary paths or model-written Markdown. The host validates changes, compares the source and task state, saves a recovery backup, then writes source/destination notes. Edits after the read or preview invalidate the operation. A partial write retains the backup; **Undo last schedule** restores note contents and task state, including after a restart.
