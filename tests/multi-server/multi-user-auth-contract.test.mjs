import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'

import { createMultiUserContractHttpHandler } from '../../scripts/testing/multi-user-contract-helpers.mjs'

async function withApiServer(run) {
  const server = createServer(createMultiUserContractHttpHandler())
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))

  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Failed to bind multi-user contract test server')
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

test('multi-user auth contract supports signup/login/session/admin authorization', async () => {
  await withApiServer(async (baseUrl) => {
    const adminSignup = await postJson(`${baseUrl}/auth/signup`, {
      username: 'admin-user',
      password: 'admin-pass-1',
      role: 'admin',
    })
    assert.equal(adminSignup.status, 201)
    const bootstrapCookie = adminSignup.headers.get('set-cookie')
    assert.ok(bootstrapCookie)

    const anonymousMemberSignup = await postJson(`${baseUrl}/auth/signup`, {
      username: 'anonymous-member',
      password: 'anonymous-member-pass-1',
    })
    assert.equal(anonymousMemberSignup.status, 401)

    const adminLogin = await postJson(`${baseUrl}/auth/login`, {
      username: 'admin-user',
      password: 'admin-pass-1',
    })
    assert.equal(adminLogin.status, 200)
    const adminCookie = adminLogin.headers.get('set-cookie')
    assert.ok(adminCookie)

    const memberSignup = await postJson(
      `${baseUrl}/auth/signup`,
      {
        username: 'member-user',
        password: 'member-pass-1',
      },
      { Cookie: adminCookie },
    )
    assert.equal(memberSignup.status, 201)

    const memberLogin = await postJson(`${baseUrl}/auth/login`, {
      username: 'member-user',
      password: 'member-pass-1',
    })
    assert.equal(memberLogin.status, 200)
    const memberCookie = memberLogin.headers.get('set-cookie')
    assert.ok(memberCookie)

    const memberCannotCreateUsers = await postJson(
      `${baseUrl}/auth/signup`,
      {
        username: 'member-created-user',
        password: 'member-created-pass-1',
      },
      { Cookie: memberCookie },
    )
    assert.equal(memberCannotCreateUsers.status, 403)

    const adminSession = await fetch(`${baseUrl}/auth/session`, {
      headers: { Cookie: adminCookie },
    })
    assert.equal(adminSession.status, 200)
    const adminSessionBody = await adminSession.json()
    assert.equal(adminSessionBody.authenticated, true)
    assert.equal(adminSessionBody.user.username, 'admin-user')
    assert.equal(adminSessionBody.user.role, 'admin')

    const memberSession = await fetch(`${baseUrl}/auth/session`, {
      headers: { Cookie: memberCookie },
    })
    assert.equal(memberSession.status, 200)
    const memberSessionBody = await memberSession.json()
    assert.equal(memberSessionBody.authenticated, true)
    assert.equal(memberSessionBody.user.username, 'member-user')
    assert.equal(memberSessionBody.user.role, 'user')

    const anonymousSession = await fetch(`${baseUrl}/auth/session`)
    assert.equal(anonymousSession.status, 200)
    const anonymousSessionBody = await anonymousSession.json()
    assert.equal(anonymousSessionBody.authenticated, false)

    const anonymousAdminList = await fetch(`${baseUrl}/codex-api/admin/users`)
    assert.equal(anonymousAdminList.status, 401)

    const memberAdminList = await fetch(`${baseUrl}/codex-api/admin/users`, {
      headers: { Cookie: memberCookie },
    })
    assert.equal(memberAdminList.status, 403)

    const adminUserList = await fetch(`${baseUrl}/codex-api/admin/users`, {
      headers: { Cookie: adminCookie },
    })
    assert.equal(adminUserList.status, 200)
    const adminUserListBody = await adminUserList.json()

    assert.deepEqual(
      adminUserListBody.data.map((user) => ({ username: user.username, role: user.role })),
      [
        { username: 'admin-user', role: 'admin' },
        { username: 'member-user', role: 'user' },
      ],
    )
  })
})
