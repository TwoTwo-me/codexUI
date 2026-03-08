# Settings + Connectors

The **Settings** page is the operator UI for the Docker-hosted CodexUI Hub.

Use it to create, inspect, rename, reinstall, and delete per-user Connectors that attach remote Codex hosts to the Hub.

## Scope

```text
Hub
└─ Server
   └─ Connector
      └─ Codex app-server
         └─ Project
            └─ Thread
```

## Important behavior

### 1. Explicit registration only
- Fresh users do **not** receive a default local server.
- Local or remote runtimes only become available after explicit registration.
- Every Connector creation also creates the matching relay-backed Server entry for the current user.

### 2. Docker Hub baseline
The intended operator model is:
- central Hub runs in Docker
- users log into the Hub UI
- users register their own Connectors from **Settings**
- remote machines connect back outbound using `codexui-connector`

### 3. `/settings` route
The Settings page loads Connector state from:

- `GET /codex-api/connectors?includeStats=1`

It supports:
- create Connector
- inspect lifecycle metadata
- rename Connector
- reissue install token
- delete Connector
- confirm online/offline state
- inspect project/thread counts
- enable / disable browser push notifications for hook approvals

## Lifecycle states

- `Pending install`
- `Connected`
- `Offline`
- `Expired bootstrap`
- `Reinstall required`

## What each Connector row represents

Each Connector owns:

- `connector.id` — user-visible Connector identifier
- `connector.serverId` — linked Server registry record
- `connector.relayAgentId` — relay transport identity

Deleting the Connector removes the matching relay-backed Server from the same user scope.

## Recommended operator flow

1. Deploy the Hub with Docker
2. Set `CODEXUI_PUBLIC_URL` to the public Hub origin
3. Sign in to the Hub
4. Open **Settings**
5. Create a Connector using that Hub origin
6. Reveal the bootstrap token once
7. Save it securely on the remote host
8. Run the suggested `npm exec --package=github:TwoTwo-me/codexUI#main -- codexui-connector install --token ... --token-file ...` command
9. Start the runtime with `npm exec --package=github:TwoTwo-me/codexUI#main -- codexui-connector connect --token-file ...`
10. Return to Settings and confirm:
    - install state
    - transport online/offline state
    - project count
    - thread count

## API surface

- `GET /codex-api/connectors?includeStats=1`
- `POST /codex-api/connectors`
- `PATCH /codex-api/connectors/:id`
- `POST /codex-api/connectors/:id/rotate-token`
- `DELETE /codex-api/connectors/:id`
- `POST /codex-api/connectors/:id/bootstrap-exchange`

## Bootstrap security model

### Create / reissue
- `POST /codex-api/connectors` returns a one-time **bootstrap token**.
- `POST /codex-api/connectors/:id/rotate-token` invalidates the current durable runtime credential and issues a fresh install token.

### Exchange
- `POST /codex-api/connectors/:id/bootstrap-exchange` is the one-time enrollment step.
- The Connector authenticates with the bootstrap token.
- The Hub returns a **durable relay credential**.
- Replay attempts are rejected.
- Expired bootstrap tokens are rejected.

### Runtime
Only the durable runtime credential is accepted by:
- `POST /codex-api/relay/agent/connect`
- `GET /codex-api/relay/agent/pull`
- `POST /codex-api/relay/agent/push`

## Status / counts

When a Connector is online, the Hub can derive:
- unique project count
- thread count

The latest successful stats snapshot is cached in the Connector registry and marked stale if the Connector later goes offline.

## Browser notifications

Settings also exposes a **Browser notifications** card backed by:

- `GET /codex-api/pwa/config`
- `GET /codex-api/pwa/subscriptions`
- `POST /codex-api/pwa/subscriptions`
- `DELETE /codex-api/pwa/subscriptions`

This lets each signed-in user register the current browser/PWA as a hook notification target.

## Connector-scoped Skills Hub

The Skills Hub now follows the active Server / Connector scope for:

- skills listing
- installed skill detection
- SKILL.md fetches
- Connector-side install / uninstall over relay transport

## Related docs

- [`docs/hub-docker-deployment.md`](./hub-docker-deployment.md)
- [`docs/connector-package.md`](./connector-package.md)
- [`docs/implementation-report.md`](./implementation-report.md)
- [`docs/multi-server-test-workflow.md`](./multi-server-test-workflow.md)
