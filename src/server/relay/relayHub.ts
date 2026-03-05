import { createHash, randomBytes } from 'node:crypto'
import {
  RELAY_PROTOCOL,
  RELAY_PROTOCOL_VERSION,
  type RelayChannelId,
  type RelayEventEnvelope,
  type RelayRequestEnvelope,
  type RelayResponseEnvelope,
} from '../../types/relayProtocol.js'

const DEFAULT_PULL_WAIT_MS = 25_000
const MAX_PULL_WAIT_MS = 25_000
const MIN_RPC_TIMEOUT_MS = 5_000
const MAX_RPC_TIMEOUT_MS = 300_000
const DEFAULT_RPC_TIMEOUT_MS = 60_000
const MAX_PENDING_RPC = 2_000
const MAX_PENDING_RPC_PER_SCOPE = 512
const MAX_PENDING_RPC_PER_AGENT = 512
const MAX_SESSION_QUEUE = 512
const MAX_ALLOWED_ROUTES_PER_AGENT = 1_024

type RelayAgentRecord = {
  id: string
  name: string
  tokenHash: string
  createdAtIso: string
  updatedAtIso: string
  lastSeenAtIso?: string
}

type RelayAgentPublicRecord = {
  id: string
  name: string
  createdAtIso: string
  updatedAtIso: string
  connected: boolean
  lastSeenAtIso?: string
}

type RelaySession = {
  sessionId: string
  agentId: string
  tokenHash: string
  createdAtIso: string
  updatedAtIso: string
  queue: RelayRequestEnvelope[]
  waiter?: {
    resolve: (messages: RelayRequestEnvelope[]) => void
    timeoutHandle: NodeJS.Timeout
  }
}

type PendingRelayRpc = {
  resolve: (value: unknown) => void
  reject: (error: unknown) => void
  timeoutHandle: NodeJS.Timeout
  scopeKey: string
  agentId: string
}

type RelayRoute = {
  scopeKey: string
  serverId: string
  agentId: string
}

type RelayNotificationListener = (event: RelayEventEnvelope & { agentId: string }) => void

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

function createAgentId(): string {
  return `agent-${randomBytes(6).toString('hex')}`
}

function createSecretToken(): string {
  return randomBytes(32).toString('base64url')
}

function createSessionId(): string {
  return `session-${randomBytes(12).toString('hex')}`
}

function createRelayId(): string {
  return `relay-${randomBytes(12).toString('hex')}`
}

function clampTimeout(value: unknown, fallbackMs: number): number {
  const numeric = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(numeric)) return fallbackMs
  const normalized = Math.trunc(numeric)
  if (normalized < MIN_RPC_TIMEOUT_MS) return MIN_RPC_TIMEOUT_MS
  if (normalized > MAX_RPC_TIMEOUT_MS) return MAX_RPC_TIMEOUT_MS
  return normalized
}

function clampPullWaitMs(value: unknown): number {
  const numeric = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(numeric)) return DEFAULT_PULL_WAIT_MS
  const normalized = Math.trunc(numeric)
  if (normalized < 0) return 0
  if (normalized > MAX_PULL_WAIT_MS) return MAX_PULL_WAIT_MS
  return normalized
}

function toPublicAgentRecord(agent: RelayAgentRecord, connected: boolean): RelayAgentPublicRecord {
  return {
    id: agent.id,
    name: agent.name,
    createdAtIso: agent.createdAtIso,
    updatedAtIso: agent.updatedAtIso,
    connected,
    ...(agent.lastSeenAtIso ? { lastSeenAtIso: agent.lastSeenAtIso } : {}),
  }
}

function toRouteKey(route: { scopeKey: string; serverId: string }): string {
  return `${route.scopeKey}::${route.serverId}`
}

function toAgentChannelId(agentId: string): RelayChannelId {
  return `agent:${agentId}`
}

export class RelayHubError extends Error {
  readonly code: string
  readonly statusCode: number

  constructor(code: string, message: string, statusCode = 400) {
    super(message)
    this.code = code
    this.statusCode = statusCode
  }
}

export class OutboundRelayHub {
  private readonly agentsById = new Map<string, RelayAgentRecord>()
  private readonly sessionById = new Map<string, RelaySession>()
  private readonly sessionIdByAgentId = new Map<string, string>()
  private readonly pendingRpcById = new Map<string, PendingRelayRpc>()
  private readonly pendingRpcCountByScopeKey = new Map<string, number>()
  private readonly pendingRpcCountByAgentId = new Map<string, number>()
  private readonly listenersByRouteKey = new Map<string, Set<RelayNotificationListener>>()
  private readonly allowedRoutesByAgentId = new Map<string, Set<string>>()

  listAgents(): RelayAgentPublicRecord[] {
    return Array.from(this.agentsById.values())
      .map((agent) => toPublicAgentRecord(agent, this.sessionIdByAgentId.has(agent.id)))
      .sort((left, right) => left.name.localeCompare(right.name))
  }

  createAgent(name?: string): { agent: RelayAgentPublicRecord; token: string } {
    const nowIso = new Date().toISOString()
    const token = createSecretToken()
    const tokenHash = hashToken(token)
    let id = createAgentId()
    while (this.agentsById.has(id)) {
      id = createAgentId()
    }

    const normalizedName = typeof name === 'string' && name.trim().length > 0
      ? name.trim()
      : `Relay Agent ${String(this.agentsById.size + 1)}`

    const record: RelayAgentRecord = {
      id,
      name: normalizedName,
      tokenHash,
      createdAtIso: nowIso,
      updatedAtIso: nowIso,
    }
    this.agentsById.set(id, record)

    return {
      agent: toPublicAgentRecord(record, false),
      token,
    }
  }

  connectWithToken(token: string): { sessionId: string; pollTimeoutMs: number; agent: RelayAgentPublicRecord } {
    const { agent: matchedAgent, tokenHash } = this.resolveAgentByToken(token)

    const previousSessionId = this.sessionIdByAgentId.get(matchedAgent.id)
    if (previousSessionId) {
      this.disposeSession(previousSessionId)
    }

    const nowIso = new Date().toISOString()
    const session: RelaySession = {
      sessionId: createSessionId(),
      agentId: matchedAgent.id,
      tokenHash,
      createdAtIso: nowIso,
      updatedAtIso: nowIso,
      queue: [],
    }
    this.sessionById.set(session.sessionId, session)
    this.sessionIdByAgentId.set(matchedAgent.id, session.sessionId)

    matchedAgent.updatedAtIso = nowIso
    matchedAgent.lastSeenAtIso = nowIso

    return {
      sessionId: session.sessionId,
      pollTimeoutMs: DEFAULT_PULL_WAIT_MS,
      agent: toPublicAgentRecord(matchedAgent, true),
    }
  }

  pullMessagesAuthenticated(token: string, sessionId: string, waitMsRaw?: unknown): Promise<RelayRequestEnvelope[]> {
    const session = this.authenticateSession(token, sessionId)

    const waitMs = clampPullWaitMs(waitMsRaw)
    this.touchSession(session)

    if (session.queue.length > 0 || waitMs === 0) {
      return Promise.resolve(this.flushSessionQueue(session))
    }

    if (session.waiter) {
      clearTimeout(session.waiter.timeoutHandle)
      session.waiter.resolve([])
      session.waiter = undefined
    }

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        session.waiter = undefined
        resolve(this.flushSessionQueue(session))
      }, waitMs)

      const handleQueue = (messages: RelayRequestEnvelope[]) => {
        clearTimeout(timeout)
        session.waiter = undefined
        resolve(messages)
      }

      session.waiter = {
        resolve: handleQueue,
        timeoutHandle: timeout,
      }
    })
  }

  pushMessagesAuthenticated(token: string, sessionId: string, rawMessages: unknown[]): { accepted: number } {
    const session = this.authenticateSession(token, sessionId)

    this.touchSession(session)
    let accepted = 0
    for (const item of rawMessages) {
      const record = asRecord(item)
      if (!record) continue

      const kind = typeof record.kind === 'string' ? record.kind : ''
      if (kind === 'response') {
        if (this.acceptResponseEnvelope(record, session.agentId)) {
          accepted += 1
        }
        continue
      }

      if (kind === 'event') {
        if (this.acceptEventEnvelope(record, session.agentId)) {
          accepted += 1
        }
      }
    }

    return { accepted }
  }

  async dispatchRpc(
    route: RelayRoute,
    method: string,
    params: unknown,
    timeoutMsRaw?: unknown,
  ): Promise<unknown> {
    if (this.pendingRpcById.size >= MAX_PENDING_RPC) {
      throw new RelayHubError('relay_overloaded', 'Relay hub is overloaded', 503)
    }
    const pendingForScope = this.pendingRpcCountByScopeKey.get(route.scopeKey) ?? 0
    if (pendingForScope >= MAX_PENDING_RPC_PER_SCOPE) {
      throw new RelayHubError('relay_scope_overloaded', 'Relay scope is overloaded', 429)
    }
    const pendingForAgent = this.pendingRpcCountByAgentId.get(route.agentId) ?? 0
    if (pendingForAgent >= MAX_PENDING_RPC_PER_AGENT) {
      throw new RelayHubError('relay_agent_overloaded', `Relay agent "${route.agentId}" is overloaded`, 429)
    }

    const sessionId = this.sessionIdByAgentId.get(route.agentId)
    if (!sessionId) {
      throw new RelayHubError('relay_agent_offline', `Relay agent "${route.agentId}" is offline`, 503)
    }

    const session = this.sessionById.get(sessionId)
    if (!session) {
      this.sessionIdByAgentId.delete(route.agentId)
      throw new RelayHubError('relay_agent_offline', `Relay agent "${route.agentId}" is offline`, 503)
    }

    const relayId = createRelayId()
    const timeoutMs = clampTimeout(timeoutMsRaw, DEFAULT_RPC_TIMEOUT_MS)
    if (session.queue.length >= MAX_SESSION_QUEUE) {
      throw new RelayHubError('relay_backpressure', 'Relay agent queue is full', 429)
    }

    const routeKey = toRouteKey({ scopeKey: route.scopeKey, serverId: route.serverId })
    const allowedRoutes = this.allowedRoutesByAgentId.get(route.agentId) ?? new Set<string>()
    if (!allowedRoutes.has(routeKey) && allowedRoutes.size >= MAX_ALLOWED_ROUTES_PER_AGENT) {
      throw new RelayHubError('relay_backpressure', 'Relay route limit reached for this agent', 429)
    }
    allowedRoutes.add(routeKey)
    this.allowedRoutesByAgentId.set(route.agentId, allowedRoutes)

    const envelope: RelayRequestEnvelope = {
      protocol: RELAY_PROTOCOL,
      version: RELAY_PROTOCOL_VERSION,
      kind: 'request',
      relayId,
      route: {
        scopeKey: route.scopeKey,
        serverId: route.serverId,
        channelId: toAgentChannelId(route.agentId),
      },
      method,
      params: params ?? null,
      sentAtIso: new Date().toISOString(),
    }

    const resultPromise = new Promise<unknown>((resolve, reject) => {
      const timeoutHandle = setTimeout(() => {
        const timedOutPending = this.pendingRpcById.get(relayId)
        this.pendingRpcById.delete(relayId)
        if (timedOutPending) {
          this.decrementPendingCounters(timedOutPending.scopeKey, timedOutPending.agentId)
        }
        reject(new RelayHubError('relay_timeout', `Relay RPC timed out after ${String(timeoutMs)}ms`, 504))
      }, timeoutMs)

      this.pendingRpcById.set(relayId, {
        resolve,
        reject,
        timeoutHandle,
        scopeKey: route.scopeKey,
        agentId: route.agentId,
      })
      this.incrementPendingCounters(route.scopeKey, route.agentId)
    })

    session.queue.push(envelope)
    this.flushWaiters(session)
    return resultPromise
  }

  subscribeNotifications(route: { scopeKey: string; serverId: string }, listener: RelayNotificationListener): () => void {
    const routeKey = toRouteKey(route)
    const listeners = this.listenersByRouteKey.get(routeKey) ?? new Set<RelayNotificationListener>()
    listeners.add(listener)
    this.listenersByRouteKey.set(routeKey, listeners)

    return () => {
      const existing = this.listenersByRouteKey.get(routeKey)
      if (!existing) return
      existing.delete(listener)
      if (existing.size === 0) {
        this.listenersByRouteKey.delete(routeKey)
      }
    }
  }

  private resolveAgentByToken(token: string): { agent: RelayAgentRecord; tokenHash: string } {
    const normalized = token.trim()
    if (!normalized) {
      throw new RelayHubError('relay_auth_failed', 'Missing relay agent token', 401)
    }

    const tokenHash = hashToken(normalized)
    for (const agent of this.agentsById.values()) {
      if (agent.tokenHash === tokenHash) {
        return { agent, tokenHash }
      }
    }

    throw new RelayHubError('relay_auth_failed', 'Invalid relay agent token', 401)
  }

  private authenticateSession(token: string, sessionId: string): RelaySession {
    const { agent, tokenHash } = this.resolveAgentByToken(token)
    const session = this.sessionById.get(sessionId)
    if (!session || session.agentId !== agent.id || session.tokenHash !== tokenHash) {
      throw new RelayHubError('relay_invalid_session', 'Unknown relay session', 401)
    }
    return session
  }

  private touchSession(session: RelaySession): void {
    const nowIso = new Date().toISOString()
    session.updatedAtIso = nowIso
    const agent = this.agentsById.get(session.agentId)
    if (agent) {
      agent.updatedAtIso = nowIso
      agent.lastSeenAtIso = nowIso
    }
  }

  private flushSessionQueue(session: RelaySession): RelayRequestEnvelope[] {
    if (session.queue.length === 0) {
      return []
    }
    const messages = [...session.queue]
    session.queue = []
    return messages
  }

  private flushWaiters(session: RelaySession): void {
    if (!session.waiter || session.queue.length === 0) {
      return
    }

    const messages = this.flushSessionQueue(session)
    const waiter = session.waiter
    session.waiter = undefined
    clearTimeout(waiter.timeoutHandle)
    waiter.resolve(messages)
  }

  private incrementPendingCounters(scopeKey: string, agentId: string): void {
    this.pendingRpcCountByScopeKey.set(scopeKey, (this.pendingRpcCountByScopeKey.get(scopeKey) ?? 0) + 1)
    this.pendingRpcCountByAgentId.set(agentId, (this.pendingRpcCountByAgentId.get(agentId) ?? 0) + 1)
  }

  private decrementPendingCounters(scopeKey: string, agentId: string): void {
    const scopeCount = this.pendingRpcCountByScopeKey.get(scopeKey) ?? 0
    if (scopeCount <= 1) {
      this.pendingRpcCountByScopeKey.delete(scopeKey)
    } else {
      this.pendingRpcCountByScopeKey.set(scopeKey, scopeCount - 1)
    }

    const agentCount = this.pendingRpcCountByAgentId.get(agentId) ?? 0
    if (agentCount <= 1) {
      this.pendingRpcCountByAgentId.delete(agentId)
    } else {
      this.pendingRpcCountByAgentId.set(agentId, agentCount - 1)
    }
  }

  private rejectPendingRpcByAgent(agentId: string): void {
    for (const [relayId, pending] of this.pendingRpcById.entries()) {
      if (pending.agentId !== agentId) continue
      this.pendingRpcById.delete(relayId)
      clearTimeout(pending.timeoutHandle)
      this.decrementPendingCounters(pending.scopeKey, pending.agentId)
      pending.reject(new RelayHubError('relay_agent_offline', `Relay agent "${agentId}" disconnected`, 503))
    }
  }

  private acceptResponseEnvelope(record: Record<string, unknown>, agentId: string): boolean {
    const relayId = typeof record.relayId === 'string' ? record.relayId : ''
    if (!relayId) return false

    const pending = this.pendingRpcById.get(relayId)
    if (!pending) return false
    if (pending.agentId !== agentId) return false
    this.pendingRpcById.delete(relayId)
    clearTimeout(pending.timeoutHandle)
    this.decrementPendingCounters(pending.scopeKey, pending.agentId)

    const errorRecord = asRecord(record.error)
    if (errorRecord) {
      const errorMessage = typeof errorRecord.message === 'string' && errorRecord.message.length > 0
        ? errorRecord.message
        : 'Relay RPC failed'
      pending.reject(new RelayHubError('relay_remote_error', `[${agentId}] ${errorMessage}`, 502))
      return true
    }

    pending.resolve(record.result ?? null)
    return true
  }

  private acceptEventEnvelope(record: Record<string, unknown>, agentId: string): boolean {
    const route = asRecord(record.route)
    const scopeKey = typeof route?.scopeKey === 'string' ? route.scopeKey.trim() : ''
    const serverId = typeof route?.serverId === 'string' ? route.serverId.trim() : ''
    if (!scopeKey || !serverId) return false
    const routeChannelId = typeof route?.channelId === 'string' ? route.channelId.trim() : ''
    const expectedChannelId = toAgentChannelId(agentId)
    if (routeChannelId.length > 0 && routeChannelId !== expectedChannelId) {
      return false
    }

    const routeKey = toRouteKey({ scopeKey, serverId })
    const allowedRoutes = this.allowedRoutesByAgentId.get(agentId)
    if (!allowedRoutes || !allowedRoutes.has(routeKey)) {
      return false
    }

    const eventName = typeof record.event === 'string' && record.event.trim().length > 0
      ? record.event.trim()
      : 'relay/event'
    const params = record.params ?? null
    const sentAtIso = typeof record.sentAtIso === 'string' && record.sentAtIso.trim().length > 0
      ? record.sentAtIso.trim()
      : new Date().toISOString()

    const envelope: RelayEventEnvelope & { agentId: string } = {
      protocol: RELAY_PROTOCOL,
      version: RELAY_PROTOCOL_VERSION,
      kind: 'event',
      event: eventName,
      route: {
        scopeKey,
        serverId,
        channelId: expectedChannelId,
      },
      params,
      sentAtIso,
      agentId,
    }

    const listeners = this.listenersByRouteKey.get(routeKey)
    if (!listeners || listeners.size === 0) return true
    for (const listener of listeners) {
      listener(envelope)
    }
    return true
  }

  private disposeSession(sessionId: string): void {
    const session = this.sessionById.get(sessionId)
    if (!session) return
    this.sessionById.delete(sessionId)
    this.sessionIdByAgentId.delete(session.agentId)
    this.allowedRoutesByAgentId.delete(session.agentId)
    this.rejectPendingRpcByAgent(session.agentId)
    if (session.waiter) {
      clearTimeout(session.waiter.timeoutHandle)
      session.waiter.resolve([])
      session.waiter = undefined
    }
  }
}
