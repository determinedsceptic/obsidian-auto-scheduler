# Tracking conflicts across daily notes

Author: Codex for Alex Hu
Date: 2026-10-06
Acceptance: requested tracking-conflict fix; operational recovery performed locally
Related: src/main.ts, src/daily-edit.ts, src/tracking.ts, scripts/smoke.mjs
Code revision: the Git commit containing this record

## Cause and behavior

Daily reads inspect tracked history for completed effort. A manually changed future note could therefore reject a read of today or yesterday, with an error omitting the conflicting path. Recovering only the active note did not resolve that unrelated ownership.

The host now probes tracked notes before taking read/create snapshots. For conflicts, it uses the existing recovery operation: write and verify a credential-free local backup, check note/state stability, persist released ownership, retain all note bytes, AI goals and undo state. A notice identifies recovered files. Duplicate sections and backup failures still stop recovery, with the precise path. The scheduler's strict rehydration checks remain intact. Invalid read dates are rejected before recovery.

This adopts current clock rows as handwritten occupied time. It does not infer cancellation or completed effort for saved goals from deleted or edited rows. Such goals remain active. A read can now persist recovery metadata; it never writes Markdown. Existing explicit recovery is retained.

## Verification

- TypeScript typecheck passed.
- 40 tests passed across tracking-recovery, tracking and daily-edit suites.
- Compiled-bundle smoke passed: failed backup leaves note and ownership unchanged; successful read recovers tracking once; note/goals/undo retained; recovery survives restart; scheduling and exact undo work. A conflict in a different future note is recovered before reading today's valid note.
- Local vault reproduction identified one future dated-note conflict. Native recovery saved a verified backup. All daily-note and habit-template bytes and AI tasks remained unchanged.
- A read-only snapshot of the recovered real vault successfully read yesterday and today; schedule preview returned zero errors and made zero writes. No paid LLM request was made as part of verification.
- Installed undo and demo bundles were backed up and hash checked; the running plugin was reloaded.
