# DeepSeek preset validation

Author: Alex Hu / Codex. Date: 2026-10-02. Source: the commit containing this record. Upstream: `../../history/plan.md`; downstream: `../../releasing.md`, README and provider tests. Status: accepted locally; remote commit follows.

The existing DeepSeek option had no model IDs. The preset now uses the API root and current model IDs documented by DeepSeek. A fake transport checks model discovery, authorization header, request URL and payload, returned `create_tasks` call, and alternate model choice. No real credential or paid API call was made. Existing saved providers retain their own URL and model list. Typecheck, all 220 tests, actual bundle smoke, release check, and package passed. The isolated demo vault received only rebuilt plugin assets, with installed hashes checked. The earlier `/Users/alexhu/Projects/research/test/` path no longer exists, so it could not be updated. Official models can change, so discovery and manual editing remain available.

Official reference: https://api-docs.deepseek.com/quick_start/pricing/
