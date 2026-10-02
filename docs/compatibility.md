# Compatibility

| Component | Support and validation |
| --- | --- |
| Obsidian | Public API typed against SDK 1.6.6; desktop only. Native UI checked on macOS with Obsidian 1.13.7. |
| Windows / Linux | Runtime avoids Node/Electron APIs; native UI has not been validated on these platforms. |
| Mobile | Not supported or advertised. |
| Markdown | LF/CRLF, fenced examples, explicit IDs, priority markers, completion checkboxes, and preserved unmanaged sections have automated coverage. |
| Day Planner | Clean time lists in date-named notes are displayed in the test vault's Day Planner 0.35.1 UI. This is not a guarantee for every configuration or upstream version. |
| Tasks / Dataview | Reads compatible priority/date syntax without a runtime dependency or private API. |
| Gantt Calendar | Optional full Dataview start/scheduled/due format; tested parser/serializer round-trip against upstream commit `a06130967bd862a642416e10970ca4bf4cfc7e11`. Full Gantt UI is not validated. |
| API providers | Responses, compatible Chat Completions, Anthropic Messages, Gemini generateContent. Transport/tool routing tested with mocks; no claim that every available model supports these tools. |
| Local time | Local calendar dates, 15-minute grid, same-day intervals. DST-transition weeks are explicitly rejected. |
| Credential storage | Optional host SecretStorage/Keychain API; session-memory fallback when absent. |

Clean daily mode writes only time-based rows under `# Day planner`. It does not include full start/due fields required by Gantt Calendar's native date-field parser. To use that format, turn off **Clean daily lists**, select **Gantt Calendar (Dataview)**, and match the configured task prefix to Gantt Calendar's filter (normally `🎯`).

```markdown
- [ ] 🎯 09:00 - 10:00 [priority:: high] Prepare report [[Tasks/Project]] %%[as-block:: id=b_report_1 task=report locked=false]%% [start:: 2026-10-05 09:00] [scheduled:: 2026-10-05 09:00] [due:: 2026-10-05 10:00]
```

A generated block's `due` means its end time; the source task's business deadline is not copied to it. Dragged Gantt blocks must keep clock/date fields consistent and move to the matching daily file when their date changes. Unsupported or inconsistent edits are rejected rather than silently normalized. Existing Chinese habit recurrence labels and legacy hidden metadata continue to parse.

Upstream plugins are optional. Runtime imports only the Obsidian host; the scheduler can be used alone. Historical verification details are under `development/validation/`.

Gantt output uses Dataview priority fields consistently. Combining priority emoji with Dataview dates makes the pinned upstream parser select its mixed/Tasks branch. Clean daily lists still display priority emoji.
