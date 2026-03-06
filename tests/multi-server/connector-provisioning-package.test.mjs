import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoDir = resolve(__dirname, '../..')

async function loadConnectorModule() {
  const moduleUrl = pathToFileURL(resolve(repoDir, 'dist-cli/connector.js')).href
  return await import(`${moduleUrl}?t=${Date.now()}`)
}

test('connector package provisions a connector via hub login and returns an install command', async () => {
  const module = await loadConnectorModule()
  assert.equal(typeof module.provisionConnectorRegistration, 'function')
  assert.equal(typeof module.createConnectorInstallCommand, 'function')
  assert.equal(typeof module.installConnectorFromBootstrap, 'function')

  const server = createServer(async (req, res) => {
    if (!req.url) {
      res.statusCode = 404
      res.end()
      return
    }

    if (req.method === 'POST' && req.url === '/auth/login') {
      let body = ''
      for await (const chunk of req) {
        body += chunk
      }
      const payload = JSON.parse(body)
      assert.equal(payload.username, 'alice')
      assert.equal(payload.password, 'secret-pass')
      res.statusCode = 200
      res.setHeader('Content-Type', 'application/json; charset=utf-8')
      res.setHeader('Set-Cookie', 'codex_web_local_token=session-1; Path=/; HttpOnly; SameSite=Strict')
      res.end(JSON.stringify({ ok: true }))
      return
    }

    if (req.method === 'POST' && req.url === '/codex-api/connectors') {
      assert.match(req.headers.cookie ?? '', /codex_web_local_token=session-1/)
      let body = ''
      for await (const chunk of req) {
        body += chunk
      }
      const payload = JSON.parse(body)
      assert.equal(payload.id, 'edge-laptop')
      assert.equal(payload.name, 'Edge Laptop')
      res.statusCode = 201
      res.setHeader('Content-Type', 'application/json; charset=utf-8')
      res.end(JSON.stringify({
        data: {
          connector: {
            id: 'edge-laptop',
            serverId: 'edge-laptop',
            name: 'Edge Laptop',
            hubAddress: 'http://127.0.0.1:47891',
            relayAgentId: 'agent-edge-laptop',
            installState: 'pending_install',
            bootstrapExpiresAtIso: '2026-03-07T00:15:00.000Z',
          },
          bootstrapToken: 'install-token-123',
        },
      }))
      return
    }

    res.statusCode = 404
    res.end(JSON.stringify({ error: 'Not found' }))
  })

  await new Promise((resolve) => server.listen(47891, '127.0.0.1', resolve))

  try {
    const provisioned = await module.provisionConnectorRegistration({
      hubAddress: 'http://127.0.0.1:47891',
      username: 'alice',
      password: 'secret-pass',
      connectorId: 'edge-laptop',
      connectorName: 'Edge Laptop',
    })

    assert.equal(provisioned.connector.id, 'edge-laptop')
    assert.equal(provisioned.connector.relayAgentId, 'agent-edge-laptop')
    assert.equal(provisioned.connector.installState, 'pending_install')
    assert.equal(provisioned.connector.bootstrapExpiresAtIso, '2026-03-07T00:15:00.000Z')
    assert.equal(provisioned.bootstrapToken, 'install-token-123')

    const installCommand = module.createConnectorInstallCommand({
      hubAddress: provisioned.connector.hubAddress,
      connectorId: provisioned.connector.id,
    })
    assert.match(installCommand, /codexui-connector install/)
    assert.match(installCommand, /edge-laptop/)
    assert.match(installCommand, /--token-file/)
    assert.match(installCommand, /\$HOME\/\.codexui-connector\/edge-laptop\.token/)
    assert.doesNotMatch(installCommand, /"~\//)
    assert.doesNotMatch(installCommand, /install-token-123/)
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error)
          return
        }
        resolve()
      })
    })
  }
})

test('connector package expands home-relative token file paths before writing credentials', async () => {
  const module = await loadConnectorModule()
  assert.equal(typeof module.writeConnectorTokenFile, 'function')

  const fakeHome = await mkdtemp(resolve(tmpdir(), 'codexui-home-'))
  const originalHome = process.env.HOME
  process.env.HOME = fakeHome

  try {
    await module.writeConnectorTokenFile('~/.codexui-connector/edge-laptop.token', 'durable-token-456')
    const persisted = await readFile(resolve(fakeHome, '.codexui-connector/edge-laptop.token'), 'utf8')
    assert.equal(persisted, 'durable-token-456')
  } finally {
    process.env.HOME = originalHome
  }
})

test('connector install command refuses bootstrap input that would discard the durable credential', async () => {
  const connectorEntrypoint = resolve(repoDir, 'dist-cli/connector.js')
  const result = spawnSync(
    'node',
    [
      connectorEntrypoint,
      'install',
      '--hub',
      'http://127.0.0.1:47893',
      '--connector',
      'edge-laptop',
      '--token',
      'bootstrap-token-123',
      '--allow-insecure-http',
    ],
    {
      cwd: repoDir,
      env: {
        ...process.env,
        NO_COLOR: '1',
      },
      encoding: 'utf8',
    },
  )

  assert.notEqual(result.status, 0)
  assert.match(`${result.stdout}\n${result.stderr}`, /--token-file/i)
  assert.match(`${result.stdout}\n${result.stderr}`, /--run/i)
})

test('connector package exchanges a bootstrap token and rewrites the token file with the durable credential', async () => {
  const module = await loadConnectorModule()
  assert.equal(typeof module.installConnectorFromBootstrap, 'function')

  const server = createServer(async (req, res) => {
    if (req.method === 'POST' && req.url === '/codex-api/connectors/edge-laptop/bootstrap-exchange') {
      assert.equal(req.headers.authorization, 'Bearer install-token-123')
      res.statusCode = 200
      res.setHeader('Content-Type', 'application/json; charset=utf-8')
      res.end(JSON.stringify({
        data: {
          connector: {
            id: 'edge-laptop',
            serverId: 'edge-laptop',
            name: 'Edge Laptop',
            hubAddress: 'http://127.0.0.1:47892',
            relayAgentId: 'agent-edge-laptop',
            installState: 'offline',
            credentialIssuedAtIso: '2026-03-07T00:01:00.000Z',
          },
          credentialToken: 'durable-token-456',
        },
      }))
      return
    }

    res.statusCode = 404
    res.end(JSON.stringify({ error: 'Not found' }))
  })

  await new Promise((resolve) => server.listen(47892, '127.0.0.1', resolve))

  try {
    const tempDir = await mkdtemp(resolve(tmpdir(), 'codexui-bootstrap-'))
    const tokenFilePath = resolve(tempDir, 'edge-laptop.token')
    await module.writeConnectorTokenFile(tokenFilePath, 'install-token-123')

    const installed = await module.installConnectorFromBootstrap({
      hubAddress: 'http://127.0.0.1:47892',
      connectorId: 'edge-laptop',
      tokenFile: tokenFilePath,
    })

    assert.equal(installed.connector.installState, 'offline')
    assert.equal(installed.credentialToken, 'durable-token-456')
    assert.equal(await readFile(tokenFilePath, 'utf8'), 'durable-token-456')
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error)
          return
        }
        resolve()
      })
    })
  }
})

test('connector package rejects insecure non-loopback HTTP hub addresses by default', async () => {
  const module = await loadConnectorModule()

  await assert.rejects(
    module.provisionConnectorRegistration({
      hubAddress: 'http://hub.example.test',
      username: 'alice',
      password: 'secret-pass',
      connectorId: 'edge-laptop',
      connectorName: 'Edge Laptop',
    }),
    /HTTPS is required/i,
  )

  assert.throws(
    () => new module.HttpRelayHubTransport('http://hub.example.test'),
    /HTTPS is required/i,
  )
})
