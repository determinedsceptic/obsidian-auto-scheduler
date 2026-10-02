# Reproduce the examples

All example notes are synthetic. The AI screenshots use a deterministic localhost fixture; this is not evidence about a hosted model's interpretation quality. Actual host validation, scheduling, note writes, links, and undo are exercised.

1. Copy `examples/vault/` into a new vault named **Auto Scheduler Demo**.
2. Build with `npm run package`, then install main.js, manifest.json, and styles.css into its `.obsidian/plugins/auto-scheduler/` folder. Enable Auto Scheduler.
3. Set daily-note output, Day Planner format, and clean lists. The fixed-event example dates are **2026-10-05/06**; change them to the next working week if reproducing later. No task relies on those old deadlines.
4. Start `python3 scripts/demo-provider.py`. It prints the loopback endpoint and model `local-demo-fixture`.
5. Add a custom Chat Completions provider named **Local demo (fixture)**, use the printed endpoint, turn off Requires API key, and enter the model ID. No key or paid provider is needed.
6. Send “Review Linear Algebra and Statistics, two hours each, high priority. Please schedule them.” Capture the assistant and saved daily note.
7. Send “Every day, walk from 19:00 to 19:30, normal priority. Save this as a habit.” Capture the habit results and template.
8. Run Preview weekly schedule and inspect additions, capacity, and remaining backlog. Capture the preview.
9. Open the local provider configuration for the fourth screenshot. Never capture keys from a real provider.
10. Stop the fixture server when finished; it only binds to 127.0.0.1 and does not call an upstream service.

Captures are saved under `docs/screenshots/`. `docs/screenshots/README.md` records the host, version, synthetic inputs, and capture conditions. Screenshot dates reflect the capture day; they are examples, not your personal schedule.

`demo-vault/` separately preserves the earlier fixed-date performance/format fixture used by `npm run demo`; its run output now goes to ignored `local-test-vaults/demo-validation/`.
