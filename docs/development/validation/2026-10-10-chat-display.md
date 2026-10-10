# Chat Markdown and concise replies

- Author: Codex with independent agent review
- Date: 2026-10-10
- Base commit: `1067cbea142f082bbd484b8234d01793c2afb03a`
- Related code: `src/chat-view.ts`, `src/chat-markdown.ts`, `src/plugin-agent.ts`, `styles.css`
- Related policy: `skills/note-editing/SKILL.md`, `skills/scheduling/SKILL.md`
- Acceptance: static independent review passed; no user acceptance recorded yet.

## Changes

- Chat parses CommonMark/GFM using Marked 18.1.0, with sanitized DOM, literal raw HTML, explicit image links, and workspace note links. Copy retains original Markdown. Chat rendering never invokes Obsidian or third-party Markdown postprocessors.
- Routine receipts, automatic file lists/date links, no-files messages, and tool names are removed from normal display. Receipts remain internal execution evidence and are excluded from later prompts.
- Real incomplete operations and post-write model interruption retain a brief authoritative outcome. Tool failures take precedence over a later provider failure. A cancelled write can still report its outcome to the original conversation.
- Ordinary failure exchanges remain paired in model history. Pre-write cancelled requests without an outcome are excluded. Clear is guarded during mutation.
- Default replies use 1–3 short sentences or at most 3 short bullets, preserving actual failures, partial completion, unscheduled items, and required decisions.
- The bundled parser license is included in the runtime file.

## Evidence

- `npm run typecheck`: passed after integration.
- `npm run package`: passed; runtime and package produced successfully.
- `git diff --check`: passed.
- Independent read-only review covered Markdown parsing/link safety, scoped styles, hidden receipt handling, truthful failure fallback, and close/switch/cancel concurrency. No blocking findings remained after fixes.
- Installed only `main.js`, `manifest.json`, and `styles.css` into the existing local plugin directory, with a recoverable runtime backup outside the repository. Installed bytes matched packaged files.
- At the user's explicit choice, disabled and re-enabled the plugin in Obsidian, reopened the assistant, and restored the unsent draft. The assistant loaded with the existing provider/model selection and no routine model-count status message.

Runtime checksums:

| File | Bytes | SHA-256 |
| --- | ---: | --- |
| main.js | 429526 | b39b41ac79ab012c7da1820948ad487adb2357b161d5c88e987070683ad540d6 |
| manifest.json | 356 | 9ebe8c2c60d43d6851b6849e62b17f9389275fe5c9fa582f50cb94d9b0177764 |
| styles.css | 6047 | 6b10fed387a695d93d0077776327045a48aacf0f5ddac2b9a8a28970aee9b755 |

## Limits

No tests were added or run. No LLM inference or note-write exercise was performed. Actual rendered provider replies and provider adherence to the new brevity instruction were not exercised in this change; the UI observation confirms plugin loading and draft restoration. CommonMark/GFM code is inert text; other plugins' executable blocks and automatic embeds are intentionally not expanded. Internal-link middle clicks are not handled specially.

No personal diary contents, chat transcript, drafts, provider settings, or credentials are included in this record or staged for Git. No diary file was edited by this work.
