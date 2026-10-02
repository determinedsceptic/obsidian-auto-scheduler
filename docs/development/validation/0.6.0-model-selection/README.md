# Model selection validation

Author: Alex Hu / Codex. Date: 2026-10-02. Source: the commit containing this record. Upstream: the user request to select among models for one API key and the existing BYOK provider state. Downstream: sidebar, provider modal, installation archive. Status: local validation passed; hosted-provider calls remain untested without a user key.

The sidebar now lists saved provider/model pairs and switches the active pair through the existing validated state transaction. The provider modal lets the user pick which of its saved model IDs becomes active after saving. The OpenAI template includes `gpt-6-luna` and `gpt-6-sol`; manually added and discovered model IDs remain available.

`npm run typecheck`, 221 tests, actual bundle smoke, release check, and packaging passed. Smoke verified that selecting the second model changes the next request body, that credentials stay scoped to the provider, and that an unknown selected model is rejected. Tests used a fake host and injected response; no external model call or real token was used. The independent demo vault received only the three rebuilt plugin assets. The previous external `test/` vault path was absent. Earlier screenshots document the prior candidate UI and are labeled accordingly.
