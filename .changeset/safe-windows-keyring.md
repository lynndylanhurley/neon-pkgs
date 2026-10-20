---
"neon": patch
---

`neon login --keyring` on Windows no longer fails after the browser step. OAuth sessions now store only the fields the CLI reads, which fits Windows Credential Manager's 1,280-character limit, and a credential that still doesn't fit fails before anything is written with a message that names the command to run instead.
