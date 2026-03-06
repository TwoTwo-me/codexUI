import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'

import { createMultiUserContractHttpHandler } from '../../scripts/testing/multi-user-contract-helpers.mjs'

async function withApiServer(run) {
  const server = createServer(createMultiUserContractHttpHandler())
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))

  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Failed to bind explicit server registration test server')
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

test('fresh registries stay empty until a server is explicitly registered', async () => {
  await withApiServer(async (baseUrl) => {
    const adminCookie = await createUserAndSession(baseUrl, 'explicit-admin', 'admin')
    const userCookie = await createUserAndSession(baseUrl, 'explicit-user', 'user', adminCookie)

    const initialRegistryResponse = await fetch(`${baseUrl}/codex-api/servers`, {
      headers: { Cookie: userCookie },
    })
    assert.equal(initialRegistryResponse.status, 200)

    const initialRegistry = await initialRegistryResponse.json()
    assert.equal(initialRegistry.data.defaultServerId, '')
    assert.deepEqual(initialRegistry.data.servers, [])

    const implicitCreateResponse = await postJson(
      `${baseUrl}/codex-api/servers`,
      { name: 'Implicit Local Workspace' },
      { Cookie: userCookie },
    )
    assert.equal(implicitCreateResponse.status, 400)
    const implicitCreateBody = await implicitCreateResponse.json()
    assert.match(implicitCreateBody.error, /explicit server id/i)

    const explicitCreateResponse = await postJson(
      `${baseUrl}/codex-api/servers`,
      { id: 'local-main', name: 'Local Main', isDefault: true },
      { Cookie: userCookie },
    )
    assert.equal(explicitCreateResponse.status, 201)

    const deleteResponse = await deleteRequest(`${baseUrl}/codex-api/servers/local-main`, {
      Cookie: userCookie,
    })
    assert.equal(deleteResponse.status, 200)
    const deleteBody = await deleteResponse.json()
    assert.equal(deleteBody.data.defaultServerId, '')
    assert.deepEqual(deleteBody.data.servers, [])
  })
})
