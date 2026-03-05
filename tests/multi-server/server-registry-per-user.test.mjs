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
        { id: 'default', name: 'Default server' },
        { id: 'workspace-main', name: 'Alpha Workspace' },
      ],
    )

    assert.deepEqual(
      betaRegistry.data.servers.map((server) => ({ id: server.id, name: server.name })),
      [
        { id: 'default', name: 'Default server' },
        { id: 'workspace-main', name: 'Beta Workspace' },
      ],
    )

    const anonymousRegistry = await fetch(`${baseUrl}/codex-api/servers`)
    assert.equal(anonymousRegistry.status, 401)
  })
})
