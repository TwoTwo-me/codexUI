import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp } from 'node:fs/promises'
import { accessSync, constants as fsConstants } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(__dirname, '..', '..')
const distCliPath = join(repoRoot, 'dist-cli', 'index.js')

accessSync(distCliPath, fsConstants.F_OK)

function createBaseEnv(overrides = {}) {
  const env = {
    ...process.env,
    CODEXUI_SKIP_CODEX_LOGIN: 'true',
    CODEXUI_OPEN_BROWSER: 'false',
  }

  delete env.CODEXUI_ADMIN_PASSWORD
  delete env.CODEXUI_ADMIN_PASSWORD_HASH
  delete env.CODEXUI_ADMIN_PASSWORD_FILE
  delete env.CODEXUI_ADMIN_PASSWORD_HASH_FILE

  return {
    ...env,
    ...overrides,
  }
}

async function getAvailablePort() {
  const server = createServer((_req, res) => {
    res.statusCode = 204
    res.end()
  })

  await new Promise((resolvePromise, reject) => {
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
    throw new Error('Failed to reserve a free port')
  }

  await new Promise((resolvePromise, reject) => {
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

async function runCommand(args, { env, input, cwd = repoRoot } = {}) {
  const child = spawn('node', args, {
    cwd,
    env: createBaseEnv(env),
    stdio: ['pipe', 'pipe', 'pipe'],
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

  if (input !== undefined) {
    child.stdin.end(input)
  } else {
    child.stdin.end()
  }

  const exitCode = await new Promise((resolvePromise, reject) => {
    child.once('error', reject)
    child.once('close', resolvePromise)
  })

  return { exitCode, stdout, stderr }
}

async function generatePasswordHash(password) {
  const result = await runCommand(['dist-cli/index.js', 'hash-password', '--password-stdin'], {
    input: password,
  })
  assert.equal(result.exitCode, 0, result.stderr || result.stdout)
  return result.stdout.trim()
}

async function waitForServerReady(baseUrl, child, outputRef) {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`codexui exited early (${String(child.exitCode)}):\n${outputRef.stdout}\n${outputRef.stderr}`)
    }

    try {
      const response = await fetch(`${baseUrl}/auth/session`)
      if (response.ok) {
        return
      }
    } catch {}

    await new Promise((resolvePromise) => setTimeout(resolvePromise, 200))
  }

  throw new Error(`Timed out waiting for ${baseUrl}\n${outputRef.stdout}\n${outputRef.stderr}`)
}

async function startServer({ passwordHash, codeHome, username = 'bootstrap-admin' }) {
  const port = await getAvailablePort()
  const resolvedCodeHome = codeHome ?? await mkdtemp(join(tmpdir(), 'codexui-bootstrap-gate-'))
  const child = spawn('node', ['dist-cli/index.js', '--host', '127.0.0.1', '--port', String(port), '--username', username, '--password-hash', passwordHash], {
    cwd: repoRoot,
    env: createBaseEnv({
      CODEX_HOME: resolvedCodeHome,
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  const outputRef = { stdout: '', stderr: '' }
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    outputRef.stdout += chunk
  })
  child.stderr.on('data', (chunk) => {
    outputRef.stderr += chunk
  })

  const baseUrl = `http://127.0.0.1:${String(port)}`
  await waitForServerReady(baseUrl, child, outputRef)

  return {
    baseUrl,
    codeHome: resolvedCodeHome,
    async stop() {
      if (child.exitCode !== null) return
      child.kill('SIGTERM')
      await new Promise((resolvePromise) => child.once('close', resolvePromise))
    },
  }
}

async function postJson(url, payload, headers = {}) {
  return fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...headers,
    },
    body: JSON.stringify(payload),
  })
}

test('bootstrap admin session is setup-required and blocks codex-api access before rotation', async () => {
  const plaintextPassword = 'bootstrap-secret-pass-1'
  const passwordHash = await generatePasswordHash(plaintextPassword)
  const server = await startServer({ passwordHash, username: 'admin' })

  try {
    const loginResponse = await postJson(`${server.baseUrl}/auth/login`, {
      username: 'admin',
      password: plaintextPassword,
    })
    assert.equal(loginResponse.status, 200)
    const loginBody = await loginResponse.json()
    assert.equal(loginBody.setupRequired, true)
    assert.equal(loginBody.user.username, 'admin')

    const cookie = loginResponse.headers.get('set-cookie')
    assert.ok(cookie)

    const sessionResponse = await fetch(`${server.baseUrl}/auth/session`, {
      headers: {
        Accept: 'application/json',
        Cookie: cookie,
      },
    })
    assert.equal(sessionResponse.status, 200)
    const sessionBody = await sessionResponse.json()
    assert.equal(sessionBody.authenticated, true)
    assert.equal(sessionBody.setupRequired, true)

    const blockedApiResponse = await fetch(`${server.baseUrl}/codex-api/servers`, {
      headers: {
        Accept: 'application/json',
        Cookie: cookie,
      },
    })
    assert.equal(blockedApiResponse.status, 403)
    const blockedApiBody = await blockedApiResponse.json()
    assert.match(blockedApiBody.error, /setup required/i)
  } finally {
    await server.stop()
  }
})
