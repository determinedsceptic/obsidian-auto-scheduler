# Architecture

A TypeScript Obsidian plugin with an esbuild CommonJS bundle. Runtime imports only `obsidian`; Node.js is used by build/test scripts, not the installed plugin.

| Module | Responsibility |
| --- | --- |
| `main.ts` | Lifecycle, commands, settings, native vault adapter, and serialized operations. |
| `chat-view.ts`, `provider-modal.ts` | Sidebar conversation, copying, and BYOK setup. |
| `providers.ts`, `credentials.ts` | Provider/model routing, discovery, isolated host Keychain or session credentials. |
| `llm.ts` | Four transport schemas, bounded read tool rounds, and strict action dispatch. |
| `habit-tool.ts`, `skills/habits/SKILL.md` | Bundled model instructions, host-controlled paths, validated template creation. |
| `parser.ts`, `calendar-format.ts` | Source estimates, event syntax, Tasks/Dataview compatibility. |
| `daily-edit.ts` | Bounded daily-plan summaries, read references, staged task revisions and carry-over. |
| `event-tool.ts` | Exact one-off events, nullable duration defaults, local date/time validation. |
| `habit-guidelines.ts` | Bounded natural-language habit context, validated template rules and daily-note inclusion. |
| `habits.ts` | Readable recurring templates, stable occurrence identity, fixed-time expansion. |
| `time.ts`, `scheduler.ts` | Local-time/grid constraints and deterministic capacity-aware scheduling. |
| `daily.ts`, `output.ts`, `tracking.ts` | Daily sections, rendering, diffs, and clean-list tracking. |
| `transaction.ts`, `queue.ts` | Read-only snapshots, durable recovery, compare-and-write, undo, and serialization. |
| `ai-result.ts` | User-facing times and links derived from applied results. |

```mermaid
flowchart LR
  A[Chat or Markdown] --> B[Host validation]
  B --> C[Expand habits first]
  C --> D[Local scheduler]
  D --> E[Render and validate]
  E --> F[Snapshot check]
  F --> G[Save undo backup]
  G --> H[Compare and write]
  H --> I[Saved times and daily-note links]
```

Manual scheduling inserts a preview before snapshot verification; AI creation applies directly after validation. Habit creation stages the new template in memory and schedules from that staged content. The template is written alongside daily notes only after the original source snapshot is checked. Recovery covers both. One-off events are staged as plain fixed rows in the Day planner section; flexible work is scheduled around them in the same validated operation. Start-only durations are resolved by the host and reported in chat.

The host has no multi-file transaction API. A partial write is visible and recoverable, rather than described as fully atomic. Clean daily output stores annotated representations in plugin data; matching allows completion-checkbox changes but refuses ambiguous title/time edits.

Tests cover pure logic and transaction boundaries; `scripts/smoke.mjs` loads the actual built bundle into an isolated host simulation. Screenshots exercise a real Obsidian vault and deterministic localhost provider. No upstream calendar source is bundled.

AI revision adds a read-tool round trip before host validation. Only Day planner checkbox summaries and the explicitly named habit guidelines section leave the vault during a daily read. A per-send snapshot retains source bytes, tracking and AI task state locally. Revision accepts only unfinished editable references from that read, stages row removal and persistent task changes, and checks the source again. Original AI IDs and completed history survive carry-over; original snapshots and tracking remain available for restart undo. The transaction renders past source notes as well as the active seven-day destinations.

Task deadlines remain independent of scheduled block ends. Clean output uses a map of task deadlines to add visible Tasks date fields; provider reads expose deadline labels. Before-write tracking preserves the prior display instead of rebuilding it with new formatting assumptions, allowing undo across deadline-renderer changes. Natural-language habit actions and conditions are stored once in the habit template, never copied verbatim into daily notes, and never create time reservations until anchors are confirmed. Recognized habit context is explicitly disclosed as provider-visible input.
