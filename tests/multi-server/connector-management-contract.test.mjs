import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'

import { createMultiUserContractHttpHandler } from '../../scripts/testing/multi-user-contract-helpers.mjs'

async function withApiServer(run) {
  const server = createServer(createMultiUserContractHttpHandler())
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))

  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Failed to bind connector management contract test server')
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

async function patchJson(url, payload, headers = {}) {
  return fetch(url, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
    body: JSON.stringify(payload),
  })
}

async function deleteRequest(url, headers = {}) {
  return fetch(url, {
    method: 'DELETE',
    headers,
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

test('connector management supports server binding, rename, reinstall token rotation, and delete cleanup per user', async () => {
  await withApiServer(async (baseUrl) => {
    const adminCookie = await createUserAndSession(baseUrl, 'connector-manage-admin', 'admin')
    const alphaCookie = await createUserAndSession(baseUrl, 'connector-manage-alpha', 'user', adminCookie)
    const betaCookie = await createUserAndSession(baseUrl, 'connector-manage-beta', 'user', adminCookie)

    const createResponse = await postJson(
      `${baseUrl}/codex-api/connectors`,
      {
        id: 'alpha-edge',
        name: 'Alpha Edge',
        hubAddress: 'https://hub.example.test',
      },
      { Cookie: alphaCookie },
    )
    assert.equal(createResponse.status, 201)
    const createBody = await createResponse.json()
    assert.equal(createBody.data.connector.id, 'alpha-edge')
    assert.equal(createBody.data.connector.serverId, 'alpha-edge')
    assert.equal(createBody.data.connector.connected, false)
    assert.equal(createBody.data.connector.installState, 'pending_install')
    assert.equal(typeof createBody.data.connector.bootstrapExpiresAtIso, 'string')
    assert.equal(typeof createBody.data.bootstrapToken, 'string')

    const alphaServersResponse = await fetch(`${baseUrl}/codex-api/servers`, {
      headers: { Cookie: alphaCookie },
    })
    assert.equal(alphaServersResponse.status, 200)
    const alphaServersBody = await alphaServersResponse.json()
    assert.deepEqual(
      alphaServersBody.data.servers.map((server) => ({
        id: server.id,
        name: server.name,
        transport: server.transport,
        relayAgentId: server.relay?.agentId,
      })),
      [
        {
          id: 'alpha-edge',
          name: 'Alpha Edge',
          transport: 'relay',
          relayAgentId: createBody.data.connector.relayAgentId,
        },
      ],
    )

    const renameResponse = await patchJson(
      `${baseUrl}/codex-api/connectors/alpha-edge`,
      { name: 'Alpha Edge Renamed' },
      { Cookie: alphaCookie },
    )
    assert.equal(renameResponse.status, 200)
    const renameBody = await renameResponse.json()
    assert.equal(renameBody.data.connector.name, 'Alpha Edge Renamed')

    const alphaConnectorsAfterRename = await fetch(`${baseUrl}/codex-api/connectors`, {
      headers: { Cookie: alphaCookie },
    })
    const alphaConnectorsAfterRenameBody = await alphaConnectorsAfterRename.json()
    assert.equal(alphaConnectorsAfterRenameBody.data.connectors[0].name, 'Alpha Edge Renamed')

    const alphaServersAfterRename = await fetch(`${baseUrl}/codex-api/servers`, {
      headers: { Cookie: alphaCookie },
    })
    const alphaServersAfterRenameBody = await alphaServersAfterRename.json()
    assert.equal(alphaServersAfterRenameBody.data.servers[0].name, 'Alpha Edge Renamed')

    const rotateResponse = await postJson(
      `${baseUrl}/codex-api/connectors/alpha-edge/rotate-token`,
      {},
      { Cookie: alphaCookie },
    )
    assert.equal(rotateResponse.status, 200)
    const rotateBody = await rotateResponse.json()
    assert.equal(rotateBody.data.connector.id, 'alpha-edge')
    assert.equal(rotateBody.data.connector.installState, 'pending_install')
    assert.equal(typeof rotateBody.data.bootstrapToken, 'string')
    assert.notEqual(rotateBody.data.bootstrapToken, createBody.data.bootstrapToken)

    const betaDeleteResponse = await deleteRequest(`${baseUrl}/codex-api/connectors/alpha-edge`, {
      Cookie: betaCookie,
    })
    assert.equal(betaDeleteResponse.status, 404)

    const deleteResponse = await deleteRequest(`${baseUrl}/codex-api/connectors/alpha-edge`, {
      Cookie: alphaCookie,
    })
    assert.equal(deleteResponse.status, 200)

    const alphaConnectorsAfterDelete = await fetch(`${baseUrl}/codex-api/connectors`, {
      headers: { Cookie: alphaCookie },
    })
    const alphaConnectorsAfterDeleteBody = await alphaConnectorsAfterDelete.json()
    assert.deepEqual(alphaConnectorsAfterDeleteBody.data.connectors, [])

    const alphaServersAfterDelete = await fetch(`${baseUrl}/codex-api/servers`, {
      headers: { Cookie: alphaCookie },
    })
    const alphaServersAfterDeleteBody = await alphaServersAfterDelete.json()
    assert.deepEqual(alphaServersAfterDeleteBody.data.servers, [])
    assert.equal(alphaServersAfterDeleteBody.data.defaultServerId, '')
  })
})

test('connector delete response preserves cached stats for remaining connectors', async () => {
  await withApiServer(async (baseUrl) => {
    const adminCookie = await createUserAndSession(baseUrl, 'connector-stats-delete-admin', 'admin')
    const alphaCookie = await createUserAndSession(baseUrl, 'connector-stats-delete-alpha', 'user', adminCookie)

    const statsConnectorResponse = await postJson(
      `${baseUrl}/codex-api/connectors`,
      {
        id: 'build-runner',
        name: 'Build Runner',
        hubAddress: 'https://hub.example.test',
        mockStatus: {
          connected: true,
          projectCount: 2,
          threadCount: 4,
        },
      },
      { Cookie: alphaCookie },
    )
    assert.equal(statsConnectorResponse.status, 201)

    const deleteTargetResponse = await postJson(
      `${baseUrl}/codex-api/connectors`,
      {
        id: 'alpha-edge',
        name: 'Alpha Edge',
        hubAddress: 'https://hub.example.test',
      },
      { Cookie: alphaCookie },
    )
    assert.equal(deleteTargetResponse.status, 201)

    const deleteResponse = await deleteRequest(`${baseUrl}/codex-api/connectors/alpha-edge`, {
      Cookie: alphaCookie,
    })
    assert.equal(deleteResponse.status, 200)
    const deleteBody = await deleteResponse.json()
    assert.deepEqual(
      deleteBody.data.connectors.map((connector) => ({
        id: connector.id,
        projectCount: connector.projectCount,
        threadCount: connector.threadCount,
        statsStale: connector.statsStale,
      })),
      [
        {
          id: 'build-runner',
          projectCount: 2,
          threadCount: 4,
          statsStale: false,
        },
      ],
    )
  })
})

test('connector registration rejects insecure remote hub addresses while allowing loopback http', async () => {
  await withApiServer(async (baseUrl) => {
    const adminCookie = await createUserAndSession(baseUrl, 'connector-hub-admin', 'admin')
    const alphaCookie = await createUserAndSession(baseUrl, 'connector-hub-alpha', 'user', adminCookie)

    const insecureResponse = await postJson(
      `${baseUrl}/codex-api/connectors`,
      {
        id: 'remote-http',
        name: 'Remote HTTP',
        hubAddress: 'http://hub.example.test',
      },
      { Cookie: alphaCookie },
    )
    assert.equal(insecureResponse.status, 400)
    const insecureBody = await insecureResponse.json()
    assert.match(insecureBody.error, /HTTPS/i)

    const loopbackResponse = await postJson(
      `${baseUrl}/codex-api/connectors`,
      {
        id: 'local-http',
        name: 'Local HTTP',
        hubAddress: 'http://127.0.0.1:4300',
      },
      { Cookie: alphaCookie },
    )
    assert.equal(loopbackResponse.status, 201)
  })
})

test('connector bootstrap exchange issues a durable credential, rejects replay, and rotates reinstall tokens', async () => {
  await withApiServer(async (baseUrl) => {
    const adminCookie = await createUserAndSession(baseUrl, 'connector-bootstrap-admin', 'admin')
    const alphaCookie = await createUserAndSession(baseUrl, 'connector-bootstrap-alpha', 'user', adminCookie)

    const createResponse = await postJson(
      `${baseUrl}/codex-api/connectors`,
      {
        id: 'alpha-edge',
        name: 'Alpha Edge',
        hubAddress: 'https://hub.example.test',
      },
      { Cookie: alphaCookie },
    )
    assert.equal(createResponse.status, 201)
    const createBody = await createResponse.json()
    const bootstrapToken = createBody.data.bootstrapToken
    assert.equal(createBody.data.connector.installState, 'pending_install')

    const bootstrapRejectedByRelay = await fetch(`${baseUrl}/codex-api/relay/agent/connect`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${bootstrapToken}`,
      },
    })
    assert.equal(bootstrapRejectedByRelay.status, 401)

    const exchangeResponse = await postJson(
      `${baseUrl}/codex-api/connectors/alpha-edge/bootstrap-exchange`,
      {
        hostname: 'alpha-host',
        platform: 'linux',
        connectorVersion: '0.1.4',
      },
      {
        Authorization: `Bearer ${bootstrapToken}`,
      },
    )
    assert.equal(exchangeResponse.status, 200)
    const exchangeBody = await exchangeResponse.json()
    assert.equal(typeof exchangeBody.data.credentialToken, 'string')
    assert.equal(exchangeBody.data.connector.installState, 'offline')

    const relayConnectResponse = await fetch(`${baseUrl}/codex-api/relay/agent/connect`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${exchangeBody.data.credentialToken}`,
      },
    })
    assert.equal(relayConnectResponse.status, 200)

    const replayResponse = await postJson(
      `${baseUrl}/codex-api/connectors/alpha-edge/bootstrap-exchange`,
      {},
      {
        Authorization: `Bearer ${bootstrapToken}`,
      },
    )
    assert.equal(replayResponse.status, 409)

    const connectorsAfterInstall = await fetch(`${baseUrl}/codex-api/connectors`, {
      headers: { Cookie: alphaCookie },
    })
    assert.equal(connectorsAfterInstall.status, 200)
    const connectorsAfterInstallBody = await connectorsAfterInstall.json()
    assert.equal(connectorsAfterInstallBody.data.connectors[0].installState, 'connected')
    assert.equal(typeof connectorsAfterInstallBody.data.connectors[0].bootstrapConsumedAtIso, 'string')

    const rotateResponse = await postJson(
      `${baseUrl}/codex-api/connectors/alpha-edge/rotate-token`,
      {},
      { Cookie: alphaCookie },
    )
    assert.equal(rotateResponse.status, 200)
    const rotateBody = await rotateResponse.json()
    assert.equal(rotateBody.data.connector.installState, 'reinstall_required')
    assert.equal(typeof rotateBody.data.bootstrapToken, 'string')

    const oldCredentialRejected = await fetch(`${baseUrl}/codex-api/relay/agent/connect`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${exchangeBody.data.credentialToken}`,
      },
    })
    assert.equal(oldCredentialRejected.status, 401)

    const reinstallExchange = await postJson(
      `${baseUrl}/codex-api/connectors/alpha-edge/bootstrap-exchange`,
      {},
      {
        Authorization: `Bearer ${rotateBody.data.bootstrapToken}`,
      },
    )
    assert.equal(reinstallExchange.status, 200)
    const reinstallBody = await reinstallExchange.json()
    assert.equal(typeof reinstallBody.data.credentialToken, 'string')
    assert.notEqual(reinstallBody.data.credentialToken, exchangeBody.data.credentialToken)
  })
})

test('connector bootstrap exchange rejects expired bootstrap tokens and reports expiration state', async () => {
  await withApiServer(async (baseUrl) => {
    const adminCookie = await createUserAndSession(baseUrl, 'connector-expired-admin', 'admin')
    const alphaCookie = await createUserAndSession(baseUrl, 'connector-expired-alpha', 'user', adminCookie)

    const createResponse = await postJson(
      `${baseUrl}/codex-api/connectors`,
      {
        id: 'expired-edge',
        name: 'Expired Edge',
        hubAddress: 'https://hub.example.test',
        bootstrapTtlMs: -1,
      },
      { Cookie: alphaCookie },
    )
    assert.equal(createResponse.status, 201)
    const createBody = await createResponse.json()

    const listResponse = await fetch(`${baseUrl}/codex-api/connectors`, {
      headers: { Cookie: alphaCookie },
    })
    assert.equal(listResponse.status, 200)
    const listBody = await listResponse.json()
    assert.equal(listBody.data.connectors[0].installState, 'expired_bootstrap')

    const exchangeResponse = await postJson(
      `${baseUrl}/codex-api/connectors/expired-edge/bootstrap-exchange`,
      {},
      {
        Authorization: `Bearer ${createBody.data.bootstrapToken}`,
      },
    )
    assert.equal(exchangeResponse.status, 410)
  })
})

test('connector bootstrap exchange rate limits repeated unauthenticated guesses', async () => {
  await withApiServer(async (baseUrl) => {
    const adminCookie = await createUserAndSession(baseUrl, 'connector-guess-admin', 'admin')
    const alphaCookie = await createUserAndSession(baseUrl, 'connector-guess-alpha', 'user', adminCookie)

    const createResponse = await postJson(
      `${baseUrl}/codex-api/connectors`,
      {
        id: 'guess-edge',
        name: 'Guess Edge',
        hubAddress: 'https://hub.example.test',
      },
      { Cookie: alphaCookie },
    )
    assert.equal(createResponse.status, 201)

    for (let attempt = 0; attempt < 4; attempt += 1) {
      const response = await postJson(
        `${baseUrl}/codex-api/connectors/guess-edge/bootstrap-exchange`,
        {},
        {
          Authorization: `Bearer invalid-${String(attempt)}`,
        },
      )
      assert.equal(response.status, 401)
    }

    const limitedResponse = await postJson(
      `${baseUrl}/codex-api/connectors/guess-edge/bootstrap-exchange`,
      {},
      {
        Authorization: 'Bearer invalid-final',
      },
    )
    assert.equal(limitedResponse.status, 429)
  })
})
