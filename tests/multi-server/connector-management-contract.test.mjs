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

test('connector management supports server binding, rename, token rotation, and delete cleanup per user', async () => {
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
    assert.equal(typeof createBody.data.token, 'string')

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
    assert.equal(typeof rotateBody.data.token, 'string')
    assert.notEqual(rotateBody.data.token, createBody.data.token)

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
