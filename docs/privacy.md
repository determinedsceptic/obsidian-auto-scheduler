# Privacy and recovery

## Local data

Markdown parsing, scheduling, tracking, staging, commit, and undo run locally. Offline commands need no provider account. The runtime uses public Obsidian APIs and does not access files outside the vault.

Plugin `data.json` holds settings, AI task records, clean-list tracking, and the latest before/after recovery journal. Recovery snapshots can contain note text. Protect and back up this file with your vault; do not attach it unredacted to a public issue. It is not an API-key store.

The plugin does not use Git or submit vault notes to GitHub. The development repository contains plugin code, documentation and synthetic compatibility fixtures; personal daily folders, hidden vault configuration and plugin state are separate. Schedule metadata is an optional local hint, not a content lock. Current note bytes take precedence over obsolete records, and ordinary edits require no tracking recovery.

Conversations and drafts are held in memory until the plugin reloads. Closing and reopening the sidebar preserves them; **Clear** clears the selected conversation. There is no telemetry or background inference. Opening configuration or the assistant can query provider model metadata. Temporary rate limits can retry at most twice, within the request budget.

## Optional AI requests

The selected provider receives chat messages, local date/time, the available tools, execution context, scheduling settings, and selected skill instructions. Context includes saved AI task summaries, current-horizon event rows and buffers that still match actual notes in the authorized daily folder, and the latest operation's ID and vault-relative paths. Obsolete event rows are filtered out through local reads without sending their changed note bodies as context.

By default, note tools can access the current open Markdown note and dated notes in the configured daily folder. **Additional note folders** explicitly expands that scope. Hidden paths, including plugin configuration and credentials, are unavailable to these tools. Discovery returns paths and references; `read_note` can return an outline, section, block, or complete authorized note. Unlike the older daily-summary interface, complete requested note bodies can now be sent. Staging results include the concrete before/after content of changed files. Subsequent tool rounds send those results to the provider for the same request.

**Runtime skill files** are explicitly selected Markdown files. Their contents are sent as instructions on every send; configured files replace the bundled defaults. Skills cannot expand note permissions. The provider does not receive raw recovery journals, tracking records, or private scheduler dependency snapshots through the generic tools.

The plugin uses Obsidian `requestUrl`. Hosted endpoints require HTTPS; HTTP is permitted only for localhost. Provider errors are summarized without reflecting keys or raw error bodies. Model discovery does not establish that every listed model supports tool calling. Providers may retain requests and bill API use; their policies apply.

## Credentials

Keys are bound to plugin namespace, provider, protocol, and endpoint. Host SecretStorage/Keychain is used when available; otherwise keys stay in session memory and must be entered after reload. Keys are not written to notes, plugin data, logs, or source control. Changing endpoint or protocol does not forward an old key to the new destination.

## Writes and recovery

Tool parameters are input data, not executable code. Reads and writes are scope checked. References identify the actual read snapshot; changes to source files, destinations, or plugin state invalidate staged work. Generic tools can edit every authorized section, including calendar rows; explicit time allocation uses the scheduling adapter.

The host saves recovery data before modifying notes. Multi-file writes can be interrupted. A partial operation locks further commits until recovery; that lock survives restart, including interrupted undo. The sidebar shows actual host receipts independently of model prose and retains them even if the next provider request fails or the view closes during commit.

**Undo last operation**, `/undo`, and exact `undo` work without an API call. Natural-language undo uses `undo_operation` through the tool loop. Undo refuses to overwrite later manual edits or changed task/tracking state. The plugin retains one undoable operation; it is not a version-history replacement. Newly created notes are restored to empty contents on undo rather than removed. Maintain independent backups.
