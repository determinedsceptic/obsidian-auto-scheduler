# API request overhead and persistent quota failure

Author: Codex for Alex Hu. Date: 2026-10-05. Upstream commit: 7628e9f0febb17d606fcc18eeca2221830bd8695. Acceptance: implementation verified locally; live API quota recovery remains unconfirmed.

## Evidence

The existing Obsidian chat reported HTTP 429 for a two-hour presentation task: requested 4495 tokens, remaining 3595 of 100000, used 96405. Retry-After was 23328 seconds; token reset was 694h6m31.792s. The reported request body was 23942 characters. This establishes an HTTP quota response rather than a network timeout. The long reset duration is not enough evidence to identify the provider's accounting policy or the origin of the credential.

## Change

Advertise one complete `create_plan` schema instead of duplicating its task/event/habit definitions in three additional creation tools. Keep existing response parsers for backward compatibility. Advertise revision tools only after a daily-plan read; habit save/apply tools and the full habit skill only after a habit-index read. Initial instructions retain mandatory habit indexing, deduplication, anchor handling and rolling study rules. All four provider protocols update their tool definitions at each read round. Host argument validation, transaction checks and Retry-After handling are unchanged.

A synthetic two-hour presentation request with both read callbacks has an 8828-character body (6085 instruction characters). This is a size measurement, not a token count or a successful paid model request. A regression caps that initial request at 11000 characters and asserts its complete creation schema. Provider tests verify tool staging and full habit instructions after indexing.

## Validation

- TypeScript typecheck: passed.
- Seven affected suites: 148 tests passed (LLM, transport, provider protocols, events, daily edits and habits).
- Compiled plugin smoke: passed, including read/revise, mixed plans, habit indexing, Clear, quota write suppression, rolling study and restart/undo.
- Installed bundle, manifest and CSS in undo and the local demo: SHA-256 equality verified; previous files backed up under ignored `local-test-vaults/install-backups`.
- No paid request was made against the provider's long Retry-After. No credentials/settings or daily notes were changed by this update.

## Limitations

Payload reduction does not remove provider limits. Habit requests can still be larger after loading the full skill and index; long chat/read results also increase size. We have not established live scheduling success. The previously observed user-edited tracked-region conflict is independent and remains protected. Credential origin is pending user clarification; do not assume a new key or a different model has independent quota.
