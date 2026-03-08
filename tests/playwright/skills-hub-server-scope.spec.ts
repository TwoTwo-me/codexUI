import { expect, test } from '@playwright/test'
import { mkdirSync } from 'node:fs'

const BASE_URL = process.env.PLAYWRIGHT_BASE_URL ?? 'http://127.0.0.1:4310'
const SCREENSHOT_DIR = process.env.PLAYWRIGHT_SCREENSHOT_DIR?.trim() || '.artifacts/screenshots'

function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true })
}

test.beforeEach(async ({ page }) => {
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
          id: 'skills-user',
          username: 'skills-user',
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
            { id: 'server-a', label: 'Server A', description: 'Alpha connector', transport: 'relay' },
            { id: 'server-b', label: 'Server B', description: 'Beta connector', transport: 'relay' },
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
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: [] }) })
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
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ result: { data: [] } }),
      })
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

    if (method === 'skills/list' || method === 'thread/resume') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ result: { data: [] } }) })
      return
    }

    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ result: {} }) })
  })

  await page.route('**/codex-api/skills-hub**', async (route) => {
    const url = new URL(route.request().url())
    const serverId = route.request().headers()['x-codex-server-id'] || url.searchParams.get('serverId') || ''
    if (!serverId) {
      await route.fulfill({
        status: 400,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Missing serverId for scoped skills hub request' }),
      })
      return
    }

    const label = serverId === 'server-b' ? 'Beta Toolkit' : 'Alpha Toolkit'
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        data: [
          {
            name: serverId === 'server-b' ? 'beta-toolkit' : 'alpha-toolkit',
            owner: 'openclaw',
            description: `${label} description`,
            displayName: label,
            publishedAt: 1_735_900_000,
            avatarUrl: '',
            url: `https://skills.example.test/${serverId}`,
            installed: false,
          },
        ],
        installed: [],
        total: 1,
      }),
    })
  })
})

test('skills hub uses the active server scope and refreshes when switching connectors', async ({ page }) => {
  ensureDir(SCREENSHOT_DIR)
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1200)

  await page.getByRole('button', { name: 'Skills Hub' }).click()
  await page.waitForTimeout(800)
  await expect(page.locator('.skill-card-name', { hasText: 'Alpha Toolkit' })).toBeVisible()

  await page.getByRole('button', { name: 'Server B' }).click()
  await page.waitForTimeout(800)
  await expect(page.locator('.skill-card-name', { hasText: 'Beta Toolkit' })).toBeVisible()
  await expect(page.locator('.skill-card-name', { hasText: 'Alpha Toolkit' })).toHaveCount(0)

  await page.screenshot({
    path: `${SCREENSHOT_DIR}/skills-hub-server-scope-desktop.png`,
    fullPage: true,
  })
})
