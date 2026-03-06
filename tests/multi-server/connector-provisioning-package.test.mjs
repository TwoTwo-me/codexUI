import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { dirname, resolve } from 'node:path'
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
          },
          token: 'install-token-123',
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
    assert.equal(provisioned.token, 'install-token-123')

    const installCommand = module.createConnectorInstallCommand({
      hubAddress: provisioned.connector.hubAddress,
      connectorId: provisioned.connector.id,
      token: provisioned.token,
    })
    assert.match(installCommand, /codexui-connector connect/)
    assert.match(installCommand, /edge-laptop/)
    assert.match(installCommand, /--token-file/)
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
