# Native screenshots

Captured by Alex Hu with Codex on 2026-10-02 in Obsidian 1.13.7 on macOS, dark theme, Asia/Shanghai time zone. Each PNG is an original native window capture at 2048 × 1600, with no compositing or fabricated UI.

The isolated **Auto Scheduler Demo** vault uses only synthetic notes from `examples/vault/`. The deterministic loopback service in `scripts/demo-provider.py` returns tool arguments; the actual plugin validates them, calculates the schedule, saves notes, and opens the daily file. No paid provider or API key is used. These images illustrate the host integration, not hosted-model reasoning quality.

| Image | Scenario |
| --- | --- |
| study-plan.png | Two important study tasks, two hours each; existing report work has higher priority and fixed meetings reserve time. |
| recurring-habit.png | Evening walk, 19:00–19:30 every day, saved to a recurring template and dated notes. |
| weekly-preview.png | Manual preview showing occupied working minutes and fixed evening habits outside working hours. |
| provider-settings.png | English provider editor with a synthetic localhost endpoint and empty API-key field. |

All captures use an earlier 0.6.0 development candidate, before the sidebar model selector was added. The first two also precede a punctuation-only adjustment adding a space before `(priority ...)`; scheduling behavior is unchanged. Core Obsidian menus may follow the host's language preference; plugin UI defaults to English. See `examples/README.md` for reproduction steps.
