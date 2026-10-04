# Clear and long Retry-After diagnostics

Author: Codex for Alex Hu. Date: 2026-10-04.
Upstream: `src/llm-request.ts`, `src/chat-view.ts`, `src/main.ts`, `src/llm.ts`.

The previous generic wait message could not distinguish model/project request or token caps from exhausted balance. The reported 15475-second delay cannot be diagnosed retrospectively without its original headers and body. Local settings use OpenAI's Responses endpoint and `gpt-6-luna`; the origin of the user's key has not been assumed or changed.

Read the official [rate-limit guide](https://developers.openai.com/api/docs/guides/rate-limits) and [GPT-6 Luna model page](https://developers.openai.com/api/docs/models/gpt-6-luna). A valid Retry-After is a minimum, including long waits. The fix does not reinterpret large numeric seconds as milliseconds or bypass a server limit.

Changes:

- HTTP-date waits compare to the server Date header when available, avoiding inflated waits caused by local clock skew.
- Safe diagnostics identify known request/day, request/minute or token/minute categories and numeric limit/remaining/requested values. Raw provider prose, org IDs, keys and prompts are not displayed.
- Removed ambiguous `quota_exceeded` from automatic billing classification. Official OpenAI 429 messages link to API limits.
- Responses output reservation reduced from 4096 to 2048 tokens; GPT-6 Luna uses supported no-reasoning mode. Strict incomplete-output rejection remains.
- Clear button always available; new command palette action clears chat and draft, aborts local wait, and invalidates the job generation. Late responses cannot restore the conversation or schedule tasks. Model settings and saved schedules remain intact. A host write already in progress finishes atomically before a new request is allowed.

Validation:

```sh
npm run typecheck
npm run test
npm run smoke
```

336 unit tests passed. Compiled host smoke verifies Clear during an in-flight transport, ignores its late task-creation reply, preserves notes/state, sends a fresh single-message context afterwards, and supports command-palette clearing. Unit checks cover immediate abort with no leaked timers, server-clock date correction and retaining the exact numeric 15475-second delay. Existing scheduling/read-revise/undo regressions pass.

No live paid inference was performed. The actual provider limit or a gateway endpoint mismatch remains to be confirmed from the user's endpoint information or the next safely summarized error. This is not evidence that the provider now accepts their requests.

Installed the compiled bundle in undo and the demo vault. Reloaded Obsidian and verified the Clear control empties a typed draft without sending a request; daily notes remain visible and unchanged.
