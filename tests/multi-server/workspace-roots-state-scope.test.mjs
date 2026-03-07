import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'

import { createMultiUserContractHttpHandler } from '../../scripts/testing/multi-user-contract-helpers.mjs'

async function withApiServer(run) {
  const server = createServer(createMultiUserContractHttpHandler())
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))

  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Failed to bind workspace roots scope test server')
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

async function putJson(url, payload, headers = {}) {
  return fetch(url, {
    method: 'PUT',
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

test('workspace roots state stays isolated per authenticated user and server id', async () => {
  await withApiServer(async (baseUrl) => {
    const adminCookie = await createUserAndSession(baseUrl, 'roots-admin', 'admin')
    const alphaCookie = await createUserAndSession(baseUrl, 'roots-alpha', 'user', adminCookie)
    const betaCookie = await createUserAndSession(baseUrl, 'roots-beta', 'user', adminCookie)

    for (const [cookie, label] of [[alphaCookie, 'Alpha'], [betaCookie, 'Beta']]) {
      const createPrimary = await postJson(
        `${baseUrl}/codex-api/servers`,
        { id: 'primary', name: `${label} Primary`, isDefault: true },
        { Cookie: cookie },
      )
      assert.equal(createPrimary.status, 201)

      const createSecondary = await postJson(
        `${baseUrl}/codex-api/servers`,
        { id: 'secondary', name: `${label} Secondary` },
        { Cookie: cookie },
      )
      assert.equal(createSecondary.status, 201)
    }

    const alphaPrimaryState = {
      order: ['/srv/alpha/project-a'],
      labels: { '/srv/alpha/project-a': 'alpha-project-a' },
      active: ['/srv/alpha/project-a'],
    }
    const alphaSecondaryState = {
      order: ['/srv/alpha/project-b'],
      labels: { '/srv/alpha/project-b': 'alpha-project-b' },
      active: ['/srv/alpha/project-b'],
    }
    const betaPrimaryState = {
      order: ['/srv/beta/project-main'],
      labels: { '/srv/beta/project-main': 'beta-project-main' },
      active: ['/srv/beta/project-main'],
    }

    const alphaPrimaryWrite = await putJson(
      `${baseUrl}/codex-api/workspace-roots-state?serverId=primary`,
      alphaPrimaryState,
      { Cookie: alphaCookie },
    )
    assert.equal(alphaPrimaryWrite.status, 200)

    const alphaSecondaryWrite = await putJson(
      `${baseUrl}/codex-api/workspace-roots-state?serverId=secondary`,
      alphaSecondaryState,
      { Cookie: alphaCookie },
    )
    assert.equal(alphaSecondaryWrite.status, 200)

    const betaPrimaryWrite = await putJson(
      `${baseUrl}/codex-api/workspace-roots-state?serverId=primary`,
      betaPrimaryState,
      { Cookie: betaCookie },
    )
    assert.equal(betaPrimaryWrite.status, 200)

    const alphaPrimaryRead = await fetch(`${baseUrl}/codex-api/workspace-roots-state?serverId=primary`, {
      headers: { Cookie: alphaCookie },
    })
    assert.equal(alphaPrimaryRead.status, 200)
    assert.deepEqual((await alphaPrimaryRead.json()).data, alphaPrimaryState)

    const alphaSecondaryRead = await fetch(`${baseUrl}/codex-api/workspace-roots-state?serverId=secondary`, {
      headers: { Cookie: alphaCookie },
    })
    assert.equal(alphaSecondaryRead.status, 200)
    assert.deepEqual((await alphaSecondaryRead.json()).data, alphaSecondaryState)

    const betaPrimaryRead = await fetch(`${baseUrl}/codex-api/workspace-roots-state?serverId=primary`, {
      headers: { Cookie: betaCookie },
    })
    assert.equal(betaPrimaryRead.status, 200)
    assert.deepEqual((await betaPrimaryRead.json()).data, betaPrimaryState)

    const betaSecondaryRead = await fetch(`${baseUrl}/codex-api/workspace-roots-state?serverId=secondary`, {
      headers: { Cookie: betaCookie },
    })
    assert.equal(betaSecondaryRead.status, 200)
    assert.deepEqual((await betaSecondaryRead.json()).data, { order: [], labels: {}, active: [] })
  })
})
