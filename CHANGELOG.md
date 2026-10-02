# Changelog

## 0.6.0 — Public release candidate

- English interface, commands, diagnostics, documentation, and tool instructions by default.
- English recurring-habit syntax, with existing Chinese and legacy templates preserved.
- DeepSeek provider preset with current model choices and the official Chat Completions endpoint.
- Model selector in the assistant sidebar and an initial model choice in provider configuration.
- OpenAI preset offers both `gpt-6-luna` and `gpt-6-sol` under one provider key.
- Missing flexible-task estimates use the configurable duration default; undated appointments use their next occurrence, with assumptions reported.
- Mixed task/event/habit requests apply and undo together; invalid provider-response glyphs are filtered from prose.
- Model selection prioritizes dropdowns populated by discovery, includes preset choices for existing providers, and collapses manual IDs into an advanced fallback.
- Exact one-off event tool and configurable default duration for start-only events and habits, with reported assumptions, conflict protection and persistent undo.
- Start-only handwritten daily, fixed-event and habit rows reserve time without source edits.
- MIT license, contributor/security guidance, release checks, workflow templates, and community-submission preparation.
- Reproducible examples and screenshots captured in a separate Obsidian vault with a localhost fixture.
- Gantt output uses Dataview priority fields to avoid mixed-format detection in the upstream parser.
- Historical design and validation records moved under `docs/development/`.

This is a release candidate in source control, not a claim of community-directory acceptance.

## 0.5.0

- Selectable chat text and per-message copy buttons.
- `create_habits` tools across all four API protocols, backed by a bundled habits skill and host-controlled template paths.
- Templates and daily schedules share validation, backups, and undo.

## 0.4.1

- Plain recurring time rows replace visible HTML habit metadata in new templates.

## 0.4.0

- Markdown habit templates reserve periodic time before ordinary tasks.

## 0.3.0–0.3.2

- Multiple BYOK providers and protocols, direct AI scheduling, priority symbols, and a simplified chat panel.

## 0.1.0–0.2.0

- Local Markdown scheduling, daily notes, calendar-format interoperability, preview, recovery, and initial AI task creation.
