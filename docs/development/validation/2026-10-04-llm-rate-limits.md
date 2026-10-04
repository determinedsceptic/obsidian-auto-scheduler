# LLM rate-limit handling

Author: Codex for Alex Hu. Date: 2026-10-04.
Upstream: `src/llm-request.ts`, `src/llm.ts`, `src/chat-view.ts`.
Acceptance: automated validation passed; installed bundle reloaded in `undo`.

The former adapter discarded error JSON and response headers, then showed the same key/model/quota advice for all HTTP failures. It made no attempt to recover transient 429 responses. The user's actual provider-side cause cannot be determined from that old generic message.

The new transport preserves JSON and headers without exposing arbitrary error prose. Explicit insufficient quota/billing codes fail immediately. Other 429 responses retry up to twice with server-provided wait times or jittered exponential backoff. Requests retain their exact body and selected provider/model. Waits are bounded by 30 seconds and each model round's existing 60-second budget; longer server waits are reported rather than shortened. Network/timeouts and non-429 failures are not retried. Retry progress appears in the sidebar, and closing the chat prevents subsequent retry requests.

Before the model succeeds there are no host writes. A failed model request restores its original input; failed request/error messages remain visible but are excluded from future model context. Tests verify recovered requests schedule exactly once.

Validation:

```sh
npm run typecheck
npm run test
npm run smoke
```

- 331 unit tests passed, including header/date/Gemini wait parsing, exhausted quota, retry exhaustion, timeout budget, cancellation and authentication/network behavior.
- Compiled host smoke passed: explicit quota failure makes one request, preserves files/state and restores the prompt; two transient 429s plus success send identical bodies, omit failed chat context and create a single task.
- Installed `main.js` updated in `undo` and Auto Scheduler Demo; previous bundles backed up under ignored `local-test-vaults/install-backups/`.
- Native Obsidian reloaded and the user's failed prompt restored to the composer without submitting it. No live paid model request was used to validate this change. This verifies plugin handling, not the provider's current quota or availability.
