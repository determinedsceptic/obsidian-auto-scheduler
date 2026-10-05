# Immediate network failure

Author: Codex for Alex Hu. Date: 2026-10-05.
Upstream: src/llm-request.ts; previous commit f22c227.

User reports an immediate generic transport failure, distinct from previous HTTP 429. A no-credential GET to https://api.openai.com/v1/models outside the execution sandbox failed to connect to port 443 within ten seconds (HTTP 000, TLS not established). This proves that direct access failed on this probe, not that Obsidian uses the same route or that the provider/model is unavailable. No API token was read or sent. The user was asked which proxy/VPN route is used; no system networking changes were made.

The request layer now separates its own response deadline from transport failures and emits only recognized DNS, proxy, refused/reset connection, network timeout or TLS error codes. Unrecognized exceptions remain sanitized. No retries of ambiguous transport errors, no disabled TLS checks, and no repeated paid inference. Clear cancellation remains intact.

Validation: node scripts/run.mjs test tests/llm-request.test.ts (21 tests passed), npm run typecheck, npm run build. Existing scheduling behavior is unchanged; prior 338-test and compiled smoke records apply to the unaffected scheduling path. New regressions cover safe known-code classification, secret/raw-URL suppression and one deadline with no resend/timer leak. Live inference success remains unverified; network access/proxy configuration needs resolution.

User identified Clash Verge. Its native UI reports system proxy enabled at 127.0.0.1:7897, correcting the earlier command that could not observe system proxy configuration. An explicit curl probe through that proxy completed TLS and returned HTTP 401 in about two seconds without credentials. Added a command-palette no-token GET probe in Obsidian; compiled smoke confirms GET carries neither headers nor body, treats 401 as connectivity only, and preserves existing scheduling behavior. Full compiled smoke and typecheck pass.

Native verification after installing/reloading: Obsidian command returned HTTP 401 without a token. Sent the user's original greeting 你好 once using the configured provider via the normal chat UI; GPT-6 Luna replied 你好！有什么可以帮你安排或记录的吗？. No scheduling tool/write occurred and the visible daily note remained unchanged. This establishes current successful authenticated inference after reload; the original transient connection error's precise cause is still unknown. No proxy configuration was changed, and no credential was exposed to the agent.
