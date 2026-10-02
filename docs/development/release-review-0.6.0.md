# Release candidate review: 0.6.0

Author: Alex Hu / Codex. Date: 2026-10-02. Source: the Git commit containing this record; checksums in `validation/0.6.0/checksums.json` identify the tested install assets. Upstream: `history/plan.md`; downstream: `../releasing.md`. Status: local validation passed; public release and community acceptance pending maintainer action.

## Evidence

- Clean lockfile install: `npm ci --ignore-scripts`, 58 packages audited, zero vulnerabilities.
- `npm run typecheck`: passed against the pinned Obsidian 1.6.6 SDK.
- `npm test`: 14 files, 219 tests passed. New regressions cover English recurrence aliases, preserved Chinese syntax, inactive template examples, and consistent Gantt priority syntax.
- `npm run smoke`: actual CommonJS bundle loads in a fake host, including direct AI scheduling, habit tools, configured paths, copy controls, key-save rollback, restart, stale preview rejection, and undo/recovery.
- `node scripts/gantt-interop.mjs`: real upstream parser/serializer at `a06130967bd862a642416e10970ca4bf4cfc7e11`, exact date times, Dataview format, high priority, metadata and locked round-trip passed. Full upstream UI remains unverified.
- `npm run demo`: synthetic planner run passed; performance observations remain fixture-specific.
- `npm run release:check` and `npm run package`: metadata/lockfile/version agreement, English runtime, README links/images, bundled skill/tools, no Node/Electron runtime imports or workstation paths, asset hashes passed.
- Native Obsidian 1.13.7 on macOS: separate synthetic vault, actual task/habit saves and daily-note navigation; four original screenshots under `../screenshots/`. A loopback fixture provides structured tool arguments, not hosted-model reasoning.
- ZIP integrity and installed test-vault asset hashes verified. Only the three plugin assets were replaced; settings, keys, and notes were not read or changed.

## Findings and limits

The release gate found an absolute build-path comment emitted by the raw-skill bundler. Its namespace now uses a portable repository-relative path; the bundled content and runtime behavior are preserved.

The expanded compatibility check found priority emoji plus Dataview dates selecting the upstream mixed/Tasks parser branch. Gantt output now emits Dataview priority fields; clean daily output keeps visible priority emoji. Both a regression and the real high-priority round-trip pass. Historical earlier successful checks remain dated evidence, not a substitute for this validation.

Review covered defaults, stable command IDs, preservation of existing settings/input formats, transactional note writes, credential/network disclosure, and original source provenance. Windows/Linux native UI, mobile, and live paid-provider model behavior are not validated or advertised. DST-transition weeks remain rejected. No self-update, telemetry, personal notes, tokens, or paid model calls were added.

The repository is public; no GitHub Release or community acceptance is asserted. Workflow templates remain inactive because the available credentials lack workflow scope. Current submission requires the maintainer's Obsidian login and GitHub account association. The final external release remains subject to maintainer approval.
