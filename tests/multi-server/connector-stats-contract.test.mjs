import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'

import { createMultiUserContractHttpHandler } from '../../scripts/testing/multi-user-contract-helpers.mjs'

async function withApiServer(run) {
  const server = createServer(createMultiUserContractHttpHandler())
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))

  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Failed to bind connector stats contract test server')
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

test('connector stats list includes project/thread counts for connected connectors', async () => {
  await withApiServer(async (baseUrl) => {
    const adminCookie = await createUserAndSession(baseUrl, 'stats-admin', 'admin')
    const alphaCookie = await createUserAndSession(baseUrl, 'stats-alpha', 'user', adminCookie)

    const createResponse = await postJson(
      `${baseUrl}/codex-api/connectors`,
      {
        id: 'stats-edge',
        name: 'Stats Edge',
        hubAddress: 'https://hub.example.test',
        mockStatus: {
          connected: true,
          projectCount: 2,
          threadCount: 3,
        },
      },
      { Cookie: alphaCookie },
    )
    assert.equal(createResponse.status, 201)

    const connectorsResponse = await fetch(`${baseUrl}/codex-api/connectors?includeStats=1`, {
      headers: { Cookie: alphaCookie },
    })
    assert.equal(connectorsResponse.status, 200)
    const connectorsBody = await connectorsResponse.json()

    assert.deepEqual(
      connectorsBody.data.connectors.map((connector) => ({
        id: connector.id,
        serverId: connector.serverId,
        connected: connector.connected,
        projectCount: connector.projectCount,
        threadCount: connector.threadCount,
        statsStale: connector.statsStale,
      })),
      [
        {
          id: 'stats-edge',
          serverId: 'stats-edge',
          connected: true,
          projectCount: 2,
          threadCount: 3,
          statsStale: false,
        },
      ],
    )
  })
})
