import { expect, test } from '@playwright/test'

const BASE_URL = process.env.PLAYWRIGHT_BASE_URL ?? 'http://127.0.0.1:4310'

async function mockCommonShell(page: import('@playwright/test').Page): Promise<void> {
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
          id: 'layout-user',
          username: 'layout-user',
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
          defaultServerId: 'server-a',
          servers: [
            { id: 'server-a', label: 'Server A', description: 'Layout VM', transport: 'relay' },
          ],
        },
      }),
    })
  })

  await page.route('**/codex-api/workspace-roots-state**', async (route) => {
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
      body: JSON.stringify({
        data: [
          {
            id: 55,
            method: 'item/commandExecution/requestApproval',
            params: {
              threadId: 'thread-layout',
              turnId: 'turn-layout',
              itemId: 'item-layout',
            },
            receivedAtIso: '2026-03-08T12:30:00.000Z',
          },
        ],
      }),
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
    const requestBody = route.request().postDataJSON()
    const method = requestBody.method

    if (method === 'thread/list') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ result: { data: [] } }) })
      return
    }

    if (method === 'model/list') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ result: { data: [{ id: 'gpt-5-codex', model: 'gpt-5-codex' }] } }),
      })
      return
    }

    if (method === 'config/read') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ result: { config: { model: 'gpt-5-codex', model_reasoning_effort: 'medium' } } }),
      })
      return
    }

    if (method === 'skills/list') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ result: { data: [] } }) })
      return
    }

    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ result: {} }) })
  })

  await page.route('**/codex-api/connectors?*', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        data: {
          connectors: [
            {
              id: 'layout-connector',
              serverId: 'layout-connector',
              name: 'Layout Connector',
              hubAddress: 'https://hub.example.test',
              relayAgentId: 'agent-layout-connector',
              installState: 'connected',
              connected: true,
              projectCount: 2,
              threadCount: 4,
              createdAtIso: '2026-03-07T07:00:00.000Z',
              updatedAtIso: '2026-03-07T07:15:00.000Z',
              lastSeenAtIso: '2026-03-07T07:15:00.000Z',
            },
          ],
        },
      }),
    })
  })
}

test('hooks page heading aligns with settings page shell gutters', async ({ page }) => {
  await mockCommonShell(page)
  await page.setViewportSize({ width: 1440, height: 900 })

  await page.goto(`${BASE_URL}/settings`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1200)
  const settingsBox = await page.locator('.settings-panel-title').boundingBox()
  expect(settingsBox).not.toBeNull()

  await page.goto(`${BASE_URL}/hooks`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1200)
  const hooksBox = await page.locator('.hook-inbox-title').boundingBox()
  expect(hooksBox).not.toBeNull()

  expect(Math.abs((settingsBox?.x ?? 0) - (hooksBox?.x ?? 0))).toBeLessThanOrEqual(8)
  expect(Math.abs((settingsBox?.width ?? 0) - (hooksBox?.width ?? 0))).toBeLessThanOrEqual(480)
})
