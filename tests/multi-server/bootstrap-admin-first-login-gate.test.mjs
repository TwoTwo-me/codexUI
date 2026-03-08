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

test('bootstrap admin can complete setup, unlock codex-api access, and preserve rotated credentials across restart', async () => {
  const bootstrapPassword = 'bootstrap-secret-pass-2'
  const passwordHash = await generatePasswordHash(bootstrapPassword)
  const codeHome = await mkdtemp(join(tmpdir(), 'codexui-bootstrap-complete-'))
  const server = await startServer({ passwordHash, codeHome, username: 'admin' })

  try {
    const loginResponse = await postJson(`${server.baseUrl}/auth/login`, {
      username: 'admin',
      password: bootstrapPassword,
    })
    assert.equal(loginResponse.status, 200)
    const cookie = loginResponse.headers.get('set-cookie')
    assert.ok(cookie)

    const completeResponse = await postJson(
      `${server.baseUrl}/auth/bootstrap/complete`,
      {
        currentPassword: bootstrapPassword,
        newUsername: 'primary-admin',
        newPassword: 'rotated-secret-pass-2',
      },
      { Cookie: cookie },
    )
    assert.equal(completeResponse.status, 200)
    const completeBody = await completeResponse.json()
    assert.equal(completeBody.setupRequired, false)
    assert.equal(completeBody.user.username, 'primary-admin')

    const unlockedApiResponse = await fetch(`${server.baseUrl}/codex-api/servers`, {
      headers: {
        Accept: 'application/json',
        Cookie: cookie,
      },
    })
    assert.equal(unlockedApiResponse.status, 200)

    const staleLoginResponse = await postJson(`${server.baseUrl}/auth/login`, {
      username: 'admin',
      password: bootstrapPassword,
    })
    assert.equal(staleLoginResponse.status, 401)
  } finally {
    await server.stop()
  }

  const restartedServer = await startServer({ passwordHash, codeHome, username: 'admin' })
  try {
    const staleLoginResponse = await postJson(`${restartedServer.baseUrl}/auth/login`, {
      username: 'admin',
      password: bootstrapPassword,
    })
    assert.equal(staleLoginResponse.status, 401)

    const rotatedLoginResponse = await postJson(`${restartedServer.baseUrl}/auth/login`, {
      username: 'primary-admin',
      password: 'rotated-secret-pass-2',
    })
    assert.equal(rotatedLoginResponse.status, 200)
    const rotatedLoginBody = await rotatedLoginResponse.json()
    assert.equal(rotatedLoginBody.setupRequired, false)
    assert.equal(rotatedLoginBody.user.username, 'primary-admin')
  } finally {
    await restartedServer.stop()
  }
})

test('bootstrap admin browser navigation redirects to setup route until setup completes', async () => {
  const plaintextPassword = 'bootstrap-secret-pass-3'
  const passwordHash = await generatePasswordHash(plaintextPassword)
  const server = await startServer({ passwordHash, username: 'admin' })

  try {
    const loginResponse = await postJson(`${server.baseUrl}/auth/login`, {
      username: 'admin',
      password: plaintextPassword,
    })
    assert.equal(loginResponse.status, 200)
    const cookie = loginResponse.headers.get('set-cookie')
    assert.ok(cookie)

    const redirectedResponse = await fetch(`${server.baseUrl}/`, {
      headers: {
        Accept: 'text/html',
        Cookie: cookie,
      },
      redirect: 'manual',
    })
    assert.equal(redirectedResponse.status, 302)
    assert.equal(redirectedResponse.headers.get('location'), '/setup/bootstrap-admin')

    const setupRouteResponse = await fetch(`${server.baseUrl}/setup/bootstrap-admin`, {
      headers: {
        Accept: 'text/html',
        Cookie: cookie,
      },
    })
    assert.equal(setupRouteResponse.status, 200)
  } finally {
    await server.stop()
  }
})

test('setup-required bootstrap admin is redirected to setup route for HTML navigation', async () => {
  const bootstrapPassword = 'bootstrap-secret-pass-3'
  const passwordHash = await generatePasswordHash(bootstrapPassword)
  const server = await startServer({ passwordHash, username: 'admin' })

  try {
    const loginResponse = await postJson(`${server.baseUrl}/auth/login`, {
      username: 'admin',
      password: bootstrapPassword,
    })
    assert.equal(loginResponse.status, 200)
    const cookie = loginResponse.headers.get('set-cookie')
    assert.ok(cookie)

    const redirectedHome = await fetch(`${server.baseUrl}/`, {
      headers: {
        Accept: 'text/html',
        Cookie: cookie,
      },
      redirect: 'manual',
    })
    assert.equal(redirectedHome.status, 302)
    assert.equal(redirectedHome.headers.get('location'), '/setup/bootstrap-admin')

    const redirectedSettings = await fetch(`${server.baseUrl}/settings`, {
      headers: {
        Accept: 'text/html',
        Cookie: cookie,
      },
      redirect: 'manual',
    })
    assert.equal(redirectedSettings.status, 302)
    assert.equal(redirectedSettings.headers.get('location'), '/setup/bootstrap-admin')

    const setupRouteResponse = await fetch(`${server.baseUrl}/setup/bootstrap-admin`, {
      headers: {
        Accept: 'text/html',
        Cookie: cookie,
      },
      redirect: 'manual',
    })
    assert.equal(setupRouteResponse.status, 200)
  } finally {
    await server.stop()
  }
})

async function startServerWithoutBootstrap({ codeHome } = {}) {
  const port = await getAvailablePort()
  const resolvedCodeHome = codeHome ?? await mkdtemp(join(tmpdir(), 'codexui-bootstrapless-'))
  const child = spawn('node', ['dist-cli/index.js', '--host', '127.0.0.1', '--port', String(port), '--no-password'], {
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

test('rotated admin can log back in after restart with no bootstrap env or hash configured', async () => {
  const bootstrapPassword = 'bootstrap-secret-pass-4'
  const passwordHash = await generatePasswordHash(bootstrapPassword)
  const codeHome = await mkdtemp(join(tmpdir(), 'codexui-bootstrapless-restart-'))
  const bootstrapServer = await startServer({ passwordHash, codeHome, username: 'admin' })

  try {
    const loginResponse = await postJson(`${bootstrapServer.baseUrl}/auth/login`, {
      username: 'admin',
      password: bootstrapPassword,
    })
    assert.equal(loginResponse.status, 200)
    const cookie = loginResponse.headers.get('set-cookie')
    assert.ok(cookie)

    const completeResponse = await postJson(
      `${bootstrapServer.baseUrl}/auth/bootstrap/complete`,
      {
        currentPassword: bootstrapPassword,
        newUsername: 'steady-admin',
        newPassword: 'steady-secret-pass-4',
      },
      { Cookie: cookie },
    )
    assert.equal(completeResponse.status, 200)
  } finally {
    await bootstrapServer.stop()
  }

  const steadyStateServer = await startServerWithoutBootstrap({ codeHome })
  try {
    const loginResponse = await postJson(`${steadyStateServer.baseUrl}/auth/login`, {
      username: 'steady-admin',
      password: 'steady-secret-pass-4',
    })
    assert.equal(loginResponse.status, 200)
    const body = await loginResponse.json()
    assert.equal(body.setupRequired, false)

    const staleBootstrapLogin = await postJson(`${steadyStateServer.baseUrl}/auth/login`, {
      username: 'admin',
      password: bootstrapPassword,
    })
    assert.equal(staleBootstrapLogin.status, 401)

    const anonymousApi = await fetch(`${steadyStateServer.baseUrl}/codex-api/servers`, {
      headers: { Accept: 'application/json' },
    })
    assert.equal(anonymousApi.status, 401)
  } finally {
    await steadyStateServer.stop()
  }
})
