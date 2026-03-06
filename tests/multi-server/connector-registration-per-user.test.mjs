import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'

import { createMultiUserContractHttpHandler } from '../../scripts/testing/multi-user-contract-helpers.mjs'

async function withApiServer(run) {
  const server = createServer(createMultiUserContractHttpHandler())
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))

  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Failed to bind connector registry contract test server')
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

test('connector registry is isolated per authenticated user and returns bootstrap install metadata without leaking secrets on list', async () => {
  await withApiServer(async (baseUrl) => {
    const adminCookie = await createUserAndSession(baseUrl, 'connector-admin', 'admin')
    const alphaCookie = await createUserAndSession(baseUrl, 'connector-alpha', 'user', adminCookie)
    const betaCookie = await createUserAndSession(baseUrl, 'connector-beta', 'user', adminCookie)

    const alphaCreate = await postJson(
      `${baseUrl}/codex-api/connectors`,
      {
        id: 'alpha-laptop',
        name: 'Alpha Laptop',
        hubAddress: 'https://hub.example.test',
      },
      { Cookie: alphaCookie },
    )
    assert.equal(alphaCreate.status, 201)
    const alphaCreateBody = await alphaCreate.json()
    assert.equal(alphaCreateBody.data.connector.id, 'alpha-laptop')
    assert.equal(alphaCreateBody.data.connector.name, 'Alpha Laptop')
    assert.equal(alphaCreateBody.data.connector.hubAddress, 'https://hub.example.test')
    assert.equal(alphaCreateBody.data.connector.connected, false)
    assert.equal(alphaCreateBody.data.connector.installState, 'pending_install')
    assert.equal(typeof alphaCreateBody.data.connector.bootstrapExpiresAtIso, 'string')
    assert.equal(typeof alphaCreateBody.data.bootstrapToken, 'string')
    assert.ok(alphaCreateBody.data.bootstrapToken.length >= 24)

    const alphaListResponse = await fetch(`${baseUrl}/codex-api/connectors`, {
      headers: { Cookie: alphaCookie },
    })
    assert.equal(alphaListResponse.status, 200)
    const alphaListBody = await alphaListResponse.json()
    assert.deepEqual(
      alphaListBody.data.connectors.map((connector) => ({
        id: connector.id,
        name: connector.name,
        hubAddress: connector.hubAddress,
        connected: connector.connected,
        installState: connector.installState,
      })),
      [
        {
          id: 'alpha-laptop',
          name: 'Alpha Laptop',
          hubAddress: 'https://hub.example.test',
          connected: false,
          installState: 'pending_install',
        },
      ],
    )
    assert.equal(alphaListBody.data.connectors[0].token, undefined)
    assert.equal(alphaListBody.data.connectors[0].bootstrapToken, undefined)
    assert.equal(alphaListBody.data.connectors[0].installState, 'pending_install')
    assert.equal(typeof alphaListBody.data.connectors[0].bootstrapExpiresAtIso, 'string')

    const betaListResponse = await fetch(`${baseUrl}/codex-api/connectors`, {
      headers: { Cookie: betaCookie },
    })
    assert.equal(betaListResponse.status, 200)
    const betaListBody = await betaListResponse.json()
    assert.deepEqual(betaListBody.data.connectors, [])

    const anonymousList = await fetch(`${baseUrl}/codex-api/connectors`)
    assert.equal(anonymousList.status, 401)
  })
})
