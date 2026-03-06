# Multi-Stage Implementation Report (Phase 1 → Phase 5)

> Operational baseline update (2026-03-07): the repository is now documented and packaged as a **Docker-first CodexUI Hub**. Use [`docs/hub-docker-deployment.md`](./hub-docker-deployment.md) for deployment and treat `docker/multi-server/` as a test fixture stack.

## Scope
- Phase 1: Multi-server support
- Phase 2: Multi-user + auth + admin panel
- Phase 3: Outbound relay transport hardening
- Phase 4: E2EE relay payload plumbing

---

## Phase 1 — Multi-server

### Delivered
- Per-user server registry model with default server selection.
- Server-scoped routing headers/query handling (`x-codex-server-id`, `serverId`).
- Docker workflow for multi-server Codex CLI setup and smoke checks.

### Validation
- `npm run test:multi-server` ✅
- Docker scripts:
  - `npm run docker:multi-server:prepare-auth`
  - `npm run docker:multi-server:up`
  - `npm run docker:multi-server:smoke`

---

## Phase 2 — Multi-user + Admin

### Delivered
- Signup/login/session/logout auth flows.
- Admin-only user listing and admin UI panel.
- Per-user registry isolation in API contract tests.
- Login/signup abuse controls and safer defaults (localhost bind, secure file mode, dev host hardening).

### Validation
- `npm run test:multi-server` ✅
- `npm run build` ✅
- Playwright screenshots:
  - `.artifacts/screenshots/phase2-admin-desktop.png`
  - `.artifacts/screenshots/phase2-admin-mobile.png`

---

## Phase 3 — Outbound Relay

### Delivered
- Relay agent provisioning + connect/pull/push endpoints.
- Relay transport RPC path and relay-backed event streaming.
- Token+session binding for pull/push (session hijack hardening).
- Channel validation/enforcement (`x-codex-channel-id`, `channelId`).
- Dual-layer public endpoint throttling (IP + client key), bounded limiter state.
- Backpressure and fairness controls in relay hub:
  - global/scope/agent pending RPC limits
  - per-session queue cap
  - bounded per-agent route tracking
  - pending RPC cleanup on disconnect
- Legacy relay agent id compatibility normalization (`agent:<id>` → canonical `<id>`).

### Validation
- `npm run test:multi-server` ✅
- `npm run build` ✅
- Playwright admin regression run ✅
- Security/code gate reviews: GO ✅

---

## Phase 4 — E2EE Relay Payload Plumbing

### Delivered
- Relay E2EE metadata in server registry (`relay.e2ee.keyId`, `relay.e2ee.algorithm`).
- Strict metadata validation and contract test coverage.
- New relay E2EE envelope model:
  - `src/types/relayE2ee.ts`
- Shared AES-256-GCM crypto helpers:
  - `src/utils/relayE2eeCrypto.ts`
- Encrypted relay RPC request/response flow in client:
  - encrypt before `/codex-api/rpc`
  - decrypt encrypted relay results
- Relay server enforcement of E2EE policy:
  - reject encrypted payloads when relay E2EE is not configured
  - enforce `keyId` + `algorithm` match
- Encrypted relay notification decode path with:
  - ordered processing
  - bounded queue depth

### Security posture
- Passphrase handling moved to in-memory runtime map (not persisted to localStorage).

### Validation
- `npm run build` ✅
- `npm run test:multi-server` ✅
- `npm run test:playwright:admin` ✅
- Security/code gate reviews: GO ✅

---

## Deployment packaging — Docker Hub

### Delivered
- Root `Dockerfile` for a production Hub image.
- Root `docker-compose.yml` for a single-Hub deployment.
- Tracked `.env` with first-boot defaults.
- `scripts/docker/hub-smoke.sh` for post-start validation.
- README/docs rewritten around Hub + Connector deployment and upstream attribution.

### Validation
- `npm run build` ✅
- `docker compose config` ✅
- `npm run docker:hub:prepare-auth` ✅
- `npm run docker:hub:up` ✅
- `npm run docker:hub:smoke` ✅

---

## Commit trail (recent milestones)
- `7935e88` Harden relay transport auth, routing, and compatibility
- `f521051` Add relay fairness quotas and bounded route tracking
- `6c825ea` Add relay E2EE metadata validation in server registry
- `74cbfd0` Add relay E2EE request plumbing and crypto helpers
- `369dd9a` Serialize and bound encrypted notification processing

---

## Phase 5 — Explicit registration, Settings, and connector package

### Delivered
- Explicit registration-only server model (no implicit local/default server).
- Empty-state UX when no server or connector has been registered yet.
- Per-user connector registry with one-time token issuance.
- Automatic connector ↔ relay-server binding cleanup on rename/delete.
- Connector stats API with `projectCount`, `threadCount`, `lastStatsAtIso`, and `statsStale`.
- `/settings` route with connector create, rename, rotate-token, and delete flows.
- `codexui-connector` CLI package with:
  - `provision` for hub login + connector registration
  - `connect` for outbound relay daemon mode
  - local Codex app-server proxy loop and relay notification forwarding

### Validation
- `npm run build` ✅
- `npm run test:multi-server` ✅
- `npx playwright test tests/playwright/settings-connectors.spec.ts --reporter=line` ✅

### Recent milestones
- `f23f53e` Require explicit server registration
- `41f1423` Add empty state for unregistered servers
- `6f64043` Add per-user connector registry tokens
- `b0bb993` Implement connector lifecycle and stats APIs
- `3f8a7b4` Add settings UI for connector management

### Connector bootstrap hardening addendum

#### Delivered
- Split connector **bootstrap tokens** from durable relay credentials.
- Added one-time `POST /codex-api/connectors/:id/bootstrap-exchange` enrollment flow.
- Enforced reinstall semantics:
  - bootstrap tokens are single-use and short-lived
  - `rotate-token` now reissues install state instead of rotating the live credential in place
  - runtime relay auth only accepts the durable connector credential
- Updated `codexui-connector` CLI:
  - `provision` returns bootstrap metadata
  - `install` exchanges bootstrap token and rewrites the token file with the durable credential
  - `connect` now clearly represents durable-credential runtime mode
- Updated Settings UI to show:
  - `Pending install`
  - `Connected`
  - `Offline`
  - `Expired bootstrap`
  - `Reinstall required`
  - bootstrap metadata timestamps and reissue action

#### Validation
- `node --test tests/multi-server/connector-registration-per-user.test.mjs tests/multi-server/connector-management-contract.test.mjs` ✅
- `node --test tests/multi-server/connector-provisioning-package.test.mjs tests/multi-server/relay-connector-provisioning.test.mjs` ✅
- `npx playwright test tests/playwright/settings-connectors.spec.ts --reporter=line` ✅

#### Screenshots
- `.artifacts/screenshots/settings-connectors-desktop.png`
- `.artifacts/screenshots/settings-connectors-expired-desktop.png`

#### Milestones
- `07f0cd5` Split connector bootstrap tokens from relay credentials
- `861f539` Add bootstrap-aware connector install flow
- `a1a1381` Show connector bootstrap lifecycle in settings

## Current status
- Phase 1–5 implementation track is complete at transport, onboarding, and settings-management level.
- Hub users now have an explicit registration workflow for both local/relay servers and packaged outbound connectors.
