import { expect, test } from '@playwright/test'
import { mkdirSync } from 'node:fs'

const BASE_URL = process.env.PLAYWRIGHT_BASE_URL ?? 'http://127.0.0.1:4310'
const SCREENSHOT_DIR = process.env.PLAYWRIGHT_SCREENSHOT_DIR?.trim() || '.artifacts/screenshots'

function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true })
}

test('settings page manages connectors end-to-end', async ({ page }) => {
  ensureDir(SCREENSHOT_DIR)
  let connectors = [
    {
      id: 'build-runner',
      serverId: 'build-runner',
      name: 'Build Runner',
      hubAddress: 'https://hub.example.test',
      relayAgentId: 'agent-build-runner',
      connected: true,
      projectCount: 2,
      threadCount: 4,
      statsStale: false,
      createdAtIso: '2026-03-06T07:00:00.000Z',
      updatedAtIso: '2026-03-06T07:15:00.000Z',
      lastSeenAtIso: '2026-03-06T07:15:00.000Z',
    },
  ]
  let latestToken = ''

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
      body: JSON.stringify({ data: { connectors } }),
    })
  })

  await page.route('**/codex-api/connectors', async (route) => {
    if (route.request().method().toUpperCase() === 'POST') {
      const payload = route.request().postDataJSON()
      latestToken = `token-${String(Date.now())}`
      const created = {
        id: payload.id,
        serverId: payload.id,
        name: payload.name,
        hubAddress: payload.hubAddress,
        relayAgentId: `agent-${payload.id}`,
        connected: false,
        projectCount: undefined,
        threadCount: undefined,
        statsStale: false,
        createdAtIso: '2026-03-06T08:00:00.000Z',
        updatedAtIso: '2026-03-06T08:00:00.000Z',
      }
      connectors = [created, ...connectors]
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({
          data: {
            connector: created,
            token: latestToken,
          },
        }),
      })
      return
    }

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: { connectors } }),
    })
  })

  await page.route('**/codex-api/connectors/*/rotate-token', async (route) => {
    latestToken = `rotated-${String(Date.now())}`
    const connectorId = route.request().url().split('/codex-api/connectors/')[1].split('/')[0]
    const connector = connectors.find((entry) => entry.id === connectorId)
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        data: {
          connector,
          token: latestToken,
        },
      }),
    })
  })

  await page.route('**/codex-api/connectors/*', async (route) => {
    const requestUrl = route.request().url()
    const connectorId = requestUrl.split('/codex-api/connectors/')[1]
    if (route.request().method().toUpperCase() === 'PATCH') {
      const payload = route.request().postDataJSON()
      connectors = connectors.map((connector) =>
        connector.id === connectorId
          ? {
              ...connector,
              name: payload.name,
              updatedAtIso: '2026-03-06T08:10:00.000Z',
            }
          : connector,
      )
      const connector = connectors.find((entry) => entry.id === connectorId)
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ data: { connector } }),
      })
      return
    }

    if (route.request().method().toUpperCase() === 'DELETE') {
      connectors = connectors.filter((connector) => connector.id !== connectorId)
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, data: { connectors } }),
      })
      return
    }

    await route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'Not found' }) })
  })

  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(`${BASE_URL}/settings`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1200)

  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible()
  await expect(page.getByText('Build Runner')).toBeVisible()
  await expect(page.getByText('2 projects')).toBeVisible()
  await expect(page.getByText('4 threads')).toBeVisible()

  await page.getByLabel('Connector name').fill('Alpha Laptop')
  await page.getByLabel('Connector id').fill('alpha-laptop')
  await page.getByLabel('Hub address').fill('https://hub.example.test')
  await page.getByRole('button', { name: 'Create connector' }).click()

  await expect(page.getByText('Installation token is only shown once.')).toBeVisible()
  await expect(page.getByText('alpha-laptop')).toBeVisible()
  await expect(page.locator('input[value="Alpha Laptop"]').first()).toBeVisible()

  await page.getByRole('button', { name: 'Edit name' }).click()
  await page.getByLabel('Rename connector').fill('Alpha Laptop Renamed')
  await page.getByRole('button', { name: 'Save name' }).click()
  await expect(page.getByText('Alpha Laptop Renamed')).toBeVisible()

  await page.getByRole('button', { name: 'Rotate token' }).click()
  await expect(page.getByText('rotated-')).toBeVisible()

  await page.getByRole('button', { name: 'Delete connector' }).click()
  await page.getByRole('button', { name: 'Confirm delete' }).click()
  await expect(page.getByText('Alpha Laptop Renamed')).toHaveCount(0)

  await page.screenshot({
    path: `${SCREENSHOT_DIR}/settings-connectors-desktop.png`,
    fullPage: true,
  })
})
