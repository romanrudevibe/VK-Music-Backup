# Project instructions

Read docs/PROJECT_STATE.md before changing the project. Work in this repository; keep previous release ZIPs for rollback. Preserve the working VK-tab connection, bad_hash refresh and durable download history. Do not upload personal music, diagnostic reports, cookies, keys, .env or SQLite data. New feedback is a user-reviewed GitHub Issue draft, not an automatic submission. Website statistics count aggregate daily page opens and ZIP requests only; no extension telemetry.

Run npm test for extension changes, python3 -m unittest discover -s tests -p 'test_*.py' for server changes, and npm run build for releases. Clearly separate automated checks from real VK verification. Do not add subagents without explicit user authorization.
