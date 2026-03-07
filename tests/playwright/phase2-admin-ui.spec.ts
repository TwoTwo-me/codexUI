import { test, expect } from '@playwright/test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const BASE_URL = process.env.PLAYWRIGHT_BASE_URL ?? ''
const USERNAME = process.env.PLAYWRIGHT_USERNAME ?? 'admin'
const PASSWORD = process.env.PLAYWRIGHT_PASSWORD ?? ''
const SCREENSHOT_DIR = process.env.PLAYWRIGHT_SCREENSHOT_DIR?.trim() || '.artifacts/screenshots'
const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(__dirname, '..', '..')

type RunningServer = {
  baseUrl: string
  username: string
  password: string
  codeHome: string
  child: ChildProcessWithoutNullStreams
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

async function startFallbackHub(): Promise<RunningServer> {
  const port = await getAvailablePort()
  const codeHome = mkdtempSync(join(tmpdir(), 'codexui-admin-playwright-'))
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
  child.stdout.on('data', (chunk) => { stdout += chunk })
  child.stderr.on('data', (chunk) => { stderr += chunk })

  const baseUrl = `http://127.0.0.1:${String(port)}`
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Fallback hub exited early (${String(child.exitCode)}):\n${stdout}\n${stderr}`)
    }
    try {
      const response = await fetch(`${baseUrl}/auth/session`)
      if (response.ok) {
        return {
          baseUrl,
          username: 'admin',
          password: 'admin-pass-1',
          codeHome,
          child,
        }
      }
    } catch {}
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 200))
  }

  throw new Error(`Timed out waiting for fallback hub\n${stdout}\n${stderr}`)
}

async function stopFallbackHub(server: RunningServer | null): Promise<void> {
  if (!server) return
  if (server.child.exitCode === null) {
    server.child.kill('SIGTERM')
    await new Promise<void>((resolvePromise) => server.child.once('close', () => resolvePromise()))
  }
  rmSync(server.codeHome, { recursive: true, force: true })
}

async function login(page: import('@playwright/test').Page, baseUrl: string, username: string, password: string): Promise<void> {
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' })
  await expect(page.getByLabel('Password', { exact: true })).toBeVisible()
  await page.getByLabel('Username', { exact: true }).fill(username)
  await page.getByLabel('Password', { exact: true }).fill(password)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByText(`${username} (admin)`)).toBeVisible({ timeout: 20_000 })
  await page.waitForTimeout(1200)
}

test.setTimeout(90_000)

test.describe('admin panel screenshots', () => {
  let fallbackHub: RunningServer | null = null
  const runtime = {
    baseUrl: BASE_URL,
    username: USERNAME,
    password: PASSWORD,
  }

  test.beforeAll(async () => {
    if (!runtime.baseUrl || !runtime.password) {
      fallbackHub = await startFallbackHub()
      runtime.baseUrl = fallbackHub.baseUrl
      runtime.username = fallbackHub.username
      runtime.password = fallbackHub.password
    }
  })

  test.afterAll(async () => {
    await stopFallbackHub(fallbackHub)
  })

  test('captures desktop admin panel screenshot', async ({ page }) => {
    ensureDir(SCREENSHOT_DIR)
    await page.setViewportSize({ width: 1440, height: 900 })
    await login(page, runtime.baseUrl, runtime.username, runtime.password)

    await page.goto(`${runtime.baseUrl}/admin`, { waitUntil: 'domcontentloaded' })
    await expect(page.getByRole('heading', { name: 'User Management' })).toBeVisible()
    await page.waitForTimeout(1200)

    await page.screenshot({
      path: `${SCREENSHOT_DIR}/phase2-admin-desktop.png`,
      fullPage: true,
    })
  })

  test('captures mobile admin panel screenshot', async ({ page }) => {
    ensureDir(SCREENSHOT_DIR)
    await page.setViewportSize({ width: 375, height: 812 })
    await login(page, runtime.baseUrl, runtime.username, runtime.password)

    await page.goto(`${runtime.baseUrl}/admin`, { waitUntil: 'domcontentloaded' })
    await expect(page.getByRole('heading', { name: 'User Management' })).toBeVisible()
    await page.waitForTimeout(1200)

    await page.screenshot({
      path: `${SCREENSHOT_DIR}/phase2-admin-mobile.png`,
      fullPage: true,
    })
  })
})
