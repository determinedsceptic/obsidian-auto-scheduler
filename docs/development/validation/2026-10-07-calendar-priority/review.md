# Calendar certainty and persistent event buffers

Author: Codex for Alex Hu. Date: 2026-10-07.
Base commit: `4e1d43e5a1a9832965f745e34817c02ebf6165bb`; implementation is in the working tree alongside the earlier harness/source corrections.
Upstream: the user's fixed-travel-versus-flexible-habits bug report; `skills/scheduling/SKILL.md`.
Downstream: the installed undo-vault plugin; installation checksums and runtime backup are recorded in `installation.json`.

## Implemented behavior

- Exact appointments reserve their actual interval plus individually resolved before/after buffers. Hidden `as-event` metadata retains these values across subsequent planning, restarts, and ordinary transaction undo. Missing/null buffers use the configured default; explicit zero is preserved.
- Completed history and locked non-habit blocks remain protected. Unfinished habit occurrences yield to hard commitments, independently of numerical priority. Unaffected occurrences retain their preferred times, including adjacent activities and times outside work windows. Omitted occurrences have a nonfatal unscheduled reason; templates and task sources are retained.
- An explicit-source event-only request preserves existing habit occurrences without generating missing occurrences from every configured template.
- Existing plain habits are adopted only through a unique declared occurrence with matching date, clocks, and complete canonical title. Ambiguous rows, directives, extra work constraints, conflicting dates, semantic wikilinks, and unsupported calendar forms remain hard. Adoption preserves original reminder content and completed checkboxes while adding tracking provenance.
- `flexibleRefs` allows the user-described movable clock rows to yield. References must select standalone unchecked handwritten blocks. Releasing a reservation removes only the leading clock range and keeps the original list prefix, reminder content, annotations, and checkbox.
- When a managed span becomes empty, the committed adapter state releases its tracking owner. The prior state remains in the full durable undo journal, avoiding a false rehydration error on a remaining fixed-event row.

## Checks and review

- `npm run typecheck`: passed after the final interface and state changes.
- `npm run package`: passed for the final source, producing the browser bundle and local plugin package.
- Installation: original runtime files backed up, new runtime files copied atomically, and SHA-256 compared to the packaged files. Auto Scheduler was disabled during replacement, re-enabled, and its assistant sidebar reopened in Obsidian.
- The existing declared habit clock rows were read narrowly for compatibility and matched the reported daily occurrences. No daily-note changes were made for the example appointment.
- No behavioral tests were added or run, and no LLM inference was invoked by the agent. This record does not claim end-to-end provider validation.

Read-only independent review was performed by `calendar_priority_review`, which did not implement the reviewed changes. Reported issues were corrected:

1. Reminder metadata and list syntax were being lost during release; release now uses the original raw reminder bytes.
2. Prefix collisions between legacy habit IDs could remove unselected occurrences; selection now compares exact occurrence IDs.
3. Semantic wikilinks were being removed before provenance matching; they are retained.
4. Public Dataview directives could be adopted as habits; directive rows are excluded centrally.
5. ISO `T` and case-insensitive timed fields could leave an unreleased reservation; supported recognition and reference rejection now cover these forms.
6. Conflicting explicit occurrence dates could be hidden during adoption; date consistency is checked and unsupported extra work constraints remain hard.
7. Duplicate emoji scheduled fields bypassed duplicate detection; input counts now include inline and emoji representations.

Limitations: unknown handwritten appointments remain hard until explicitly classified as movable; omitted habits are not assigned invented replacement times. Actual model tool selection and execution still require a subsequent user request.
