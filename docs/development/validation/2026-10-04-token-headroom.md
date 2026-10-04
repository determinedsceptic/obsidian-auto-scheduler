# Token headroom and request size

Author: Codex for Alex Hu. Date: 2026-10-04.
Upstream: src/llm.ts, src/llm-request.ts; previous commit 0996728.

User-reported response: rate_limit_exceeded, tokens/minute, requests remaining 43/50, tokens remaining 4859/100000, Retry-After 12779 seconds. This establishes a token-category rejection, not invalid credentials or exhausted billing balance. It does not establish the requested token count, other consumers, project cap or a provider reset-header discrepancy.

Reduced static scheduling rules from 8829 to 4806 characters. Retained existing-plan reads, task identity/deadlines, book total-effort estimation, today-first seven-day balancing, fixed habit anchors, habit indexing/merging and action/rule separation. Removed repeated mixed-plan property descriptions already exposed in specialized tools. Schema properties, required fields, enums, strict validation, supported tools and user messages remain unchanged; no silent history trimming. Actual model behavior with this shorter prompt has not been live-tested.

Diagnostics now accept OpenAI counters with or without colons (Limit, Used, Requested), report validated numeric duration reset headers, and show serialized request character count, explicitly not a token count. Raw provider prose and credentials remain excluded. A short token reset header does not override a longer valid Retry-After.

Validation: npm run typecheck; npm run test (338 tests, 21 suites); npm run smoke. Regression covers mixed-plan schema equivalence, colon-free Used/Requested, reset duration and honoring the exact long wait. Compiled smoke covers habit read/apply, mixed scheduling, carry-over deadlines, book estimation, balancing, restart/undo and Clear. All passing.

No paid inference or credential access. This optimization reduces avoidable payload overhead; it is not evidence that the provider has accepted the user's request or that its long retry delay is correct. Public official reference: https://developers.openai.com/api/docs/guides/rate-limits.
