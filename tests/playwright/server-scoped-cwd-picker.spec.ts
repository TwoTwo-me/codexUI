import { expect, test } from '@playwright/test'
import { mkdirSync } from 'node:fs'

const BASE_URL = process.env.PLAYWRIGHT_BASE_URL ?? 'http://127.0.0.1:4310'
const SCREENSHOT_DIR = process.env.PLAYWRIGHT_SCREENSHOT_DIR?.trim() || '.artifacts/screenshots'

function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true })
}

test('new thread folder picker loads folders for the selected server', async ({ page }) => {
  ensureDir(SCREENSHOT_DIR)

  const fsRequests: Array<{ serverId: string; path: string | null }> = []

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
          id: 'cwd-user',
          username: 'cwd-user',
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
            { id: 'server-a', label: 'Server A', description: 'Primary VM', transport: 'local' },
            { id: 'server-b', label: 'Server B', description: 'Fresh connector VM', transport: 'relay', relayAgentId: 'agent-b' },
          ],
        },
      }),
    })
  })

  await page.route('**/codex-api/workspace-roots-state**', async (route) => {
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

    if (method === 'skills/list') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ result: { data: [] } }) })
      return
    }

    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ result: {} }) })
  })

  await page.route('**/codex-api/fs/list**', async (route) => {
    const url = new URL(route.request().url())
    const serverId = route.request().headers()['x-codex-server-id'] || url.searchParams.get('serverId') || 'server-a'
    const path = url.searchParams.get('path')
    fsRequests.push({ serverId, path })

    if (serverId === 'server-b') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          data: {
            currentPath: '/srv/server-b/home',
            homePath: '/srv/server-b/home',
            parentPath: '/srv/server-b',
            entries: [
              { name: 'bravo-folder', path: '/srv/server-b/home/bravo-folder' },
            ],
          },
        }),
      })
      return
    }

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        data: {
          currentPath: '/srv/server-a/home',
          homePath: '/srv/server-a/home',
          parentPath: '/srv/server-a',
          entries: [
            { name: 'alpha-folder', path: '/srv/server-a/home/alpha-folder' },
          ],
        },
      }),
    })
  })

  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1500)

  await page.locator('.cwd-trigger').click()
  await expect(page.getByText('alpha-folder')).toBeVisible()
  await expect(page.getByText('bravo-folder')).toHaveCount(0)
  await page.keyboard.press('Escape')

  await page.locator('select.server-picker-select').selectOption('server-b')
  await page.waitForTimeout(500)

  await page.locator('.cwd-trigger').click()
  await expect(page.getByText('bravo-folder')).toBeVisible()
  await expect(page.getByText('alpha-folder')).toHaveCount(0)

  expect(fsRequests.some((entry) => entry.serverId === 'server-a')).toBeTruthy()
  expect(fsRequests.some((entry) => entry.serverId === 'server-b')).toBeTruthy()
  expect(fsRequests.at(-1)?.path ?? '').toBe('')

  await page.screenshot({
    path: `${SCREENSHOT_DIR}/server-scoped-cwd-picker-desktop.png`,
    fullPage: true,
  })
})
