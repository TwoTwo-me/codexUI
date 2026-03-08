import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { accessSync, constants as fsConstants } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(__dirname, '..', '..')
const distCliPath = join(repoRoot, 'dist-cli', 'index.js')
const connectorCliPath = join(repoRoot, 'dist-cli', 'connector.js')

accessSync(distCliPath, fsConstants.F_OK)
accessSync(connectorCliPath, fsConstants.F_OK)

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

async function loadConnectorModule() {
  const moduleUrl = pathToFileURL(connectorCliPath).href
  return await import(`${moduleUrl}?t=${Date.now()}`)
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

async function generatePasswordHash(password) {
  const result = await runProcess('node', ['dist-cli/index.js', 'hash-password', '--password-stdin'], {
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

async function startServer({ password, username = 'relay-admin' }) {
  const passwordHash = await generatePasswordHash(password)
  const port = await getAvailablePort()
  const codeHome = await mkdtemp(join(tmpdir(), 'codexui-connector-fs-bridge-'))
  const child = spawn('node', ['dist-cli/index.js', '--host', '127.0.0.1', '--port', String(port), '--username', username, '--password-hash', passwordHash], {
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
    outputRef,
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

test('server-scoped filesystem endpoints dispatch to the selected connector instead of the hub host', async () => {
  const password = 'relay-files-secret-1'
  const server = await startServer({ password })
  const connectorModule = await loadConnectorModule()

  try {
    const loginResponse = await postJson(`${server.baseUrl}/auth/login`, {
      username: 'relay-admin',
      password,
    })
    assert.equal(loginResponse.status, 200)
    const cookie = loginResponse.headers.get('set-cookie')
    assert.ok(cookie)

    const createResponse = await postJson(
      `${server.baseUrl}/codex-api/connectors`,
      {
        id: 'remote-edge',
        name: 'Remote Edge',
        hubAddress: server.baseUrl,
      },
      { Cookie: cookie },
    )
    assert.equal(createResponse.status, 201)
    const createBody = await createResponse.json()
    const bootstrapToken = createBody.data.bootstrapToken
    assert.equal(typeof bootstrapToken, 'string')

    const exchangeResponse = await postJson(
      `${server.baseUrl}/codex-api/connectors/remote-edge/bootstrap-exchange`,
      {
        hostname: 'remote-edge',
        platform: 'linux',
        connectorVersion: '0.1.4',
      },
      {
        Authorization: `Bearer ${bootstrapToken}`,
      },
    )
    assert.equal(exchangeResponse.status, 200)
    const exchangeBody = await exchangeResponse.json()
    const credentialToken = exchangeBody.data.credentialToken
    assert.equal(typeof credentialToken, 'string')

    const rpcCalls = []
    const transport = new connectorModule.HttpRelayHubTransport(server.baseUrl, { allowInsecureHttp: true })
    const connector = new connectorModule.CodexRelayConnector({
      token: credentialToken,
      transport,
      connectorId: 'remote-edge',
      appServer: {
        async rpc(method, params) {
          rpcCalls.push({ method, params })
          if (method === 'codexui/fs/list') {
            return {
              currentPath: '/remote-home/projects',
              homePath: '/remote-home',
              parentPath: '/remote-home',
              entries: [
                { name: 'connector-only-project', path: '/remote-home/projects/connector-only-project' },
              ],
            }
          }
          if (method === 'codexui/project-root-suggestion') {
            return {
              name: 'New Project (1)',
              path: '/remote-home/New Project (1)',
            }
          }
          if (method === 'codexui/composer-file-search') {
            return [{ path: 'src/remote-entry.ts' }]
          }
          throw new Error(`Unexpected method: ${method}`)
        },
        onNotification() {
          return () => undefined
        },
      },
    })

    await connector.connect()

    const pumpRelay = async (responsePromise) => {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 50))
      await connector.pollOnce()
      return await responsePromise
    }

    const fsResponse = await pumpRelay(fetch(`${server.baseUrl}/codex-api/fs/list?serverId=remote-edge&path=${encodeURIComponent('/remote-home/projects')}`, {
      headers: { Cookie: cookie },
    }))
    assert.equal(fsResponse.status, 200)
    const fsBody = await fsResponse.json()
    assert.deepEqual(fsBody.data, {
      currentPath: '/remote-home/projects',
      homePath: '/remote-home',
      parentPath: '/remote-home',
      entries: [
        { name: 'connector-only-project', path: '/remote-home/projects/connector-only-project' },
      ],
    })

    const suggestionResponse = await pumpRelay(fetch(`${server.baseUrl}/codex-api/project-root-suggestion?serverId=remote-edge&basePath=${encodeURIComponent('/remote-home')}`, {
      headers: { Cookie: cookie },
    }))
    assert.equal(suggestionResponse.status, 200)
    const suggestionBody = await suggestionResponse.json()
    assert.deepEqual(suggestionBody.data, {
      name: 'New Project (1)',
      path: '/remote-home/New Project (1)',
    })

    const composerResponse = await pumpRelay(fetch(`${server.baseUrl}/codex-api/composer-file-search?serverId=remote-edge`, {
      method: 'POST',
      headers: {
        Cookie: cookie,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ cwd: '/remote-home/projects/connector-only-project', query: 'remote', limit: 5 }),
    }))
    assert.equal(composerResponse.status, 200)
    const composerBody = await composerResponse.json()
    assert.deepEqual(composerBody.data, [{ path: 'src/remote-entry.ts' }])

    assert.deepEqual(rpcCalls.map((entry) => entry.method), [
      'codexui/fs/list',
      'codexui/project-root-suggestion',
      'codexui/composer-file-search',
    ])
  } finally {
    await server.stop()
  }
})
