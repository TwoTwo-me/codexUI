import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

export const SESSION_COOKIE_NAME = 'codex_web_local_token'

const SERVER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u
const RELAY_AGENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u
const LEGACY_RELAY_AGENT_ID_PATTERN = /^agent:([A-Za-z0-9][A-Za-z0-9._-]{0,63})$/u
const RELAY_E2EE_KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u
const CONNECTOR_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u
const RELAY_E2EE_ALGORITHM = 'aes-256-gcm'
const DEFAULT_RELAY_PROTOCOL = 'relay-http-v1'
const DEFAULT_RELAY_TIMEOUT_MS = 60_000

function isLoopbackHostname(hostname) {
  const normalized = String(hostname ?? '').trim().toLowerCase().replace(/^\[/u, '').replace(/\]$/u, '')
  return normalized === 'localhost'
    || normalized === '::1'
    || normalized === '127.0.0.1'
    || normalized.startsWith('127.')
}

function normalizeHubAddress(value) {
  const rawValue = typeof value === 'string' ? value.trim() : ''
  if (!rawValue) return ''
  try {
    const parsed = new URL(rawValue)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return ''
    }
    if (parsed.protocol === 'http:' && !isLoopbackHostname(parsed.hostname)) {
      return ''
    }
    parsed.hash = ''
    parsed.search = ''
    parsed.pathname = parsed.pathname.replace(/\/+$/u, '') || '/'
    return parsed.toString().replace(/\/$/u, '')
  } catch {
    return ''
  }
}

function hashSecret(secret) {
  return createHash('sha256').update(secret).digest('hex')
}

function constantTimeCompare(a, b) {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  if (left.length !== right.length) {
    return false
  }
  return timingSafeEqual(left, right)
}

function parseJsonBody(body) {
  const text = typeof body === 'string' ? body.trim() : ''
  if (!text) {
    return null
  }

  return JSON.parse(text)
}

function parseCookies(cookieHeader) {
  const cookies = {}
  if (!cookieHeader) return cookies

  for (const pair of cookieHeader.split(';')) {
    const separator = pair.indexOf('=')
    if (separator === -1) continue
    const key = pair.slice(0, separator).trim()
    const value = pair.slice(separator + 1).trim()
    if (!key) continue
    cookies[key] = value
  }

  return cookies
}

function getHeaderValue(headers, name) {
  const target = name.toLowerCase()

  for (const [headerName, headerValue] of Object.entries(headers ?? {})) {
    if (headerName.toLowerCase() !== target) continue
    if (Array.isArray(headerValue)) {
      return headerValue.join(', ')
    }
    if (typeof headerValue === 'string') {
      return headerValue
    }
  }

  return ''
}

function jsonResponse(status, payload, headers = {}) {
  return {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...headers,
    },
    body: JSON.stringify(payload),
  }
}

function cloneRegistry(registry) {
  return {
    defaultServerId: registry.defaultServerId,
    servers: registry.servers.map((server) => ({
      ...server,
      ...(server.relay ? { relay: { ...server.relay } } : {}),
    })),
  }
}

function asRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value
    : null
}

function clampTimeoutMs(value) {
  if (!Number.isFinite(value)) return DEFAULT_RELAY_TIMEOUT_MS
  const normalized = Math.trunc(value)
  if (normalized < 5_000) return 5_000
  if (normalized > 300_000) return 300_000
  return normalized
}

function normalizeServerTransport(value) {
  return value === 'relay' ? 'relay' : 'local'
}

function normalizeRelayAgentId(value) {
  const raw = typeof value === 'string' ? value.trim() : ''
  if (!raw) return ''
  if (RELAY_AGENT_ID_PATTERN.test(raw)) return raw
  const legacyMatch = LEGACY_RELAY_AGENT_ID_PATTERN.exec(raw)
  return legacyMatch?.[1] ?? ''
}

function normalizeRelayE2eeConfig(value) {
  if (value === undefined || value === null) return undefined
  const record = asRecord(value)
  if (!record) return null

  const enabled = record.enabled !== false
  if (!enabled) return undefined

  const keyId = typeof record.keyId === 'string' ? record.keyId.trim() : ''
  if (!keyId || !RELAY_E2EE_KEY_ID_PATTERN.test(keyId)) {
    return null
  }

  const algorithm = typeof record.algorithm === 'string' ? record.algorithm.trim().toLowerCase() : ''
  if (algorithm && algorithm !== RELAY_E2EE_ALGORITHM) {
    return null
  }

  return {
    keyId,
    algorithm: RELAY_E2EE_ALGORITHM,
  }
}

function normalizeRelayConfig(value) {
  const record = asRecord(value)
  if (!record) return null

  const agentId = normalizeRelayAgentId(record.agentId)
  if (!agentId) {
    return null
  }

  const protocol = typeof record.protocol === 'string' && record.protocol.trim().length > 0
    ? record.protocol.trim()
    : DEFAULT_RELAY_PROTOCOL
  const requestTimeoutMs = clampTimeoutMs(Number(record.requestTimeoutMs))
  const e2ee = normalizeRelayE2eeConfig(record.e2ee)
  if (record.e2ee !== undefined && e2ee === null) {
    return null
  }

  return {
    agentId,
    protocol,
    requestTimeoutMs,
    ...(e2ee ? { e2ee } : {}),
  }
}

function normalizeSignupRole(rawRole) {
  if (rawRole === 'admin') return 'admin'
  return 'user'
}

function publicUserRecord(user) {
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    createdAtIso: user.createdAtIso,
    updatedAtIso: user.updatedAtIso,
    ...(user.lastLoginAtIso ? { lastLoginAtIso: user.lastLoginAtIso } : {}),
  }
}

export function createMultiUserContractApi() {
  let nextUserNumber = 1
  let nextSessionNumber = 1
  let nextConnectorNumber = 1

  const usersByUsername = new Map()
  const sessionsByToken = new Map()
  const registryByUserId = new Map()
  const connectorsByUserId = new Map()

  function resolveSessionUser(headers) {
    const cookieHeader = getHeaderValue(headers, 'cookie')
    const cookies = parseCookies(cookieHeader)
    const token = cookies[SESSION_COOKIE_NAME]
    if (!token) {
      return null
    }

    const session = sessionsByToken.get(token)
    if (!session) {
      return null
    }

    return usersByUsername.get(session.username) ?? null
  }

  function getOrCreateRegistry(userId) {
    const existing = registryByUserId.get(userId)
    if (existing) {
      return existing
    }

    const created = {
      defaultServerId: '',
      servers: [],
    }
    registryByUserId.set(userId, created)
    return created
  }

  function getConnectorRegistry(userId) {
    const existing = connectorsByUserId.get(userId)
    if (existing) {
      return existing
    }
    const created = []
    connectorsByUserId.set(userId, created)
    return created
  }

  function upsertConnectorServer(userId, connector) {
    const registry = getOrCreateRegistry(userId)
    const existingIndex = registry.servers.findIndex((server) => server.id === connector.serverId)
    const server = {
      id: connector.serverId,
      name: connector.name,
      transport: 'relay',
      relay: {
        agentId: connector.relayAgentId,
        protocol: DEFAULT_RELAY_PROTOCOL,
        requestTimeoutMs: DEFAULT_RELAY_TIMEOUT_MS,
      },
      createdAtIso: existingIndex >= 0 ? registry.servers[existingIndex].createdAtIso : connector.createdAtIso,
      updatedAtIso: connector.updatedAtIso,
    }
    if (existingIndex >= 0) {
      registry.servers[existingIndex] = server
    } else {
      registry.servers.push(server)
    }
    if (!registry.defaultServerId) {
      registry.defaultServerId = connector.serverId
    }
  }

  function removeConnectorServer(userId, serverId) {
    const registry = getOrCreateRegistry(userId)
    registry.servers = registry.servers.filter((server) => server.id !== serverId)
    if (registry.defaultServerId === serverId) {
      registry.defaultServerId = registry.servers[0]?.id ?? ''
    }
  }

  async function handleRequest(request) {
    const method = typeof request?.method === 'string' ? request.method.toUpperCase() : 'GET'
    const path = typeof request?.path === 'string' ? request.path : '/'
    const url = new URL(path, 'http://localhost')

    try {
      if (method === 'POST' && url.pathname === '/auth/signup') {
        const currentUser = resolveSessionUser(request?.headers)
        const payload = parseJsonBody(request?.body)
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
          return jsonResponse(400, { error: 'Invalid body: expected object' })
        }

        const username = typeof payload.username === 'string' ? payload.username.trim() : ''
        const password = typeof payload.password === 'string' ? payload.password : ''
        const allowBootstrapSignup = usersByUsername.size === 0

        if (!username || !password) {
          return jsonResponse(400, { error: 'Missing username or password' })
        }

        if (!allowBootstrapSignup) {
          if (!currentUser) {
            return jsonResponse(401, { error: 'Authentication required' })
          }
          if (currentUser.role !== 'admin') {
            return jsonResponse(403, { error: 'Only admins can create users' })
          }
        }

        const role = allowBootstrapSignup ? 'admin' : normalizeSignupRole(payload.role)
        if (usersByUsername.has(username)) {
          return jsonResponse(409, { error: `User "${username}" already exists` })
        }

        const nowIso = new Date().toISOString()
        const user = {
          id: `user-${String(nextUserNumber)}`,
          username,
          role,
          passwordHash: hashSecret(password),
          createdAtIso: nowIso,
          updatedAtIso: nowIso,
        }
        nextUserNumber += 1
        usersByUsername.set(username, user)

        let responseHeaders = {}
        if (!currentUser) {
          const bootstrapToken = `bootstrap-${randomBytes(8).toString('hex')}`
          responseHeaders = {
            'Set-Cookie': `${SESSION_COOKIE_NAME}=${bootstrapToken}; Path=/; HttpOnly; SameSite=Strict`,
          }
          sessionsByToken.set(bootstrapToken, {
            username: user.username,
            createdAtIso: nowIso,
          })
        }

        return jsonResponse(201, { ok: true, user: publicUserRecord(user) }, responseHeaders)
      }

      if (method === 'POST' && url.pathname === '/auth/login') {
        const payload = parseJsonBody(request?.body)
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
          return jsonResponse(400, { error: 'Invalid body: expected object' })
        }

        const username = typeof payload.username === 'string' ? payload.username.trim() : ''
        const password = typeof payload.password === 'string' ? payload.password : ''

        const user = usersByUsername.get(username)
        const validPassword = user ? constantTimeCompare(hashSecret(password), user.passwordHash) : false
        if (!user || !validPassword) {
          return jsonResponse(401, { error: 'Invalid credentials' })
        }

        const token = `session-${String(nextSessionNumber)}-${randomBytes(8).toString('hex')}`
        nextSessionNumber += 1
        sessionsByToken.set(token, {
          username: user.username,
          createdAtIso: new Date().toISOString(),
        })
        user.lastLoginAtIso = new Date().toISOString()
        user.updatedAtIso = user.lastLoginAtIso

        return jsonResponse(
          200,
          { ok: true, user: publicUserRecord(user) },
          { 'Set-Cookie': `${SESSION_COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Strict` },
        )
      }

      if (method === 'GET' && url.pathname === '/auth/session') {
        const user = resolveSessionUser(request?.headers)
        if (!user) {
          return jsonResponse(200, { authenticated: false })
        }

        return jsonResponse(200, { authenticated: true, user: publicUserRecord(user) })
      }

      if (method === 'GET' && url.pathname === '/codex-api/admin/users') {
        const user = resolveSessionUser(request?.headers)
        if (!user) {
          return jsonResponse(401, { error: 'Authentication required' })
        }
        if (user.role !== 'admin') {
          return jsonResponse(403, { error: 'Admin role required' })
        }

        const users = Array.from(usersByUsername.values()).map(publicUserRecord)
        return jsonResponse(200, { data: users })
      }

      if (url.pathname === '/codex-api/admin/users') {
        return jsonResponse(405, { error: 'Method not allowed' })
      }

      const serverMatch = url.pathname.match(/^\/codex-api\/servers\/([^/]+)$/u)
      const connectorMatch = url.pathname.match(/^\/codex-api\/connectors\/([^/]+)(?:\/([^/]+))?$/u)

      if (url.pathname === '/codex-api/servers') {
        const user = resolveSessionUser(request?.headers)
        if (!user) {
          return jsonResponse(401, { error: 'Unauthorized' })
        }

        if (method === 'GET') {
          const state = getOrCreateRegistry(user.id)
          return jsonResponse(200, { data: cloneRegistry(state) })
        }

        if (method === 'POST') {
          const payload = parseJsonBody(request?.body)
          if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
            return jsonResponse(400, { error: 'Invalid body: expected object' })
          }

          const state = getOrCreateRegistry(user.id)
          const existingIds = new Set(state.servers.map((server) => server.id))

          const providedServerId = typeof payload.id === 'string' ? payload.id.trim() : ''
          if (!providedServerId) {
            return jsonResponse(400, { error: 'Explicit server id is required' })
          }
          if (!SERVER_ID_PATTERN.test(providedServerId)) {
            return jsonResponse(400, { error: `Invalid server id "${providedServerId}"` })
          }
          if (existingIds.has(providedServerId)) {
            return jsonResponse(409, { error: `Server "${providedServerId}" already exists` })
          }

          const nowIso = new Date().toISOString()
          const transport = normalizeServerTransport(payload.transport)
          const relay = normalizeRelayConfig(payload.relay)
          if (transport === 'relay' && !relay) {
            return jsonResponse(400, { error: 'Relay transport requires relay.agentId' })
          }
          const nextServer = {
            id: providedServerId,
            name: typeof payload.name === 'string' && payload.name.trim().length > 0
              ? payload.name.trim()
              : `Server ${String(state.servers.length + 1)}`,
            transport,
            ...(transport === 'relay' && relay ? { relay } : {}),
            createdAtIso: nowIso,
            updatedAtIso: nowIso,
          }

          const makeDefault = payload.isDefault === true || payload.makeDefault === true || payload.default === true
          const nextState = {
            defaultServerId: makeDefault || state.defaultServerId.trim().length === 0 ? nextServer.id : state.defaultServerId,
            servers: [...state.servers, nextServer],
          }
          registryByUserId.set(user.id, nextState)

          return jsonResponse(201, {
            data: {
              server: { ...nextServer },
              registry: cloneRegistry(nextState),
            },
          })
        }

        return jsonResponse(405, { error: 'Method not allowed' })
      }

      if (url.pathname === '/codex-api/connectors') {
        const user = resolveSessionUser(request?.headers)
        if (!user) {
          return jsonResponse(401, { error: 'Unauthorized' })
        }

        if (method === 'GET') {
          const includeStats = ['1', 'true', 'yes'].includes((url.searchParams.get('includeStats') ?? '').trim().toLowerCase())
          const connectors = getConnectorRegistry(user.id).map((connector) => ({
            id: connector.id,
            serverId: connector.serverId,
            name: connector.name,
            hubAddress: connector.hubAddress,
            relayAgentId: connector.relayAgentId,
            ...(connector.relayE2eeKeyId ? { relayE2eeKeyId: connector.relayE2eeKeyId } : {}),
            createdAtIso: connector.createdAtIso,
            updatedAtIso: connector.updatedAtIso,
            connected: connector.connected === true,
            ...(includeStats && connector.lastKnownProjectCount !== undefined ? { projectCount: connector.lastKnownProjectCount } : {}),
            ...(includeStats && connector.lastKnownThreadCount !== undefined ? { threadCount: connector.lastKnownThreadCount } : {}),
            ...(includeStats && connector.lastStatsAtIso ? { lastStatsAtIso: connector.lastStatsAtIso } : {}),
            ...(includeStats ? { statsStale: connector.connected === true ? false : connector.lastStatsAtIso !== undefined } : {}),
          }))
          return jsonResponse(200, { data: { connectors } })
        }

        if (method === 'POST') {
          const payload = parseJsonBody(request?.body)
          if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
            return jsonResponse(400, { error: 'Invalid body: expected object' })
          }

          const connectorId = typeof payload.id === 'string' ? payload.id.trim() : ''
          if (!connectorId) {
            return jsonResponse(400, { error: 'Explicit connector id is required' })
          }
          if (!CONNECTOR_ID_PATTERN.test(connectorId)) {
            return jsonResponse(400, { error: `Invalid connector id "${connectorId}"` })
          }

          const connectors = getConnectorRegistry(user.id)
          if (connectors.some((connector) => connector.id === connectorId)) {
            return jsonResponse(409, { error: `Connector "${connectorId}" already exists` })
          }

          const name = typeof payload.name === 'string' && payload.name.trim().length > 0
            ? payload.name.trim()
            : `Connector ${String(connectors.length + 1)}`
          const hubAddress = normalizeHubAddress(payload.hubAddress)
          if (!hubAddress) {
            return jsonResponse(400, { error: 'Valid hubAddress is required. Use HTTPS for non-local hubs.' })
          }
          const nowIso = new Date().toISOString()
          const token = `connector-token-${randomBytes(12).toString('hex')}`
          const connector = {
            id: connectorId,
            serverId: connectorId,
            name,
            hubAddress,
            relayAgentId: `agent-${String(nextConnectorNumber)}`,
            createdAtIso: nowIso,
            updatedAtIso: nowIso,
            tokenHash: hashSecret(token),
            connected: payload.mockStatus?.connected === true,
            lastKnownProjectCount: Number.isFinite(Number(payload.mockStatus?.projectCount))
              ? Math.max(0, Math.trunc(Number(payload.mockStatus.projectCount)))
              : undefined,
            lastKnownThreadCount: Number.isFinite(Number(payload.mockStatus?.threadCount))
              ? Math.max(0, Math.trunc(Number(payload.mockStatus.threadCount)))
              : undefined,
            lastStatsAtIso: payload.mockStatus ? nowIso : undefined,
          }
          nextConnectorNumber += 1
          connectors.push(connector)
          upsertConnectorServer(user.id, connector)

          return jsonResponse(201, {
            data: {
              connector: {
                id: connector.id,
                serverId: connector.serverId,
                name: connector.name,
                hubAddress: connector.hubAddress,
                relayAgentId: connector.relayAgentId,
                createdAtIso: connector.createdAtIso,
                updatedAtIso: connector.updatedAtIso,
                connected: false,
              },
              token,
            },
          })
        }

        return jsonResponse(405, { error: 'Method not allowed' })
      }

      if (connectorMatch) {
        const user = resolveSessionUser(request?.headers)
        if (!user) {
          return jsonResponse(401, { error: 'Unauthorized' })
        }
        const connectorId = connectorMatch[1]
        const action = connectorMatch[2] ?? null
        if (!CONNECTOR_ID_PATTERN.test(connectorId)) {
          return jsonResponse(400, { error: `Invalid connector id "${connectorId}"` })
        }
        const connectors = getConnectorRegistry(user.id)
        const connectorIndex = connectors.findIndex((connector) => connector.id === connectorId)
        if (connectorIndex === -1) {
          return jsonResponse(404, { error: `Connector "${connectorId}" not found` })
        }
        const current = connectors[connectorIndex]

        if (method === 'PATCH' && action === null) {
          const payload = parseJsonBody(request?.body)
          if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
            return jsonResponse(400, { error: 'Invalid body: expected object' })
          }
          if ('name' in payload && typeof payload.name !== 'string') {
            return jsonResponse(400, { error: 'Invalid body: "name" must be a string' })
          }
          const next = {
            ...current,
            name: typeof payload.name === 'string' && payload.name.trim().length > 0 ? payload.name.trim() : current.name,
            updatedAtIso: new Date().toISOString(),
          }
          connectors[connectorIndex] = next
          upsertConnectorServer(user.id, next)
          return jsonResponse(200, {
            data: {
              connector: {
                id: next.id,
                serverId: next.serverId,
                name: next.name,
                hubAddress: next.hubAddress,
                relayAgentId: next.relayAgentId,
                createdAtIso: next.createdAtIso,
                updatedAtIso: next.updatedAtIso,
                connected: false,
              },
            },
          })
        }

        if (method === 'POST' && action === 'rotate-token') {
          const token = `connector-token-${randomBytes(12).toString('hex')}`
          const next = {
            ...current,
            tokenHash: hashSecret(token),
            updatedAtIso: new Date().toISOString(),
          }
          connectors[connectorIndex] = next
          return jsonResponse(200, {
            data: {
              connector: {
                id: next.id,
                serverId: next.serverId,
                name: next.name,
                hubAddress: next.hubAddress,
                relayAgentId: next.relayAgentId,
                createdAtIso: next.createdAtIso,
                updatedAtIso: next.updatedAtIso,
                connected: false,
              },
              token,
            },
          })
        }

        if (method === 'DELETE' && action === null) {
          connectors.splice(connectorIndex, 1)
          removeConnectorServer(user.id, current.serverId)
          return jsonResponse(200, {
            ok: true,
            data: {
              connectors: connectors.map((connector) => ({
                id: connector.id,
                serverId: connector.serverId,
                name: connector.name,
                hubAddress: connector.hubAddress,
                relayAgentId: connector.relayAgentId,
                createdAtIso: connector.createdAtIso,
                updatedAtIso: connector.updatedAtIso,
                connected: false,
                ...(connector.lastKnownProjectCount !== undefined ? { projectCount: connector.lastKnownProjectCount } : {}),
                ...(connector.lastKnownThreadCount !== undefined ? { threadCount: connector.lastKnownThreadCount } : {}),
                ...(connector.lastStatsAtIso ? { lastStatsAtIso: connector.lastStatsAtIso } : {}),
                statsStale: connector.connected === true ? false : connector.lastStatsAtIso !== undefined,
              })),
            },
          })
        }

        return jsonResponse(405, { error: 'Method not allowed' })
      }

      if (serverMatch) {
        const user = resolveSessionUser(request?.headers)
        if (!user) {
          return jsonResponse(401, { error: 'Unauthorized' })
        }

        const serverId = serverMatch[1]
        if (!SERVER_ID_PATTERN.test(serverId)) {
          return jsonResponse(400, { error: `Invalid server id "${serverId}"` })
        }

        const state = getOrCreateRegistry(user.id)
        const server = state.servers.find((entry) => entry.id === serverId)
        if (!server) {
          return jsonResponse(404, { error: `Server "${serverId}" not found` })
        }

        if (method === 'DELETE') {
          const remainingServers = state.servers.filter((entry) => entry.id !== serverId)
          const nextState = {
            defaultServerId: remainingServers.length === 0
              ? ''
              : state.defaultServerId === serverId
                ? remainingServers[0].id
                : state.defaultServerId,
            servers: remainingServers,
          }
          registryByUserId.set(user.id, nextState)
          return jsonResponse(200, { ok: true, data: cloneRegistry(nextState) })
        }

        return jsonResponse(405, { error: 'Method not allowed' })
      }

      return jsonResponse(404, { error: 'Not found' })
    } catch {
      return jsonResponse(400, { error: 'Invalid JSON body' })
    }
  }

  return {
    handleRequest,
  }
}

export function createMultiUserContractHttpHandler() {
  const api = createMultiUserContractApi()

  return async (req, res) => {
    try {
      let body = ''
      req.setEncoding('utf8')

      for await (const chunk of req) {
        body += chunk
      }

      const response = await api.handleRequest({
        method: req.method,
        path: req.url,
        headers: req.headers,
        body,
      })

      res.statusCode = response.status
      for (const [headerName, headerValue] of Object.entries(response.headers)) {
        res.setHeader(headerName, headerValue)
      }
      res.end(response.body)
    } catch {
      res.statusCode = 500
      res.setHeader('Content-Type', 'application/json; charset=utf-8')
      res.end(JSON.stringify({ error: 'Unexpected test helper failure' }))
    }
  }
}
