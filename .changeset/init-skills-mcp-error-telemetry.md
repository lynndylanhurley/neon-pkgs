---
"neon": minor
---

Failures in `neon init`, `neon skills` and `neon mcp` now report which step failed and why. The `CLI Error` analytics event gains `command`, `step`, `errorKind`, `agents`, `skills`, `scope`, and the child process's `exitCode`, `timedOut` and `signal`, and its message is cut to the last 500 characters with home and working directories and credentials removed. `cli_init_end` gains `failed_step` and `error_kind`, and the error carries the run's `init_run_id`. Nothing changes in what the commands print, and nothing is sent with `--no-analytics`.
