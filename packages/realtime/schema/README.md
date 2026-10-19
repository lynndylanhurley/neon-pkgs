# Realtime schemas

These files are the canonical public contracts for Realtime protocol messages
and decoded query capabilities. Their package exports use the same filenames:

- `@neon/realtime/schema/realtime-protocol-v1.schema.json`
- `@neon/realtime/schema/realtime-query-capability-v1.schema.json`

After editing a schema, run `pnpm --filter @neon/realtime generate` to refresh
the generated TypeScript types and standalone protocol validator. Build and
test scripts check that the generated files match the source schemas.

## Output byte limits

The protocol schema describes complete cells and rows inside application-message
chunks. Its `$comment` annotations distinguish server transport limits from
structural validation. A JSON Schema `maxLength` counts Unicode characters and
cannot express the UTF-8 size of an encoded JSON message, including escaping,
base64 and the envelope.

The large-output server profile supports 256 KiB per value, 320 KiB per row
(visible payload plus five bytes per cell), and 2 MiB per outgoing message.
These operational limits are enforced by the server. The SDK does not enforce
message-size or cumulative-staging caps; consumers of the exported schema must
not interpret these annotations as generated validator constraints. Input
parameter limits and the query-capability schema are unchanged.

## Proxy synchronization

The Realtime proxy vendors these schemas from immutable commits in this
repository. Its schema sync script must accept these source paths:

- `packages/realtime/schema/realtime-protocol-v1.schema.json`
- `packages/realtime/schema/realtime-query-capability-v1.schema.json`

Update the adjacent `.source.json` metadata with the source commit, path,
blob, source SHA-256, and generated SHA-256. Regenerate and check both schemas
using the proxy's `make realtime-protocol-schema`,
`make realtime-protocol-schema-check`, `make realtime-query-capability-schema`,
and `make realtime-query-capability-schema-check` targets. The source `$id`,
title, and audience now already match the proxy's Realtime identity.

The naming cleanup preserves live-query API names such as `useLiveQuery` and
`SealedLiveQuery`, the `live` lifecycle state, and the `live_id` wire field.
The single-key secret uses the opaque prefix `nrt_live_1`. The fingerprint
domain remains `neon-live-query-fingerprint-v1\0`.
