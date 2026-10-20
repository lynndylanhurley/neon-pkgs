---
"@neon/realtime": minor
---

Accept terminal `resource_limit_exceeded` subscription errors with SQLSTATE `54000` during baseline sync and live updates. Preserve the error code and SQLSTATE without automatically resubscribing.
