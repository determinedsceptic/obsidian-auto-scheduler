Auto Scheduler 0.6.0 is the first public release candidate.

Schedule estimated Markdown tasks and fixed-time recurring habits in daily notes. Use offline preview/apply or optional BYOK AI chat. English interface and documentation are the default; existing Chinese habit templates remain supported.

Install main.js, manifest.json, and styles.css under .obsidian/plugins/auto-scheduler/. Read the README for provider costs, data flow, limitations, and undo recovery. The plugin is desktop-only and requires Obsidian 1.6.6 or later.

This release has not been accepted into the Obsidian community directory. Screenshots use synthetic notes and a deterministic localhost API fixture. Native UI validation covers macOS with Obsidian 1.13.7; mobile is unsupported.

Gantt Calendar output now uses Dataview priority fields consistently, preserving priority and exact dates through the pinned upstream parser/serializer.

The DeepSeek preset now includes `deepseek-flash` and `deepseek-v4-pro`, the official API base URL, and the existing Chat Completions tool-calling path. Users bring their own DeepSeek API key.

The assistant sidebar now has a model selector for every saved provider/model pair. Provider configuration lets users choose the model to use immediately after saving.

Start-only appointments and habits use a configurable 30-minute default. AI replies report the assumption and open the corresponding date; explicit durations take precedence. One-off events keep their exact time, replan flexible tasks, reject conflicts and cross-midnight ranges, and support restart-safe undo. Handwritten start-only rows reserve time without source edits.
