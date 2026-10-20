---
"@neon/realtime": patch
"@neon/realtime-tanstack": patch
---

Resume raw subscriptions from a persisted position instead of downloading the complete result again. `subscribe(query, { materialize: false, resume: { from } })` asks the server to continue from rows the caller already holds, and updates report the position to persist next to those rows. `realtimeCollectionOptions({ resume: true })` stores the position in TanStack DB sync metadata, in the same transaction as the rows, and skips the truncate and re-insert when the server confirms continuity. A server that cannot confirm continuity, or does not support resume, sends a complete baseline as before. Resume is negotiated through the opt-in `neon.realtime.v1+resume` WebSocket subprotocol, so subscriptions without `resume` connect exactly as before.
