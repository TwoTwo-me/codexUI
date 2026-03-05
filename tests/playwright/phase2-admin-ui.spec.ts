import { test, expect } from '@playwright/test'
import { mkdirSync } from 'node:fs'

const BASE_URL = process.env.PLAYWRIGHT_BASE_URL ?? 'http://127.0.0.1:4300'
const USERNAME = process.env.PLAYWRIGHT_USERNAME ?? 'admin'
const PASSWORD = process.env.PLAYWRIGHT_PASSWORD ?? ''
const SCREENSHOT_DIR = process.env.PLAYWRIGHT_SCREENSHOT_DIR?.trim() || '.artifacts/screenshots'

function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true })
}

async function login(page: import('@playwright/test').Page): Promise<void> {
  if (!PASSWORD) {
    throw new Error('PLAYWRIGHT_PASSWORD environment variable is required')
  }

  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' })
  await expect(page.getByLabel('Password')).toBeVisible()
  await page.getByLabel('Username').fill(USERNAME)
  await page.getByLabel('Password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByText("Let's build")).toBeVisible({ timeout: 20_000 })
  await page.waitForTimeout(2500)
}

test.setTimeout(90_000)

test('captures desktop admin panel screenshot', async ({ page }) => {
  ensureDir(SCREENSHOT_DIR)
  await page.setViewportSize({ width: 1440, height: 900 })
  await login(page)

  await page.goto(`${BASE_URL}/admin`, { waitUntil: 'domcontentloaded' })
  await expect(page.getByRole('heading', { name: 'User Management' })).toBeVisible()
  await page.waitForTimeout(2500)

  await page.screenshot({
    path: `${SCREENSHOT_DIR}/phase2-admin-desktop.png`,
    fullPage: true,
  })
})

test('captures mobile admin panel screenshot', async ({ page }) => {
  ensureDir(SCREENSHOT_DIR)
  await page.setViewportSize({ width: 375, height: 812 })
  await login(page)

  await page.goto(`${BASE_URL}/admin`, { waitUntil: 'domcontentloaded' })
  await expect(page.getByRole('heading', { name: 'User Management' })).toBeVisible()
  await page.waitForTimeout(2500)

  await page.screenshot({
    path: `${SCREENSHOT_DIR}/phase2-admin-mobile.png`,
    fullPage: true,
  })
})
