# Acknowledgements

- [Day Planner](https://github.com/ivan-lednev/obsidian-day-planner), originally by James Lynch and continued by Ivan Lednev: time-list and date-note interoperability reference (MIT).
- [Gantt Calendar](https://github.com/sustcsugar/obsidian-gantt-calendar), by Sugar: Dataview time fields and plugin-layout reference (MIT).
- [Copilot](https://github.com/logancyang/obsidian-copilot), by Logan Yang and contributors: BYOK provider/model configuration workflow reference (AGPL-3.0).

Auto Scheduler's runtime is an independent implementation. It does not vendor or bundle code from these projects. The optional `gantt-interop.mjs` development script loads an independently checked-out, pinned upstream parser for verification; it does not ship with the installed plugin.

Obsidian is a product and trademark of its owners. Auto Scheduler is an independent community project. The Obsidian SDK is a development dependency and the installed bundle relies on the host's public API.
