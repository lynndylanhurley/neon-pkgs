---
"@neon/realtime": patch
---

Document the server's large-output limits and distinguish complete-message chunks from per-value, per-row and cumulative result sizes. Preserve the SDK's uncapped message and staging behavior and verify compatibility with 2 MiB messages and escaped large rows.
