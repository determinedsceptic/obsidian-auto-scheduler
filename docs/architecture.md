# Architecture

A TypeScript Obsidian plugin with an esbuild CommonJS bundle. Runtime imports only `obsidian`; Node.js is used by build/test scripts, not the installed plugin.

| Module | Responsibility |
| --- | --- |
| `main.ts` | Lifecycle, commands, settings, native vault adapter, and serialized operations. |
| `chat-view.ts`, `provider-modal.ts` | Sidebar conversation, copying, and BYOK setup. |
| `providers.ts`, `credentials.ts` | Provider/model routing, discovery, isolated host Keychain or session credentials. |
| `llm.ts` | Four transport schemas and strict task/habit tool dispatch. |
| `habit-tool.ts`, `skills/habits/SKILL.md` | Bundled model instructions, host-controlled paths, validated template creation. |
| `parser.ts`, `calendar-format.ts` | Source estimates, event syntax, Tasks/Dataview compatibility. |
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

Manual scheduling inserts a preview before snapshot verification; AI creation applies directly after validation. Habit creation stages the new template in memory and schedules from that staged content. The template is written alongside daily notes only after the original source snapshot is checked. Recovery covers both.

The host has no multi-file transaction API. A partial write is visible and recoverable, rather than described as fully atomic. Clean daily output stores annotated representations in plugin data; matching allows completion-checkbox changes but refuses ambiguous title/time edits.

Tests cover pure logic and transaction boundaries; `scripts/smoke.mjs` loads the actual built bundle into an isolated host simulation. Screenshots exercise a real Obsidian vault and deterministic localhost provider. No upstream calendar source is bundled.
