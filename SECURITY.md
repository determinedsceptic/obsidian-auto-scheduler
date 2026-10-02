# Security

Do not post live API keys, private notes, or full plugin data.json in a public issue. Redact provider credentials and note text from reports.

For a security-sensitive report, use this repository's GitHub private vulnerability reporting if the maintainer enables it. If unavailable, first open an issue asking for a private contact without describing exploitable details or sharing secrets. Do not assume this project offers a private email address or a response-time guarantee.

The current development line is supported; older versions should be upgraded. AI outputs are untrusted input and are validated locally. The plugin does not execute scripts, shell commands, or model-selected filesystem paths. It sends only user-initiated chat/model-discovery requests to the chosen endpoint.

See `docs/privacy.md` for data flow and credential storage, and `docs/usage.md` for recovery after a partial write.
