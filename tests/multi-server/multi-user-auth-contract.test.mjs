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

test('multi-user auth contract supports public registration, admin approval, and admin authorization', async () => {
  await withApiServer(async (baseUrl) => {
    const adminSignup = await postJson(`${baseUrl}/auth/signup`, {
      username: 'admin-user',
      password: 'admin-pass-1',
      role: 'admin',
    })
    assert.equal(adminSignup.status, 201)
    const bootstrapCookie = adminSignup.headers.get('set-cookie')
    assert.ok(bootstrapCookie)

    const pendingRegistration = await postJson(`${baseUrl}/auth/register`, {
      username: 'pending-user',
      password: 'pending-pass-1',
    })
    assert.equal(pendingRegistration.status, 202)
    const pendingRegistrationBody = await pendingRegistration.json()
    assert.equal(pendingRegistrationBody.status, 'pending')

    const pendingLoginBeforeApproval = await postJson(`${baseUrl}/auth/login`, {
      username: 'pending-user',
      password: 'pending-pass-1',
    })
    assert.equal(pendingLoginBeforeApproval.status, 403)

    const adminLogin = await postJson(`${baseUrl}/auth/login`, {
      username: 'admin-user',
      password: 'admin-pass-1',
    })
    assert.equal(adminLogin.status, 200)
    const adminCookie = adminLogin.headers.get('set-cookie')
    assert.ok(adminCookie)

    const approvedMemberSignup = await postJson(
      `${baseUrl}/auth/signup`,
      {
        username: 'member-user',
        password: 'member-pass-1',
      },
      { Cookie: adminCookie },
    )
    assert.equal(approvedMemberSignup.status, 201)

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
      adminUserListBody.data.map((user) => ({ username: user.username, role: user.role, approvalStatus: user.approvalStatus })),
      [
        { username: 'admin-user', role: 'admin', approvalStatus: 'approved' },
        { username: 'member-user', role: 'user', approvalStatus: 'approved' },
        { username: 'pending-user', role: 'user', approvalStatus: 'pending' },
      ],
    )

    const pendingUser = adminUserListBody.data.find((user) => user.username === 'pending-user')
    assert.ok(pendingUser)

    const memberCannotApprove = await postJson(
      `${baseUrl}/codex-api/admin/users/${pendingUser.id}/approve`,
      {},
      { Cookie: memberCookie },
    )
    assert.equal(memberCannotApprove.status, 403)

    const approvePending = await postJson(
      `${baseUrl}/codex-api/admin/users/${pendingUser.id}/approve`,
      {},
      { Cookie: adminCookie },
    )
    assert.equal(approvePending.status, 200)
    const approvePendingBody = await approvePending.json()
    assert.equal(approvePendingBody.data.user.approvalStatus, 'approved')

    const pendingLoginAfterApproval = await postJson(`${baseUrl}/auth/login`, {
      username: 'pending-user',
      password: 'pending-pass-1',
    })
    assert.equal(pendingLoginAfterApproval.status, 200)
  })
})
