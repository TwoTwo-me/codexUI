import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(__dirname, '..', '..')

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

async function startServer() {
  const port = await getAvailablePort()
  const codeHome = await mkdtemp(join(tmpdir(), 'codexui-sqlite-state-'))
  const child = spawn('node', ['dist-cli/index.js', '--host', '127.0.0.1', '--port', String(port), '--username', 'sqlite-admin', '--password', 'sqlite-secret-pass-1'], {
    cwd: repoRoot,
    env: createBaseEnv({
      CODEX_HOME: codeHome,
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

function querySqlite(databasePath, sql, params = []) {
  const database = new Database(databasePath, { readonly: true })
  try {
    return database.prepare(sql).all(...params)
  } finally {
    database.close()
  }
}

test('hub persists authenticated user registries inside sqlite state entries', async () => {
  const server = await startServer()
  const databasePath = join(server.codeHome, 'codexui', 'hub.sqlite')

  try {
    const loginResponse = await postJson(`${server.baseUrl}/auth/login`, {
      username: 'sqlite-admin',
      password: 'sqlite-secret-pass-1',
    })
    assert.equal(loginResponse.status, 200)
    const cookie = loginResponse.headers.get('set-cookie')
    assert.ok(cookie)

    const sessionResponse = await fetch(`${server.baseUrl}/auth/session`, {
      headers: { Cookie: cookie },
    })
    assert.equal(sessionResponse.status, 200)
    const sessionPayload = await sessionResponse.json()
    const adminUserId = sessionPayload.user.id
    assert.equal(typeof adminUserId, 'string')

    const createServerResponse = await postJson(
      `${server.baseUrl}/codex-api/servers`,
      {
        id: 'vm-edge-1',
        name: 'VM Edge 1',
        transport: 'local',
        makeDefault: true,
      },
      { Cookie: cookie },
    )
    assert.equal(createServerResponse.status, 201)

    const createConnectorResponse = await postJson(
      `${server.baseUrl}/codex-api/connectors`,
      {
        id: 'vm-edge-1',
        name: 'VM Edge 1',
        hubAddress: server.baseUrl,
      },
      { Cookie: cookie },
    )
    assert.equal(createConnectorResponse.status, 409)

    const stateRows = querySqlite(
      databasePath,
      'select entry_key as entryKey, json_value as jsonValue from state_entries order by entry_key',
    )
    assert.ok(stateRows.length >= 1)

    const globalStateRow = stateRows.find((row) => row.entryKey === 'codex-global-state')
    assert.ok(globalStateRow)

    const payload = JSON.parse(globalStateRow.jsonValue)
    const serverRegistries = payload['codexui-server-registry-by-user']
    assert.equal(typeof serverRegistries, 'object')
    assert.ok(serverRegistries)
    assert.equal(serverRegistries[adminUserId].defaultServerId, 'vm-edge-1')
    assert.deepEqual(
      serverRegistries[adminUserId].servers.map((item) => item.id),
      ['vm-edge-1'],
    )
  } finally {
    await server.stop()
  }
})
