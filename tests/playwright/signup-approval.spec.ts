import { expect, test } from '@playwright/test'
import { mkdirSync, rmSync, mkdtempSync } from 'node:fs'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCREENSHOT_DIR = process.env.PLAYWRIGHT_SCREENSHOT_DIR?.trim() || '.artifacts/screenshots'
const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(__dirname, '..', '..')

type RunningServer = {
  baseUrl: string
  codeHome: string
  child: ChildProcessWithoutNullStreams
  readOutput: () => string
}

function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true })
}

async function getAvailablePort(): Promise<number> {
  const server = createServer((_req, res) => {
    res.statusCode = 204
    res.end()
  })

  await new Promise<void>((resolvePromise, reject) => {
    server.listen(0, '127.0.0.1', (error) => {
      if (error) {
        reject(error)
        return
      }
      resolvePromise()
    })
  })

  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Failed to allocate port')
  }

  await new Promise<void>((resolvePromise, reject) => {
    server.close((error) => {
      if (error) {
        reject(error)
        return
      }
      resolvePromise()
    })
  })

  return address.port
}

async function startServer(): Promise<RunningServer> {
  const port = await getAvailablePort()
  const codeHome = mkdtempSync(join(tmpdir(), 'codexui-signup-approval-'))
  const child = spawn('node', ['dist-cli/index.js', '--host', '127.0.0.1', '--port', String(port), '--username', 'admin', '--password', 'admin-pass-1'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      CODEX_HOME: codeHome,
      CODEXUI_SKIP_CODEX_LOGIN: 'true',
      CODEXUI_OPEN_BROWSER: 'false',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    stdout += chunk
  })
  child.stderr.on('data', (chunk) => {
    stderr += chunk
  })

  const baseUrl = `http://127.0.0.1:${String(port)}`
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Server exited early (${String(child.exitCode)}):\n${stdout}\n${stderr}`)
    }
    try {
      const response = await fetch(`${baseUrl}/auth/session`)
      if (response.ok) {
        return {
          baseUrl,
          codeHome,
          child,
          readOutput: () => `${stdout}\n${stderr}`,
        }
      }
    } catch {}
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 200))
  }

  throw new Error(`Timed out waiting for server\n${stdout}\n${stderr}`)
}

async function stopServer(server: RunningServer): Promise<void> {
  if (server.child.exitCode === null) {
    server.child.kill('SIGTERM')
    await new Promise<void>((resolvePromise) => server.child.once('close', () => resolvePromise()))
  }
  rmSync(server.codeHome, { recursive: true, force: true })
}

test.describe('signup approval flow', () => {
  test.setTimeout(120_000)

  let server: RunningServer

  test.beforeAll(async () => {
    server = await startServer()
  })

  test.afterAll(async () => {
    await stopServer(server)
  })

  test('public signup waits for admin approval before login succeeds', async ({ page }) => {
    ensureDir(SCREENSHOT_DIR)
    await page.setViewportSize({ width: 1440, height: 960 })

    await page.goto(server.baseUrl, { waitUntil: 'domcontentloaded' })
    await expect(page.getByRole('heading', { name: 'Codex Web Local' })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Request access' })).toBeVisible()

    await page.getByLabel('Create username').fill('pending-user')
    await page.getByLabel('Create password').fill('pending-pass-1')
    await page.getByRole('button', { name: 'Request access' }).click()
    await expect(page.getByText('Your access request is pending admin approval.')).toBeVisible()

    await page.locator('#username').fill('admin')
    await page.locator('#pw').fill('admin-pass-1')
    await page.locator('#login-form').getByRole('button', { name: 'Sign in' }).click()
    await expect(page.getByText('admin (admin)')).toBeVisible({ timeout: 20_000 })

    await page.goto(`${server.baseUrl}/admin`, { waitUntil: 'domcontentloaded' })
    await expect(page.getByRole('heading', { name: 'User Management' })).toBeVisible()
    await expect(page.getByRole('cell', { name: 'pending-user', exact: true })).toBeVisible()
    await page.getByRole('row', { name: /pending-user/i }).getByRole('button', { name: 'Approve' }).click()
    await expect(page.getByText('Approved')).toBeVisible()
    await page.screenshot({
      path: `${SCREENSHOT_DIR}/signup-approval-admin-desktop.png`,
      fullPage: true,
    })

    await page.getByRole('button', { name: 'Sign out' }).click()
    await expect(page.locator('#login-form').getByRole('button', { name: 'Sign in' })).toBeVisible()

    await page.locator('#username').fill('pending-user')
    await page.locator('#pw').fill('pending-pass-1')
    await page.locator('#login-form').getByRole('button', { name: 'Sign in' }).click()
    await expect(page.getByText('pending-user (user)')).toBeVisible({ timeout: 20_000 })
    await page.screenshot({
      path: `${SCREENSHOT_DIR}/signup-approval-user-desktop.png`,
      fullPage: true,
    })
  })
})
