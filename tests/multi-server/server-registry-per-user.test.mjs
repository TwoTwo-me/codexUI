import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'

import { createMultiUserContractHttpHandler } from '../../scripts/testing/multi-user-contract-helpers.mjs'

async function withApiServer(run) {
  const server = createServer(createMultiUserContractHttpHandler())
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))

  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Failed to bind server registry scope test server')
  }

  const baseUrl = `http://127.0.0.1:${address.port}`

  try {
    await run(baseUrl)
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
}

async function postJson(url, payload, headers = {}) {
  return fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
    body: JSON.stringify(payload),
  })
}

async function createUserAndSession(baseUrl, username, role = 'user', adminCookie) {
  const signupResponse = await postJson(`${baseUrl}/auth/signup`, {
    username,
    password: `${username}-pass`,
    role,
  }, adminCookie ? { Cookie: adminCookie } : {})
  assert.equal(signupResponse.status, 201)

  const loginResponse = await postJson(`${baseUrl}/auth/login`, {
    username,
    password: `${username}-pass`,
  })
  assert.equal(loginResponse.status, 200)
  const cookie = loginResponse.headers.get('set-cookie')
  assert.ok(cookie)
  return cookie
}

test('server registry API contract scopes registry state per authenticated user', async () => {
  await withApiServer(async (baseUrl) => {
    const adminCookie = await createUserAndSession(baseUrl, 'admin-user', 'admin')
    const alphaCookie = await createUserAndSession(baseUrl, 'alpha', 'user', adminCookie)
    const betaCookie = await createUserAndSession(baseUrl, 'beta', 'user', adminCookie)

    const alphaCreate = await postJson(
      `${baseUrl}/codex-api/servers`,
      { id: 'workspace-main', name: 'Alpha Workspace', isDefault: true },
      { Cookie: alphaCookie },
    )
    assert.equal(alphaCreate.status, 201)

    const betaCreate = await postJson(
      `${baseUrl}/codex-api/servers`,
      { id: 'workspace-main', name: 'Beta Workspace', isDefault: true },
      { Cookie: betaCookie },
    )
    assert.equal(betaCreate.status, 201)

    const alphaRegistryResponse = await fetch(`${baseUrl}/codex-api/servers`, {
      headers: { Cookie: alphaCookie },
    })
    assert.equal(alphaRegistryResponse.status, 200)
    const alphaRegistry = await alphaRegistryResponse.json()

    const betaRegistryResponse = await fetch(`${baseUrl}/codex-api/servers`, {
      headers: { Cookie: betaCookie },
    })
    assert.equal(betaRegistryResponse.status, 200)
    const betaRegistry = await betaRegistryResponse.json()

    assert.equal(alphaRegistry.data.defaultServerId, 'workspace-main')
    assert.equal(betaRegistry.data.defaultServerId, 'workspace-main')

    assert.deepEqual(
      alphaRegistry.data.servers.map((server) => ({ id: server.id, name: server.name })),
      [
        { id: 'workspace-main', name: 'Alpha Workspace' },
      ],
    )

    assert.deepEqual(
      betaRegistry.data.servers.map((server) => ({ id: server.id, name: server.name })),
      [
        { id: 'workspace-main', name: 'Beta Workspace' },
      ],
    )

    const anonymousRegistry = await fetch(`${baseUrl}/codex-api/servers`)
    assert.equal(anonymousRegistry.status, 401)
  })
})

test('server registry accepts relay transport metadata and validates relay payload', async () => {
  await withApiServer(async (baseUrl) => {
    const adminCookie = await createUserAndSession(baseUrl, 'relay-admin', 'admin')
    const alphaCookie = await createUserAndSession(baseUrl, 'relay-alpha', 'user', adminCookie)

    const invalidRelayCreate = await postJson(
      `${baseUrl}/codex-api/servers`,
      {
        id: 'relay-invalid',
        name: 'Relay Invalid',
        transport: 'relay',
      },
      { Cookie: alphaCookie },
    )
    assert.equal(invalidRelayCreate.status, 400)

    const invalidRelayE2eeCreate = await postJson(
      `${baseUrl}/codex-api/servers`,
      {
        id: 'relay-invalid-e2ee',
        name: 'Relay Invalid E2EE',
        transport: 'relay',
        relay: {
          agentId: 'edge-invalid',
          protocol: 'relay-http-v1',
          requestTimeoutMs: 90_000,
          e2ee: {
            enabled: true,
            keyId: 'bad key',
            algorithm: 'aes-256-gcm',
          },
        },
      },
      { Cookie: alphaCookie },
    )
    assert.equal(invalidRelayE2eeCreate.status, 400)

    const relayCreate = await postJson(
      `${baseUrl}/codex-api/servers`,
      {
        id: 'relay-edge-1',
        name: 'Relay Edge',
        transport: 'relay',
        relay: {
          agentId: 'edge-1',
          protocol: 'relay-http-v1',
          requestTimeoutMs: 90_000,
          e2ee: {
            enabled: true,
            keyId: 'relay-edge-key-1',
            algorithm: 'aes-256-gcm',
          },
        },
      },
      { Cookie: alphaCookie },
    )
    assert.equal(relayCreate.status, 201)
    const relayCreateBody = await relayCreate.json()
    assert.equal(relayCreateBody.data.server.transport, 'relay')
    assert.equal(relayCreateBody.data.server.relay.agentId, 'edge-1')
    assert.equal(relayCreateBody.data.server.relay.protocol, 'relay-http-v1')
    assert.equal(relayCreateBody.data.server.relay.requestTimeoutMs, 90_000)
    assert.equal(relayCreateBody.data.server.relay.e2ee.keyId, 'relay-edge-key-1')
    assert.equal(relayCreateBody.data.server.relay.e2ee.algorithm, 'aes-256-gcm')

    const legacyRelayCreate = await postJson(
      `${baseUrl}/codex-api/servers`,
      {
        id: 'relay-edge-legacy',
        name: 'Relay Edge Legacy',
        transport: 'relay',
        relay: {
          agentId: 'agent:edge-legacy',
          protocol: 'relay-http-v1',
          requestTimeoutMs: 90_000,
        },
      },
      { Cookie: alphaCookie },
    )
    assert.equal(legacyRelayCreate.status, 201)
    const legacyRelayCreateBody = await legacyRelayCreate.json()
    assert.equal(legacyRelayCreateBody.data.server.transport, 'relay')
    assert.equal(legacyRelayCreateBody.data.server.relay.agentId, 'edge-legacy')

    const alphaRegistryResponse = await fetch(`${baseUrl}/codex-api/servers`, {
      headers: { Cookie: alphaCookie },
    })
    assert.equal(alphaRegistryResponse.status, 200)
    const alphaRegistry = await alphaRegistryResponse.json()
    const relayServer = alphaRegistry.data.servers.find((server) => server.id === 'relay-edge-1')
    assert.ok(relayServer)
    assert.equal(relayServer.transport, 'relay')
    assert.equal(relayServer.relay.agentId, 'edge-1')
    assert.equal(relayServer.relay.e2ee.keyId, 'relay-edge-key-1')
    assert.equal(relayServer.relay.e2ee.algorithm, 'aes-256-gcm')

    const legacyRelayServer = alphaRegistry.data.servers.find((server) => server.id === 'relay-edge-legacy')
    assert.ok(legacyRelayServer)
    assert.equal(legacyRelayServer.transport, 'relay')
    assert.equal(legacyRelayServer.relay.agentId, 'edge-legacy')
    assert.equal(legacyRelayServer.relay.e2ee, undefined)
  })
})
