import { expect, test, type Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'

const BASE_URL = process.env.PLAYWRIGHT_BASE_URL ?? 'http://127.0.0.1:4310'
const SCREENSHOT_DIR = process.env.PLAYWRIGHT_SCREENSHOT_DIR?.trim() || '.artifacts/screenshots'

type MockConnector = {
  id: string
  serverId: string
  name: string
  hubAddress: string
  relayAgentId: string
  connected: boolean
  installState: 'pending_install' | 'connected' | 'offline' | 'expired_bootstrap' | 'reinstall_required'
  bootstrapIssuedAtIso?: string
  bootstrapExpiresAtIso?: string
  bootstrapConsumedAtIso?: string
  credentialIssuedAtIso?: string
  projectCount?: number
  threadCount?: number
  statsStale?: boolean
  createdAtIso: string
  updatedAtIso: string
  lastSeenAtIso?: string
}

function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true })
}

async function mockSettingsApi(page: Page, state: { connectors: MockConnector[]; latestToken: string }): Promise<void> {
  await page.addInitScript(() => {
    window.localStorage.setItem('codex-web-local.sidebar-collapsed.v1', '0')
  })

  await page.route('**/auth/session', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        authenticated: true,
        user: {
          id: 'settings-user',
          username: 'settings-user',
          role: 'user',
        },
      }),
    })
  })

  await page.route('**/codex-api/servers', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        data: {
          defaultServerId: '',
          servers: [],
        },
      }),
    })
  })

  await page.route('**/codex-api/workspace-roots-state', async (route) => {
    if (route.request().method().toUpperCase() === 'PUT') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) })
      return
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: { order: [], labels: {}, active: [] } }),
    })
  })

  await page.route('**/codex-api/thread-titles', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: { titles: {}, order: [] } }),
    })
  })

  await page.route('**/codex-api/server-requests/pending**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: [] }),
    })
  })

  await page.route('**/codex-api/meta/methods', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: [] }) })
  })

  await page.route('**/codex-api/meta/notifications', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: [] }) })
  })

  await page.route('**/codex-api/notifications**', async (route) => {
    await route.fulfill({
      status: 200,
      headers: {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      },
      body: '',
    })
  })

  await page.route('**/codex-api/rpc', async (route) => {
    await route.fulfill({
      status: 400,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'No servers registered.' }),
    })
  })

  await page.route('**/codex-api/connectors?*', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: { connectors: state.connectors } }),
    })
  })

  await page.route('**/codex-api/connectors', async (route) => {
    if (route.request().method().toUpperCase() === 'POST') {
      const payload = route.request().postDataJSON()
      state.latestToken = `bootstrap-${String(Date.now())}`
      const created: MockConnector = {
        id: payload.id,
        serverId: payload.id,
        name: payload.name,
        hubAddress: payload.hubAddress,
        relayAgentId: `agent-${payload.id}`,
        connected: false,
        installState: 'pending_install',
        bootstrapIssuedAtIso: '2026-03-07T08:00:00.000Z',
        bootstrapExpiresAtIso: '2026-03-07T08:15:00.000Z',
        createdAtIso: '2026-03-07T08:00:00.000Z',
        updatedAtIso: '2026-03-07T08:00:00.000Z',
      }
      state.connectors = [created, ...state.connectors]
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({
          data: {
            connector: created,
            bootstrapToken: state.latestToken,
          },
        }),
      })
      return
    }

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: { connectors: state.connectors } }),
    })
  })

  await page.route('**/codex-api/connectors/*/rotate-token', async (route) => {
    state.latestToken = `reissued-${String(Date.now())}`
    const connectorId = route.request().url().split('/codex-api/connectors/')[1].split('/')[0]
    state.connectors = state.connectors.map((connector) => connector.id === connectorId
      ? {
          ...connector,
          connected: false,
          installState: connector.credentialIssuedAtIso ? 'reinstall_required' : 'pending_install',
          bootstrapIssuedAtIso: '2026-03-07T08:30:00.000Z',
          bootstrapExpiresAtIso: '2026-03-07T08:45:00.000Z',
          updatedAtIso: '2026-03-07T08:30:00.000Z',
        }
      : connector)
    const connector = state.connectors.find((entry) => entry.id === connectorId)
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        data: {
          connector,
          bootstrapToken: state.latestToken,
        },
      }),
    })
  })

  await page.route('**/codex-api/connectors/*', async (route) => {
    const requestUrl = route.request().url()
    const connectorId = requestUrl.split('/codex-api/connectors/')[1]
    if (route.request().method().toUpperCase() === 'PATCH') {
      const payload = route.request().postDataJSON()
      state.connectors = state.connectors.map((connector) =>
        connector.id === connectorId
          ? {
              ...connector,
              name: payload.name,
              updatedAtIso: '2026-03-07T08:10:00.000Z',
            }
          : connector,
      )
      const connector = state.connectors.find((entry) => entry.id === connectorId)
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ data: { connector } }),
      })
      return
    }

    if (route.request().method().toUpperCase() === 'DELETE') {
      state.connectors = state.connectors.filter((connector) => connector.id !== connectorId)
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, data: { connectors: state.connectors } }),
      })
      return
    }

    await route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'Not found' }) })
  })
}

test('settings page manages connector bootstrap lifecycle end-to-end', async ({ page }) => {
  ensureDir(SCREENSHOT_DIR)
  const state = {
    connectors: [
      {
        id: 'build-runner',
        serverId: 'build-runner',
        name: 'Build Runner',
        hubAddress: 'https://hub.example.test',
        relayAgentId: 'agent-build-runner',
        connected: true,
        installState: 'connected',
        credentialIssuedAtIso: '2026-03-07T07:00:00.000Z',
        projectCount: 2,
        threadCount: 4,
        statsStale: false,
        createdAtIso: '2026-03-06T07:00:00.000Z',
        updatedAtIso: '2026-03-07T07:15:00.000Z',
        lastSeenAtIso: '2026-03-07T07:15:00.000Z',
      },
    ] as MockConnector[],
    latestToken: '',
  }

  await mockSettingsApi(page, state)

  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(`${BASE_URL}/settings`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1200)

  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible()
  await expect(page.getByText('Build Runner')).toBeVisible()
  await expect(page.getByText('2 projects')).toBeVisible()
  await expect(page.getByText('4 threads')).toBeVisible()
  await expect(page.getByText('Connected').first()).toBeVisible()

  await page.getByLabel('Connector name').fill('Alpha Laptop')
  await page.getByLabel('Connector id').fill('alpha-laptop')
  await page.getByLabel('Hub address').fill('https://hub.example.test')
  await page.getByRole('button', { name: 'Create connector' }).click()

  await expect(page.locator('.settings-detail-card').getByText('Pending install')).toBeVisible()
  await expect(page.getByText('Bootstrap token is only shown once.')).toBeVisible()
  await expect(page.locator('input[value="Alpha Laptop"]').first()).toBeVisible()
  await expect(page.getByLabel('Suggested install command')).toHaveValue(/codexui-connector install/)
  await expect(page.getByLabel('Suggested install command')).toHaveValue(/--token-file/)
  await expect(page.getByText('Bootstrap expires')).toBeVisible()

  await page.getByRole('button', { name: 'Edit name' }).click()
  await page.getByLabel('Rename connector').fill('Alpha Laptop Renamed')
  await page.getByRole('button', { name: 'Save name' }).click()
  await expect(page.getByText('Alpha Laptop Renamed')).toBeVisible()

  await page.getByRole('button', { name: 'Build Runner Connected build-runner · build-runner' }).click()
  await page.getByRole('button', { name: 'Reissue install token' }).click()
  await expect(page.locator('.settings-detail-card').getByText('Reinstall required')).toBeVisible()
  await page.getByText('Reveal token').click()
  await expect(page.locator('.settings-install-card .settings-code-block').first()).toHaveValue(/reissued-/)

  await page.getByRole('button', { name: 'Alpha Laptop Renamed Pending install alpha-laptop · alpha-laptop' }).click()
  await page.getByRole('button', { name: 'Delete connector' }).click()
  await page.getByRole('button', { name: 'Confirm delete' }).click()
  await expect(page.getByText('Alpha Laptop Renamed')).toHaveCount(0)
  await expect(page.getByText('Build Runner')).toBeVisible()
  await expect(page.getByText('2 projects')).toBeVisible()
  await expect(page.getByText('4 threads')).toBeVisible()

  await page.screenshot({
    path: `${SCREENSHOT_DIR}/settings-connectors-desktop.png`,
    fullPage: true,
  })
})

test('settings page renders expired bootstrap state and recovery action', async ({ page }) => {
  ensureDir(SCREENSHOT_DIR)
  const state = {
    connectors: [
      {
        id: 'expired-edge',
        serverId: 'expired-edge',
        name: 'Expired Edge',
        hubAddress: 'https://hub.example.test',
        relayAgentId: 'agent-expired-edge',
        connected: false,
        installState: 'expired_bootstrap',
        bootstrapIssuedAtIso: '2026-03-07T09:00:00.000Z',
        bootstrapExpiresAtIso: '2026-03-07T09:15:00.000Z',
        createdAtIso: '2026-03-07T09:00:00.000Z',
        updatedAtIso: '2026-03-07T09:20:00.000Z',
      },
    ] as MockConnector[],
    latestToken: '',
  }

  await mockSettingsApi(page, state)

  await page.setViewportSize({ width: 1280, height: 860 })
  await page.goto(`${BASE_URL}/settings`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1200)

  await expect(page.locator('.settings-detail-card').getByText('Expired bootstrap')).toBeVisible()
  await expect(page.getByText('Bootstrap expires')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Reissue install token' })).toBeVisible()

  await page.screenshot({
    path: `${SCREENSHOT_DIR}/settings-connectors-expired-desktop.png`,
    fullPage: true,
  })
})
