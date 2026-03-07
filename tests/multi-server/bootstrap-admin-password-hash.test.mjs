import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { accessSync, constants as fsConstants } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(__dirname, '..', '..')
const distCliPath = join(repoRoot, 'dist-cli', 'index.js')
const entrypointPath = join(repoRoot, 'docker', 'hub', 'entrypoint.sh')
const sqliteFilePath = (codeHome) => join(codeHome, 'codexui', 'hub.sqlite')

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

async function runProcess(command, args, { env, input, cwd = repoRoot } = {}) {
  const child = spawn(command, args, {
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

async function runCommand(args, options) {
  return runProcess('node', args, options)
}

async function generatePasswordHash(password, options = {}) {
  const result = await runCommand(['dist-cli/index.js', 'hash-password', '--password-stdin', ...(options.envOutput ? ['--env'] : [])], {
    env: options.env,
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

async function startServer({ args = [], env = {}, codeHome: explicitCodeHome } = {}) {
  const port = await getAvailablePort()
  const codeHome = explicitCodeHome ?? await mkdtemp(join(tmpdir(), 'codexui-password-hash-'))
  const child = spawn('node', ['dist-cli/index.js', '--host', '127.0.0.1', '--port', String(port), '--username', 'hash-admin', ...args], {
    cwd: repoRoot,
    env: createBaseEnv({
      CODEX_HOME: codeHome,
      ...env,
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
    codeHome,
    outputRef,
    async stop() {
      if (child.exitCode !== null) {
        return
      }
      child.kill('SIGTERM')
      await new Promise((resolvePromise) => {
        child.once('close', () => resolvePromise())
      })
    },
  }
}

async function postJson(url, payload) {
  return fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(payload),
  })
}

function querySqliteRows(databasePath, sql, params = []) {
  const database = new Database(databasePath, { readonly: true })
  try {
    return database.prepare(sql).all(...params)
  } finally {
    database.close()
  }
}

test('hash-password CLI emits a bootstrap admin password hash and env assignment', async () => {
  const rawHash = await generatePasswordHash('cli-secret-pass-1')
  assert.match(rawHash, /^scrypt\$/u)
  assert.notEqual(rawHash, 'cli-secret-pass-1')

  const envLine = await generatePasswordHash('cli-secret-pass-1', { envOutput: true })
  assert.match(envLine, /^CODEXUI_ADMIN_PASSWORD_HASH=scrypt\$\$/u)
  assert.match(envLine, /\$\$/u)
  assert.notEqual(envLine, `CODEXUI_ADMIN_PASSWORD_HASH=cli-secret-pass-1`)
})

test('server authenticates bootstrap admin login with --password-hash and stores the precomputed hash in sqlite', async () => {
  const plaintextPassword = 'hash-secret-pass-1'
  const passwordHash = await generatePasswordHash(plaintextPassword)
  const server = await startServer({
    args: ['--password-hash', passwordHash],
  })

  try {
    const loginResponse = await postJson(`${server.baseUrl}/auth/login`, {
      username: 'hash-admin',
      password: plaintextPassword,
    })
    assert.equal(loginResponse.status, 200)
    assert.ok(loginResponse.headers.get('set-cookie'))

    const compatibilityResponse = await postJson(`${server.baseUrl}/auth/login`, {
      password: plaintextPassword,
    })
    assert.equal(compatibilityResponse.status, 200)

    const wrongPasswordResponse = await postJson(`${server.baseUrl}/auth/login`, {
      username: 'hash-admin',
      password: 'wrong-secret-pass-1',
    })
    assert.equal(wrongPasswordResponse.status, 401)

    assert.match(server.outputRef.stdout, /configured via precomputed hash/i)
    assert.doesNotMatch(server.outputRef.stdout, new RegExp(plaintextPassword.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'))

    const userRows = querySqliteRows(
      sqliteFilePath(server.codeHome),
      'select username, password_hash as passwordHash, approval_status as approvalStatus from users order by username',
    )
    assert.equal(userRows.length, 1)
    assert.equal(userRows[0].username, 'hash-admin')
    assert.equal(userRows[0].passwordHash, passwordHash)
    assert.equal(userRows[0].approvalStatus, 'approved')
    await assert.rejects(readFile(join(server.codeHome, 'codexui', 'users.json'), 'utf8'))
  } finally {
    await server.stop()
  }
})

test('server persists registered servers across restart using sqlite-backed hub state', async () => {
  const plaintextPassword = 'sqlite-state-pass-1'
  const passwordHash = await generatePasswordHash(plaintextPassword)
  const codeHome = await mkdtemp(join(tmpdir(), 'codexui-sqlite-state-'))

  const firstServer = await startServer({
    args: ['--password-hash', passwordHash],
    codeHome,
  })

  try {
    const loginResponse = await postJson(`${firstServer.baseUrl}/auth/login`, {
      username: 'hash-admin',
      password: plaintextPassword,
    })
    assert.equal(loginResponse.status, 200)
    const adminCookie = loginResponse.headers.get('set-cookie')
    assert.ok(adminCookie)

    const registerServerResponse = await fetch(`${firstServer.baseUrl}/codex-api/servers`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Cookie: adminCookie,
      },
      body: JSON.stringify({
        id: 'local-main',
        name: 'Local Main',
        isDefault: true,
      }),
    })
    assert.equal(registerServerResponse.status, 201)
  } finally {
    await firstServer.stop()
  }

  const stateRows = querySqliteRows(
    sqliteFilePath(codeHome),
    'select scope, entry_key as entryKey from state_entries order by scope, entry_key',
  )
  assert.ok(stateRows.some((row) => row.scope === 'hub' && row.entryKey === 'codex-global-state'))
  await assert.rejects(readFile(join(codeHome, '.codex-global-state.json'), 'utf8'))

  const secondServer = await startServer({
    args: ['--password-hash', passwordHash],
    codeHome,
  })

  try {
    const loginResponse = await postJson(`${secondServer.baseUrl}/auth/login`, {
      username: 'hash-admin',
      password: plaintextPassword,
    })
    assert.equal(loginResponse.status, 200)
    const adminCookie = loginResponse.headers.get('set-cookie')
    assert.ok(adminCookie)

    const registryResponse = await fetch(`${secondServer.baseUrl}/codex-api/servers`, {
      headers: {
        Accept: 'application/json',
        Cookie: adminCookie,
      },
    })
    assert.equal(registryResponse.status, 200)
    const registryBody = await registryResponse.json()
    assert.equal(registryBody.data.defaultServerId, 'local-main')
    assert.deepEqual(
      registryBody.data.servers.map((server) => ({ id: server.id, name: server.name, transport: server.transport })),
      [{ id: 'local-main', name: 'Local Main', transport: 'local' }],
    )
  } finally {
    await secondServer.stop()
  }
})

test('server accepts CODEXUI_ADMIN_PASSWORD_HASH and rejects conflicting plaintext env configuration', async () => {
  const plaintextPassword = 'env-hash-secret-1'
  const passwordHash = await generatePasswordHash(plaintextPassword)
  const server = await startServer({
    env: {
      CODEXUI_ADMIN_PASSWORD_HASH: passwordHash,
    },
  })

  try {
    const loginResponse = await postJson(`${server.baseUrl}/auth/login`, {
      username: 'hash-admin',
      password: plaintextPassword,
    })
    assert.equal(loginResponse.status, 200)
  } finally {
    await server.stop()
  }

  const conflictResult = await runCommand([
    'dist-cli/index.js',
    '--host',
    '127.0.0.1',
    '--port',
    String(await getAvailablePort()),
  ], {
    env: {
      CODEXUI_ADMIN_PASSWORD: 'plaintext-secret-1',
      CODEXUI_ADMIN_PASSWORD_HASH: passwordHash,
    },
  })

  assert.notEqual(conflictResult.exitCode, 0)
  assert.match(`${conflictResult.stdout}\n${conflictResult.stderr}`, /CODEXUI_ADMIN_PASSWORD.*CODEXUI_ADMIN_PASSWORD_HASH/u)
})

test('hub entrypoint translates password hash settings into --password-hash and rejects mixed bootstrap sources', async () => {
  const passwordHash = await generatePasswordHash('entrypoint-secret-1')
  const tempDir = await mkdtemp(join(tmpdir(), 'codexui-entrypoint-'))
  const binDir = join(tempDir, 'bin')
  const capturePath = join(tempDir, 'node-args.txt')
  const codeHome = join(tempDir, 'codex-home')

  await mkdir(binDir, { recursive: true })
  await writeFile(join(binDir, 'node'), `#!/usr/bin/env sh\nprintf '%s\\n' "$@" > "${capturePath}"\n`, {
    encoding: 'utf8',
    mode: 0o755,
  })

  const entrypointResult = await runProcess('sh', [entrypointPath], {
    cwd: repoRoot,
    env: {
      PATH: `${binDir}:${process.env.PATH}`,
      CODEX_HOME: codeHome,
      CODEXUI_ADMIN_PASSWORD_HASH: passwordHash,
    },
  })
  assert.equal(entrypointResult.exitCode, 0, entrypointResult.stderr || entrypointResult.stdout)

  const capturedArgs = (await readFile(capturePath, 'utf8')).trim().split('\n')
  assert.ok(capturedArgs.includes('--password-hash'))
  assert.ok(capturedArgs.includes(passwordHash))
  assert.ok(!capturedArgs.includes('--password'))

  const mixedResult = await runProcess('sh', [entrypointPath], {
    cwd: repoRoot,
    env: {
      PATH: `${binDir}:${process.env.PATH}`,
      CODEX_HOME: codeHome,
      CODEXUI_ADMIN_PASSWORD_HASH: passwordHash,
      CODEXUI_ADMIN_PASSWORD: 'plaintext-secret-1',
    },
  })
  assert.notEqual(mixedResult.exitCode, 0)
  assert.match(`${mixedResult.stdout}\n${mixedResult.stderr}`, /cannot be combined/i)
})
