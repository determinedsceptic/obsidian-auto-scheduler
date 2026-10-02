# Release and community submission

This document prepares a release; it does not assert that one has been published or that Obsidian has accepted the plugin.

## Before publishing

1. Review the MIT license, English README, privacy disclosures, compatibility limits, screenshots, and `docs/release-notes.md`.
2. Run `npm ci --ignore-scripts`, `npm run typecheck`, `npm test`, `npm run smoke`, `npm run release:check`, and `npm run package`.
3. Check that package.json, package-lock.json, manifest.json, and versions.json agree on **0.6.0**, and use the exact canonical tag **`0.6.0`**, without a `v` prefix.
4. Freeze the intended Git commit and attach **main.js**, **manifest.json**, and **styles.css** as binary release assets. GitHub's automatic source archives do not replace them. Keep local SHA-256 checksums for verification.
5. Publish only after the maintainer approves the concrete candidate. Do not call the plugin community-approved before the directory accepts it.

The current maintainer credentials have repo access but **no workflow scope**. CI and release definitions are ready in `.github/workflow-templates/`; they are intentionally not active workflows or advertised as passing GitHub CI. To enable them, use credentials with the appropriate workflow permission and move the two files into `.github/workflows/`. `release.yml` publishes only canonical version tags after validation. Do not widen credential permissions silently.

Manual release after approval:

```sh
# Run only for an approved, pushed commit.
git tag 0.6.0 <approved-commit>
git push origin 0.6.0
gh release create 0.6.0 main.js manifest.json styles.css \
  --verify-tag --title "Auto Scheduler 0.6.0" --notes-file docs/release-notes.md
```

## Current submission route

Follow Obsidian's [Submit your plugin](https://docs.obsidian.md/Plugins/Releasing/Submit%20your%20plugin), [developer policies](https://docs.obsidian.md/community-directory/developer-policies), and [submission requirements](https://docs.obsidian.md/community-directory/submission-requirements-for-plugins). Checked on 2026-10-02.

The current route uses [community.obsidian.md](https://community.obsidian.md), rather than assuming the old community-plugins.json pull-request process:

1. Sign in with your Obsidian account.
2. Link the owning GitHub account to verify repository ownership. The maintainer must approve this account connection.
3. Add the plugin using `determinedsceptic/obsidian-auto-scheduler`.
4. Ensure the default branch manifest is accurate and a published GitHub release has the matching tag and installation assets.
5. Review automated feedback and resolve errors; make a new version/release for fixes. Publish only when the review permits it.

Prepared listing fields:

| Field | Value |
| --- | --- |
| Repository | `determinedsceptic/obsidian-auto-scheduler` |
| ID | `auto-scheduler` |
| Name | Auto Scheduler |
| Author | Alex Hu |
| Version | 0.6.0 |
| Minimum host | 1.6.6 |
| Platform | Desktop only |
| License | MIT |
| Description | Schedule Markdown tasks and recurring habits in daily notes with local planning, optional AI chat, capacity limits, and undo. |

The ID/name were checked against the legacy published community registry during preparation. That check is evidence of no conflict at that time, not a reservation or acceptance by the new directory.

## Release evidence

The local release check validates manifest, lockfile, versions, license, English runtime text, README links/images, bundled tool/skill availability, lack of Node/Electron runtime imports, and installation-file hashes. Unit tests cover scheduling and recovery; smoke loads the real bundle with a fake host and provider. Screenshots are separately captured in an isolated native Obsidian vault. No paid model call is part of release validation.
