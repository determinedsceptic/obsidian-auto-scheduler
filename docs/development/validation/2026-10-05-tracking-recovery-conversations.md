# Explicit tracking recovery and independent conversations

Author: Codex for Alex Hu. Date: 2026-10-05. Upstream commit: 9487751b164209ca9bf293a464b3a57fe5bed334. Acceptance: code checks and real-vault read-only scheduling passed; no paid model request made during verification.

## Tracking conflict

Today's note had been intentionally rewritten, while the plugin still tracked an older six-row region. Normal matching correctly refused to overwrite it. The new **Recover edited daily schedule tracking** command backs up and verifies the current note, prior tracking, saved AI goals and undo data before releasing ownership of that one note. Provider configuration/credentials are excluded. Backup/save failure or concurrent note/state changes leave tracking unchanged. No Markdown is rewritten. Existing rows become handwritten occupancy; AI goals and habits remain active. Ordinary rehydration still rejects modified or ambiguous regions; the protection was not relaxed.

The command was executed in the real undo vault for 2026-10-05. Independent comparison confirmed the note matched the recovery backup byte for byte, stale tracking was absent and AI goals were unchanged. A read-only simulation using the real scheduling settings and note/template snapshot scheduled the 120-minute presentation task today, with zero errors and the completed Algorithms row preserved. No preview was applied to the real vault.

Backups live under `.obsidian/plugins/auto-scheduler/tracking-recovery-<id>.json`. The next schedule has normal undo; that undo does not restore released ownership. Recovery does not infer cancellation of an AI goal from a deleted session. If an adopted handwritten row represents an active AI goal, retain it as occupied time and explicitly replan/update that goal to avoid unintended extra sessions.

## Conversations

**New chat** and **Start new AI conversation** create empty independent model contexts. A Conversation selector restores previous messages and drafts. Clear affects the selected conversation. New/switch cancels pending reads, marks interrupted messages failed, restores their drafts and suppresses late scheduling replies. A host save cannot be interrupted by switching conversations. Closing/reopening the sidebar preserves history in plugin memory. Plugin reload or app restart resets it; no chat history or provider credentials are written to plugin data. Saved goals, habits and notes remain available through host tools in every chat.

## Validation

- Typecheck passed.
- Four affected tracking/transaction/read-edit suites: 57 tests passed.
- Compiled plugin smoke passed, including recovery backup failure, preservation, restart/replan/undo, independent context payloads, history/draft restoration, Clear isolation, pending-request cancellation, late-write suppression and the New chat command.
- Real Obsidian sidebar: New chat creates an empty selected conversation; the Conversation selector and compact button layout were visually verified. The presentation draft was restored without sending it.
- Existing strict tracking tests continue to pass; the old error is actionable via the explicit recovery command.

Live provider quota recovery is not established by these checks. The new reported error had already reached local host validation, demonstrating that that individual model request got past the prior API failure.
