# Skills Hub / Hooks / PWA rollout report

## Goal

Address the latest Hub issues reported against the `test/testtest` flow:

1. Skills Hub returned `502` for Connector-backed servers.
2. Hooks page layout did not match the rest of the app shell.
3. Hook approvals were easy to miss and the approval copy was unclear.
4. Hook approvals needed browser/PWA notification support.
5. Validation had to include a real Docker Connector using host Codex auth.

## What changed

### 1. Connector-scoped Skills Hub

Implemented Connector-aware routing for the entire Skills Hub flow:

- list/browse now use the active Server / Connector scope
- SKILL.md reads use the active Server / Connector scope
- Connector-backed Servers no longer fail with `502`
- Connector-backed skill install/uninstall now execute on the Connector host over relay transport
- Skills Hub cache keys are now server-scoped so results do not bleed across Connectors

Key files:

- `src/api/codexGateway.ts`
- `src/components/content/SkillsHub.vue`
- `src/components/content/SkillDetailModal.vue`
- `src/server/codexAppServerBridge.ts`
- `src/connector/codexUiConnectorAppServer.ts`
- `src/connector/localCodexAppServer.ts`
- `src/shared/serverSkillsBridge.ts`

### 2. Hook UX and layout fixes

Improved the approval workflow UX:

- Hooks page shell now matches Settings/page gutters
- global hook banner added to the main content area
- thread approval cards now use explicit copy:
  - `Shell command approval`
  - `Approve`
  - `Approve for session`
  - `Reject`
- command text is rendered directly in the approval card
- existing hook inbox tests were updated for the new banner/button structure

Key files:

- `src/App.vue`
- `src/components/content/HookInboxPanel.vue`
- `src/components/content/ThreadConversation.vue`

### 3. PWA + browser notifications

Added a first PWA/web-push layer for hook approvals:

- service worker: `public/sw.js`
- manifest: `public/manifest.webmanifest`
- app icon: `public/icon.svg`
- Settings UI can enable/disable browser notifications
- Hub issues/stores per-user push subscriptions
- hook events fan out to saved browser subscriptions
- live in-browser `Notification` alerts are raised when pending hook count increases

Key files:

- `src/api/pwaGateway.ts`
- `src/components/content/SettingsPanel.vue`
- `src/main.ts`
- `src/server/sqliteStore.ts`
- `src/server/pushSubscriptionStore.ts`
- `src/server/webPushService.ts`
- `index.html`

### 4. Relay event bootstrap for live hook delivery

A relay bootstrap route is now established automatically so Connector notifications can be pushed upstream without waiting for an earlier UI-originated RPC.

Key files:

- `src/server/relay/relayHub.ts`
- `src/connector/codexUiConnectorAppServer.ts`

## TDD / verification

### Contract tests

Executed:

```bash
npm run test:multi-server
```

Result:

- **48 passed**
- includes new coverage for:
  - relay skills browse/install/uninstall
  - relay pending hook hydration/reply
  - push subscription storage + hook fanout sink test

Relevant tests:

- `tests/multi-server/relay-skills-and-server-requests-contract.test.mjs`
- `tests/multi-server/pwa-push-notifications-contract.test.mjs`
- `tests/multi-server/connector-scoped-fs-bridge.test.mjs`

### Playwright

Executed:

```bash
PLAYWRIGHT_BASE_URL=http://127.0.0.1:4310 npx playwright test --reporter=line
```

Result:

- **16 passed**

New/updated UI coverage includes:

- `tests/playwright/skills-hub-server-scope.spec.ts`
- `tests/playwright/hook-alerts.spec.ts`
- `tests/playwright/hooks-layout-parity.spec.ts`
- `tests/playwright/hooks-inbox.spec.ts`
- `tests/playwright/pwa-notifications-settings.spec.ts`

### Build

Executed:

```bash
npm run build
```

Result:

- frontend build ✅
- CLI build ✅

## Live Docker validation (`test/testtest`)

### Environment used

- Hub: Dockerized service on `http://127.0.0.1:4300`
- user account: `test / testtest`
- live Connector container: `codex-cli-live-connector`
- host Codex auth mounted into the container
- host `.omx` config copied into the container so Codex app-server could materialize real threads/hooks

### Live steps completed

1. Logged in with `test/testtest`.
2. Created Connector `live-docker`.
3. Ran `codexui-connector install` inside the Docker container.
4. Started `codexui-connector connect` in the container.
5. Verified Connector status became `connected`.
6. Verified live Connector stats were returned.
7. Verified live Skills Hub against `serverId=live-docker` returned `200`.
8. Triggered a real `hostname` approval request through the live Connector.
9. Verified `/codex-api/server-requests/pending?serverId=live-docker` returned the pending hook.
10. Verified approval replies returned `200` and cleared the pending hook queue.

### Representative live evidence

Connector stats snapshot:

```json
{
  "id": "live-docker",
  "installState": "connected",
  "connected": true,
  "projectCount": 12,
  "threadCount": 100
}
```

Live Skills Hub check:

- `GET /codex-api/skills-hub?serverId=live-docker&limit=5` → **200 OK**

Live hook approval check:

- pending method: `item/commandExecution/requestApproval`
- command: `/bin/bash -lc hostname`
- approval reply: `POST /codex-api/server-requests/respond?serverId=live-docker` → **200 OK**

## Screenshots

### Playwright / mocked deterministic UI captures

- `docs/screenshots/skills-hub-server-scope-desktop.png`
- `docs/screenshots/hook-alerts-thread-approval-desktop.png`
- `docs/screenshots/hooks-sidebar-order-desktop.png`
- `docs/screenshots/hooks-inbox-open-thread-desktop.png`
- `docs/screenshots/pwa-notifications-settings-desktop.png`

### Live Hub captures (`test/testtest` + Docker Connector)

- `docs/screenshots/live-test-user-settings.png`
- `docs/screenshots/live-test-user-skills.png`
- `docs/screenshots/live-test-user-hooks.png`
- `docs/screenshots/live-test-user-thread-approval.png`

## Notes / platform behavior

- Android / desktop Chromium browsers can use the normal Service Worker + Push flow.
- iPhone support requires adding the Hub to the Home Screen and opening it as a standalone web app before enabling notifications.
- The Hub stores push subscriptions per authenticated user, so each user only receives notifications for their own registered Connectors.

## Commits

- `5ce82f4` — Relay-enable skills hub and pending server requests
- `19d3457` — Scope skills hub UI and surface hook approvals
- `5d234ad` — Add connector-scoped skill installs and PWA hook alerts
