# Compatibility

| Component | Support and validation |
| --- | --- |
| Obsidian | Public API typed against SDK 1.6.6; desktop only. Native UI checked on macOS with Obsidian 1.13.7. |
| Windows / Linux | Runtime avoids Node/Electron APIs; native UI has not been validated on these platforms. |
| Mobile | Not supported or advertised. |
| Markdown | LF/CRLF, fenced examples, explicit IDs, priority markers, completion checkboxes, and preserved unmanaged sections have automated coverage. |
| Day Planner | Clean time lists verified in `undo` with Day Planner 0.28.0 Multi-Day View. Align Daily Notes folder/format; use three days or scroll horizontally in full week. |
| Tasks / Dataview | Reads compatible priority/date syntax without a runtime dependency or private API. |
| Gantt Calendar | Optional full Dataview format, or opt-in [clean daily compatibility build](../integrations/gantt-calendar/README.md) for 1.6.2 at `a06130967bd862a642416e10970ca4bf4cfc7e11`. Clean intervals verified in real monthly, sidebar timeline and Gantt views. |
| Calendar | Calendar 1.5.10 recognizes `DailyNotes/YYYY-MM-DD.md`; date click verified in the actual vault. This plugin navigates daily notes rather than rendering hourly tasks. |
| API providers | Responses, compatible Chat Completions, Anthropic Messages, Gemini generateContent. Transport/tool routing tested with mocks; no claim that every available model supports these tools. |
| Local time | Local calendar dates, 15-minute grid, same-day intervals. DST-transition weeks are explicitly rejected. |
| Credential storage | Optional host SecretStorage/Keychain API; session-memory fallback when absent. |

Clean daily mode writes only time-based rows under `# Day planner`. It does not include the extra date fields required by unmodified Gantt Calendar. The opt-in compatibility build infers an interval from the note name and clocks without adding Markdown metadata; see its [installation and limitations](../integrations/gantt-calendar/README.md). To use that format, turn off **Clean daily lists**, select **Gantt Calendar (Dataview)**, and match the configured task prefix to Gantt Calendar's filter (normally `🎯`).

```markdown
- [ ] 🎯 09:00 - 10:00 [priority:: high] Prepare report [[Tasks/Project]] %%[as-block:: id=b_report_1 task=report locked=false]%% [start:: 2026-10-05 09:00] [scheduled:: 2026-10-05 09:00] [due:: 2026-10-05 10:00]
```

A generated block's `due` means its end time; the source task's business deadline is not copied to it. Dragged Gantt blocks must keep clock/date fields consistent and move to the matching daily file when their date changes. Unsupported or inconsistent edits are rejected rather than silently normalized. Existing Chinese habit recurrence labels and legacy hidden metadata continue to parse.

Upstream plugins are optional. Runtime imports only the Obsidian host; the scheduler can be used alone. Historical verification details are under `development/validation/`.

LLM HTTP 429 responses retain structured error codes and retry headers. Temporary limits retry at most twice, honoring `Retry-After`, `retry-after-ms`, or Gemini RetryInfo; a wait beyond 30 seconds or the request's time budget requires resending later. Explicit quota/billing failures are not retried. No provider/model is switched automatically and no local action is executed until a successful response is validated. Failed model requests restore the input and are excluded from subsequent chat context. Arbitrary provider error prose is not displayed because it may echo credentials or prompts. Provider-side exhausted quota still requires a billing/usage change or selecting another authorized provider/model.

Gantt output uses Dataview priority fields consistently. Combining priority emoji with Dataview dates makes the pinned upstream parser select its mixed/Tasks branch. Clean daily lists still display priority emoji.
