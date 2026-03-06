# Settings + Connectors

This phase introduces a dedicated **Settings** screen for connector lifecycle management.

## Scope

The hub now treats every remote runtime as an explicitly registered **Connector** that creates a matching relay-backed **Server** entry for the current user.

```text
Hub
└─ Server
   └─ Connector
      └─ Codex app-server
         └─ Project
            └─ Thread
```

## What changed

### 1. Explicit registration only
- Fresh users no longer receive an implicit local/default server.
- Local folders stay unavailable until a server or connector is registered.
- Connector creation automatically creates the bound relay server entry for the same user scope.

### 2. `/settings` route
- Added a dedicated Settings page in the left navigation.
- The page loads connector data from `GET /codex-api/connectors?includeStats=1`.
- The content area keeps the existing session controls while the Settings panel handles connector CRUD.

### 3. Connector management UI
The Settings page supports:
- Create connector
- Inspect connector metadata
- Rename connector
- Rotate one-time install token
- Delete connector
- View connection status (`Connected` / `Offline`)
- View counts (`projects`, `threads`)
- View last-seen timestamp

### 4. Server binding model
Each connector now owns a relay-backed server record:
- `connector.id` → user-visible connector identifier
- `connector.serverId` → server registry binding
- `connector.relayAgentId` → relay transport identity

Deleting a connector removes the bound server and disposes the runtime entry for that user scope.

## API surface

### Connector APIs
- `GET /codex-api/connectors?includeStats=1`
- `POST /codex-api/connectors`
- `PATCH /codex-api/connectors/:id`
- `POST /codex-api/connectors/:id/rotate-token`
- `DELETE /codex-api/connectors/:id`

### Returned fields
Connector payloads now expose:
- `id`
- `serverId`
- `name`
- `hubAddress`
- `relayAgentId`
- `connected`
- `lastSeenAtIso`
- `projectCount`
- `threadCount`
- `lastStatsAtIso`
- `statsStale`
- optional `relayE2eeKeyId`

## Status and count behavior

- When a connector is online, the hub requests `thread/list` through the relay transport and derives:
  - unique project count
  - thread count
- The hub stores the latest successful snapshot in the connector registry.
- If the connector is offline, the last snapshot is exposed with `statsStale: true`.

## UI notes

### New thread behavior
- New thread still requires explicit server selection.
- When no servers are registered, the home screen shows the registration-required empty state.

### Existing threads
- Existing thread pages remain read-only with respect to server selection.
- Settings is the central place for connector lifecycle operations.

## Recommended operator flow

1. Open **Settings**
2. Create a connector
3. Reveal the one-time install token and save it to a secure file on the remote host
4. Run the suggested `--token-file` install command
5. Return to Settings to confirm:
   - online state
   - project count
   - thread count
6. Rotate the token when reinstalling or revoking a connector

## Security guardrails

- Non-local hub addresses must use **HTTPS**.
- The Settings panel now keeps the token masked until the operator explicitly reveals it.
- Suggested install commands use `--token-file` so the token does not need to appear in shell history.

## Related docs
- [`docs/connector-package.md`](./connector-package.md)
- [`docs/implementation-report.md`](./implementation-report.md)
- [`docs/multi-server-test-workflow.md`](./multi-server-test-workflow.md)
