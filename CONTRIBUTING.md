# Contributing

Use English for issues, documentation, interface strings, and new examples. Multilingual user input and existing note formats should keep working.

## Set up

Use Node 22 or 24, then run `npm ci --ignore-scripts`. Use `npm run dev` for rebuilds and `npm run package` to produce installable files. Try changes in a separate synthetic vault; never include a personal vault or API keys in a pull request.

## Before opening a pull request

Run `npm run typecheck`, `npm test`, `npm run smoke`, and `npm run release:check`. Add meaningful regression coverage for parsing, scheduling, transactions, or tool routing that changed. Keep the lockfile in sync with dependency edits.

Explain the user-visible problem, the resulting behavior, the relevant checks, and any compatibility limits. Small bug fixes do not require a design document. Changes to note ownership, recovery, scheduling semantics, or external requests need a short design note and failure-case tests.

## Boundaries to preserve

- Only use public Obsidian APIs. Runtime imports must not require Node.js or Electron.
- Never serialize keys or include them in errors, logs, screenshots, or fixtures.
- Local Markdown scheduling must work without an AI provider.
- Validate model tool arguments in the host. Never accept model-selected output paths.
- Preview is read-only. Save durable undo data before writing any note or template.
- Preserve unmanaged content. Fail visibly on concurrent edits or ambiguous tracking.
- Existing stored settings, task formats, tracking, and undo records need migration compatibility.

Manual screenshot examples use the deterministic localhost server described in `examples/README.md`. Label simulated-provider results honestly. Do not publish screenshots containing private content.
