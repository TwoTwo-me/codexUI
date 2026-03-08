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
          id: 'hook-alert-user',
          username: 'hook-alert-user',
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
            { id: 'server-a', label: 'Server A', description: 'Primary VM', transport: 'relay' },
          ],
        },
      }),
    })
  })

  await page.route('**/codex-api/workspace-roots-state**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        data: {
          order: ['/srv/project-alpha'],
          labels: { '/srv/project-alpha': 'Project Alpha' },
          active: ['/srv/project-alpha'],
        },
      }),
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
            id: 101,
            method: 'item/commandExecution/requestApproval',
            params: {
              threadId: 'thread-relay',
              turnId: 'turn-relay',
              itemId: 'item-relay',
              command: 'hostname',
              reason: 'Need to inspect the connector hostname',
            },
            receivedAtIso: '2026-03-08T12:00:00.000Z',
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
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          result: {
            data: [
              {
                id: 'thread-relay',
                cwd: '/srv/project-alpha',
                createdAt: 1_735_700_000,
                updatedAt: 1_735_700_100,
                preview: 'Relay approval pending',
              },
            ],
          },
        }),
      })
      return
    }

    if (method === 'thread/read') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          result: {
            thread: {
              id: 'thread-relay',
              cwd: '/srv/project-alpha',
              turns: [
                {
                  id: 'turn-relay',
                  items: [
                    { id: 'user-1', type: 'userMessage', content: [{ type: 'text', text: 'What is the hostname?' }] },
                    { id: 'assistant-1', type: 'agentMessage', text: 'I need approval to run a shell command.' },
                  ],
                },
              ],
            },
          },
        }),
      })
      return
    }

    if (method === 'thread/resume') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ result: {} }) })
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
})

test('home route shows a visible hook alert and thread view shows explicit approval copy', async ({ page }) => {
  ensureDir(SCREENSHOT_DIR)
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1200)

  await expect(page.getByText('1 pending approval requires attention')).toBeVisible()
  await expect(page.getByRole('button', { name: /Review hooks/i })).toBeVisible()

  await page.goto(`${BASE_URL}/thread/thread-relay`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1200)

  await expect(page.getByText('Shell command approval')).toBeVisible()
  await expect(page.getByText('hostname', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Approve', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Reject', exact: true })).toBeVisible()

  await page.screenshot({
    path: `${SCREENSHOT_DIR}/hook-alerts-thread-approval-desktop.png`,
    fullPage: true,
  })
})
