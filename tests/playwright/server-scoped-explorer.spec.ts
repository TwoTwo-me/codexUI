import { expect, test } from '@playwright/test'
import { mkdirSync } from 'node:fs'

const BASE_URL = process.env.PLAYWRIGHT_BASE_URL ?? 'http://127.0.0.1:4310'
const SCREENSHOT_DIR = process.env.PLAYWRIGHT_SCREENSHOT_DIR?.trim() || '.artifacts/screenshots'

function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true })
}

const serverState = {
  activeServerId: 'server-a',
  workspaceRootsByServer: {
    'server-a': {
      order: ['/srv/server-a/project-alpha'],
      labels: { '/srv/server-a/project-alpha': 'Project Alpha' },
      active: ['/srv/server-a/project-alpha'],
    },
    'server-b': {
      order: ['/srv/server-b/project-bravo'],
      labels: { '/srv/server-b/project-bravo': 'Project Bravo' },
      active: ['/srv/server-b/project-bravo'],
    },
  } as Record<string, { order: string[]; labels: Record<string, string>; active: string[] }>,
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
          id: 'explorer-user',
          username: 'explorer-user',
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
            { id: 'server-b', label: 'Server B', description: 'Fresh VM', transport: 'local' },
          ],
        },
      }),
    })
  })

  await page.route('**/codex-api/workspace-roots-state**', async (route) => {
    const url = new URL(route.request().url())
    const serverId = route.request().headers()['x-codex-server-id'] || url.searchParams.get('serverId') || serverState.activeServerId
    if (route.request().method().toUpperCase() === 'PUT') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) })
      return
    }

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: serverState.workspaceRootsByServer[serverId] ?? { order: [], labels: {}, active: [] } }),
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
    const serverId = route.request().headers()['x-codex-server-id'] || 'server-a'

    if (method === 'thread/list') {
      const data = serverId === 'server-b'
        ? [
            {
              id: 'thread-bravo',
              cwd: '/srv/server-b/project-bravo',
              createdAt: 1_735_700_000,
              updatedAt: 1_735_700_100,
              preview: 'Bravo overview',
            },
          ]
        : [
            {
              id: 'thread-alpha',
              cwd: '/srv/server-a/project-alpha',
              createdAt: 1_735_600_000,
              updatedAt: 1_735_600_100,
              preview: 'Alpha overview',
            },
          ]

      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ result: { data } }),
      })
      return
    }

    if (method === 'thread/read') {
      const threadId = serverId === 'server-b' ? 'thread-bravo' : 'thread-alpha'
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          result: {
            thread: {
              id: threadId,
              cwd: serverId === 'server-b' ? '/srv/server-b/project-bravo' : '/srv/server-a/project-alpha',
              turns: [
                {
                  id: `${threadId}-turn-1`,
                  items: [
                    { id: `${threadId}-user`, type: 'userMessage', content: [{ type: 'text', text: 'hello' }] },
                    { id: `${threadId}-assistant`, type: 'agentMessage', text: 'response' },
                  ],
                },
              ],
            },
          },
        }),
      })
      return
    }

    if (method === 'thread/resume' || method === 'model/list' || method === 'config/read' || method === 'skills/list') {
      const result = method === 'model/list'
        ? { data: [{ id: 'gpt-5-codex', model: 'gpt-5-codex' }] }
        : method === 'config/read'
          ? { config: { model: 'gpt-5-codex', model_reasoning_effort: 'medium' } }
          : method === 'skills/list'
            ? { data: [] }
            : {}
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ result }) })
      return
    }

    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ result: {} }) })
  })
})

test('switching servers only shows workspace folders for the active server', async ({ page }) => {
  ensureDir(SCREENSHOT_DIR)
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1500)

  await expect(page.getByText('Project Alpha')).toBeVisible()
  await expect(page.getByText('Project Bravo')).toHaveCount(0)

  await page.getByRole('button', { name: 'Server B' }).click()
  await page.waitForTimeout(1000)

  await expect(page.getByText('Project Bravo')).toBeVisible()
  await expect(page.getByText('Project Alpha')).toHaveCount(0)

  await page.screenshot({
    path: `${SCREENSHOT_DIR}/server-scoped-explorer-desktop.png`,
    fullPage: true,
  })
})
