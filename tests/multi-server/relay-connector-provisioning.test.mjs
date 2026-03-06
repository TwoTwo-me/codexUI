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

async function readJsonBody(req) {
  const chunks = []
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

test('connector provisioning reuses the session cookie returned by /auth/login', async () => {
  const module = await loadConnectorModule()
  assert.equal(typeof module.provisionConnectorRegistration, 'function')

  const server = createServer(async (req, res) => {
    if (req.method === 'POST' && req.url === '/auth/login') {
      res.statusCode = 200
      res.setHeader('Set-Cookie', 'codex_web_local_token=session-123; Path=/; HttpOnly; SameSite=Strict')
      res.setHeader('Content-Type', 'application/json; charset=utf-8')
      res.end(JSON.stringify({ ok: true, user: { username: 'admin' } }))
      return
    }

    if (req.method === 'POST' && req.url === '/codex-api/connectors') {
      assert.equal(req.headers.cookie, 'codex_web_local_token=session-123')
      const payload = await readJsonBody(req)
      assert.equal(payload.id, 'remote-alpha')
      assert.equal(payload.name, 'Remote Alpha')
      res.statusCode = 201
      res.setHeader('Content-Type', 'application/json; charset=utf-8')
      res.end(JSON.stringify({
        data: {
          connector: {
            id: 'remote-alpha',
            serverId: 'remote-alpha',
            name: 'Remote Alpha',
            hubAddress: 'http://127.0.0.1:0',
            relayAgentId: 'agent-remote-alpha',
          },
          token: 'issued-token-123',
        },
      }))
      return
    }

    res.statusCode = 404
    res.end('Not found')
  })

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const hubAddress = `http://127.0.0.1:${address.port}`

  try {
    const result = await module.provisionConnectorRegistration({
      hubAddress,
      username: 'admin',
      password: 'admin',
      connectorId: 'remote-alpha',
      connectorName: 'Remote Alpha',
    })

    assert.equal(result.token, 'issued-token-123')
    assert.equal(result.connector.id, 'remote-alpha')
    assert.equal(result.connector.name, 'Remote Alpha')
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error)
        else resolve()
      })
    })
  }
})
