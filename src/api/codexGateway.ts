import {
  fetchCodexServers,
  fetchRpcMethodCatalog,
  fetchRpcNotificationCatalog,
  fetchPendingServerRequests,
  rpcCall,
  respondServerRequest,
  subscribeRpcNotifications,
  type RpcNotification,
} from './codexRpcClient'
import type {
  ConfigReadResponse,
  ModelListResponse,
  ReasoningEffort,
  ThreadListResponse,
  ThreadReadResponse,
} from './appServerDtos'
import { normalizeCodexApiError } from './codexErrors'
import { normalizeThreadGroupsV2, normalizeThreadMessagesV2 } from './normalizers/v2'
import type { UiMessage, UiProjectGroup } from '../types/codex'

type CurrentModelConfig = {
  model: string
  reasoningEffort: ReasoningEffort | ''
}

export type WorkspaceRootsState = {
  order: string[]
  labels: Record<string, string>
  active: string[]
}

export type CodexServerInfo = {
  id: string
  label: string
  description: string
  transport: 'local' | 'relay'
  relayAgentId?: string
  relayE2eeKeyId?: string
}

export type CodexServerDirectory = {
  defaultServerId: string
  servers: CodexServerInfo[]
}

export type CodexConnectorInfo = {
  id: string
  serverId: string
  name: string
  hubAddress: string
  relayAgentId: string
  relayE2eeKeyId?: string
  createdAtIso: string
  updatedAtIso: string
  installState: 'pending_install' | 'connected' | 'offline' | 'expired_bootstrap' | 'reinstall_required'
  bootstrapIssuedAtIso?: string
  bootstrapExpiresAtIso?: string
  bootstrapConsumedAtIso?: string
  credentialIssuedAtIso?: string
  connected: boolean
  lastSeenAtIso?: string
  projectCount?: number
  threadCount?: number
  lastStatsAtIso?: string
  statsStale?: boolean
}

export type ConnectorCreateInput = {
  id: string
  name: string
  hubAddress: string
  e2ee?: {
    enabled?: boolean
    keyId: string
  }
}

export type ConnectorCreateResult = {
  connector: CodexConnectorInfo
  bootstrapToken: string
}

export type ConnectorRotateTokenResult = {
  connector: CodexConnectorInfo
  bootstrapToken: string
}

let activeServerId = ''
const serverInfoById = new Map<string, CodexServerInfo>()
const relayE2eePassphraseByServerId = new Map<string, string>()

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function normalizeServerEntries(payload: unknown): CodexServerDirectory {
  const root = asRecord(payload)
  const defaultServerId = readString(root?.defaultServerId) || readString(root?.default_server_id)
  const rows = Array.isArray(payload)
    ? payload
    : Array.isArray(root?.servers)
      ? root.servers
      : []

  const servers: CodexServerInfo[] = []
  const seen = new Set<string>()

  for (const row of rows) {
    const record = asRecord(row)
    if (!record) continue

    const id = readString(record.id) || readString(record.serverId) || readString(record.server_id)
    const label = readString(record.label) || readString(record.name) || readString(record.title) || id
    const description = readString(record.description) || readString(record.details)
    const transport = readString(record.transport) === 'relay' ? 'relay' : 'local'
    const relay = asRecord(record.relay)
    const relayAgentId = readString(relay?.agentId)
    const relayE2ee = asRecord(relay?.e2ee)
    const relayE2eeKeyId = readString(relayE2ee?.keyId)
    const dedupeKey = id || label
    if (!dedupeKey || seen.has(dedupeKey)) continue
    seen.add(dedupeKey)

    servers.push({
      id,
      label: label || 'Default server',
      description,
      transport,
      ...(transport === 'relay' && relayAgentId ? { relayAgentId } : {}),
      ...(transport === 'relay' && relayE2eeKeyId ? { relayE2eeKeyId } : {}),
    })
  }

  return {
    defaultServerId,
    servers,
  }
}

function scopedServerOptions(): { serverId?: string; relayE2ee?: { keyId: string; passphrase: string } } {
  const options: {
    serverId?: string
    relayE2ee?: { keyId: string; passphrase: string }
  } = {}

  if (activeServerId) {
    options.serverId = activeServerId
  }

  const activeServer = activeServerId ? serverInfoById.get(activeServerId) : undefined
  if (activeServer?.relayE2eeKeyId) {
    const passphrase = relayE2eePassphraseByServerId.get(activeServer.id) ?? ''
    if (passphrase.length > 0) {
      options.relayE2ee = {
        keyId: activeServer.relayE2eeKeyId,
        passphrase,
      }
    }
  }

  return options
}

export function setActiveServerId(serverId: string): void {
  activeServerId = serverId.trim()
}

export function getActiveServerId(): string {
  return activeServerId
}

export async function getCodexServers(): Promise<CodexServerDirectory> {
  try {
    const payload = await fetchCodexServers()
    const normalized = normalizeServerEntries(payload)
    serverInfoById.clear()
    for (const server of normalized.servers) {
      if (server.id.length === 0) continue
      serverInfoById.set(server.id, server)
    }
    return normalized
  } catch (error) {
    throw normalizeCodexApiError(error, 'Failed to load servers', 'servers/list')
  }
}

export function setRelayE2eePassphrase(serverId: string, passphrase: string): void {
  const normalizedServerId = serverId.trim()
  if (!normalizedServerId) return
  if (passphrase.trim().length > 0) {
    relayE2eePassphraseByServerId.set(normalizedServerId, passphrase)
  } else {
    relayE2eePassphraseByServerId.delete(normalizedServerId)
  }
}

async function callRpc<T>(method: string, params?: unknown): Promise<T> {
  try {
    return await rpcCall<T>(method, params, scopedServerOptions())
  } catch (error) {
    throw normalizeCodexApiError(error, `RPC ${method} failed`, method)
  }
}

function normalizeReasoningEffort(value: unknown): ReasoningEffort | '' {
  const allowed: ReasoningEffort[] = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh']
  return typeof value === 'string' && allowed.includes(value as ReasoningEffort)
    ? (value as ReasoningEffort)
    : ''
}

async function getThreadGroupsV2(): Promise<UiProjectGroup[]> {
  const payload = await callRpc<ThreadListResponse>('thread/list', {
    archived: false,
    limit: 100,
    sortKey: 'updated_at',
  })
  return normalizeThreadGroupsV2(payload)
}

async function getThreadMessagesV2(threadId: string): Promise<UiMessage[]> {
  const payload = await callRpc<ThreadReadResponse>('thread/read', {
    threadId,
    includeTurns: true,
  })
  return normalizeThreadMessagesV2(payload)
}

export async function getThreadGroups(): Promise<UiProjectGroup[]> {
  try {
    return await getThreadGroupsV2()
  } catch (error) {
    throw normalizeCodexApiError(error, 'Failed to load thread groups', 'thread/list')
  }
}

export async function getThreadMessages(threadId: string): Promise<UiMessage[]> {
  try {
    return await getThreadMessagesV2(threadId)
  } catch (error) {
    throw normalizeCodexApiError(error, `Failed to load thread ${threadId}`, 'thread/read')
  }
}

export async function getMethodCatalog(): Promise<string[]> {
  return fetchRpcMethodCatalog(scopedServerOptions())
}

export async function getNotificationCatalog(): Promise<string[]> {
  return fetchRpcNotificationCatalog(scopedServerOptions())
}

export function subscribeCodexNotifications(onNotification: (value: RpcNotification) => void): () => void {
  return subscribeRpcNotifications(onNotification, scopedServerOptions())
}

export type { RpcNotification }

export async function replyToServerRequest(
  id: number,
  payload: { result?: unknown; error?: { code?: number; message: string } },
): Promise<void> {
  await respondServerRequest({
    id,
    ...payload,
  }, scopedServerOptions())
}

export async function getPendingServerRequests(): Promise<unknown[]> {
  return fetchPendingServerRequests(scopedServerOptions())
}

export async function resumeThread(threadId: string): Promise<void> {
  await callRpc('thread/resume', { threadId })
}

export async function archiveThread(threadId: string): Promise<void> {
  await callRpc('thread/archive', { threadId })
}

export async function rollbackThread(threadId: string, numTurns: number): Promise<UiMessage[]> {
  const payload = await callRpc<ThreadReadResponse>('thread/rollback', { threadId, numTurns })
  return normalizeThreadMessagesV2(payload)
}

function normalizeThreadIdFromPayload(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return ''
  const record = payload as Record<string, unknown>

  const thread = record.thread
  if (thread && typeof thread === 'object') {
    const threadId = (thread as Record<string, unknown>).id
    if (typeof threadId === 'string' && threadId.length > 0) {
      return threadId
    }
  }
  return ''
}

export async function startThread(cwd?: string, model?: string): Promise<string> {
  try {
    const params: Record<string, unknown> = {}
    if (typeof cwd === 'string' && cwd.trim().length > 0) {
      params.cwd = cwd.trim()
    }
    if (typeof model === 'string' && model.trim().length > 0) {
      params.model = model.trim()
    }
    const payload = await callRpc<{ thread?: { id?: string } }>('thread/start', params)
    const threadId = normalizeThreadIdFromPayload(payload)
    if (!threadId) {
      throw new Error('thread/start did not return a thread id')
    }
    return threadId
  } catch (error) {
    throw normalizeCodexApiError(error, 'Failed to start a new thread', 'thread/start')
  }
}

export type FileAttachmentParam = { label: string; path: string; fsPath: string }

function buildTextWithAttachments(
  prompt: string,
  files: FileAttachmentParam[],
): string {
  if (files.length === 0) return prompt
  let prefix = '# Files mentioned by the user:\n'
  for (const f of files) {
    prefix += `\n## ${f.label}: ${f.path}\n`
  }
  return `${prefix}\n## My request for Codex:\n\n${prompt}\n`
}

export async function startThreadTurn(
  threadId: string,
  text: string,
  imageUrls: string[] = [],
  model?: string,
  effort?: ReasoningEffort,
  skills?: Array<{ name: string; path: string }>,
  fileAttachments: FileAttachmentParam[] = [],
): Promise<void> {
  try {
    const finalText = buildTextWithAttachments(text, fileAttachments)
    const input: Array<Record<string, unknown>> = [{ type: 'text', text: finalText }]
    for (const imageUrl of imageUrls) {
      const normalizedUrl = imageUrl.trim()
      if (!normalizedUrl) continue
      input.push({
        type: 'image',
        url: normalizedUrl,
        image_url: normalizedUrl,
      })
    }
    if (skills) {
      for (const skill of skills) {
        input.push({ type: 'skill', name: skill.name, path: skill.path })
      }
    }
    const attachments = fileAttachments.map((f) => ({ label: f.label, path: f.path, fsPath: f.fsPath }))
    const params: Record<string, unknown> = {
      threadId,
      input,
    }
    if (attachments.length > 0) params.attachments = attachments
    if (typeof model === 'string' && model.length > 0) {
      params.model = model
    }
    if (typeof effort === 'string' && effort.length > 0) {
      params.effort = effort
    }
    await callRpc('turn/start', params)
  } catch (error) {
    throw normalizeCodexApiError(error, `Failed to start turn for thread ${threadId}`, 'turn/start')
  }
}

export async function interruptThreadTurn(threadId: string, turnId?: string): Promise<void> {
  const normalizedThreadId = threadId.trim()
  const normalizedTurnId = turnId?.trim() || ''
  if (!normalizedThreadId) return

  try {
    if (!normalizedTurnId) {
      throw new Error('turn/interrupt requires turnId')
    }
    await callRpc('turn/interrupt', { threadId: normalizedThreadId, turnId: normalizedTurnId })
  } catch (error) {
    throw normalizeCodexApiError(error, `Failed to interrupt turn for thread ${normalizedThreadId}`, 'turn/interrupt')
  }
}

export async function setDefaultModel(model: string): Promise<void> {
  await callRpc('setDefaultModel', { model })
}

export async function getAvailableModelIds(): Promise<string[]> {
  const payload = await callRpc<ModelListResponse>('model/list', {})
  const ids: string[] = []
  for (const row of payload.data) {
    const candidate = row.id || row.model
    if (!candidate || ids.includes(candidate)) continue
    ids.push(candidate)
  }
  return ids
}

export async function getCurrentModelConfig(): Promise<CurrentModelConfig> {
  const payload = await callRpc<ConfigReadResponse>('config/read', {})
  const model = payload.config.model ?? ''
  const reasoningEffort = normalizeReasoningEffort(payload.config.model_reasoning_effort)
  return { model, reasoningEffort }
}

function normalizeWorkspaceRootsState(payload: unknown): WorkspaceRootsState {
  const record = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : {}

  const normalizeArray = (value: unknown): string[] => {
    if (!Array.isArray(value)) return []
    const next: string[] = []
    for (const item of value) {
      if (typeof item === 'string' && item.length > 0 && !next.includes(item)) {
        next.push(item)
      }
    }
    return next
  }

  const labelsRaw = record.labels
  const labels: Record<string, string> = {}
  if (labelsRaw && typeof labelsRaw === 'object' && !Array.isArray(labelsRaw)) {
    for (const [key, value] of Object.entries(labelsRaw as Record<string, unknown>)) {
      if (typeof key === 'string' && key.length > 0 && typeof value === 'string') {
        labels[key] = value
      }
    }
  }

  return {
    order: normalizeArray(record.order),
    labels,
    active: normalizeArray(record.active),
  }
}

export async function getWorkspaceRootsState(): Promise<WorkspaceRootsState> {
  const response = await fetch('/codex-api/workspace-roots-state')
  const payload = (await response.json()) as unknown
  if (!response.ok) {
    throw new Error('Failed to load workspace roots state')
  }
  const envelope =
    payload && typeof payload === 'object' && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : {}
  return normalizeWorkspaceRootsState(envelope.data)
}

export async function setWorkspaceRootsState(nextState: WorkspaceRootsState): Promise<void> {
  const response = await fetch('/codex-api/workspace-roots-state', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(nextState),
  })
  if (!response.ok) {
    throw new Error('Failed to save workspace roots state')
  }
}

export async function openProjectRoot(path: string, options?: { createIfMissing?: boolean; label?: string }): Promise<string> {
  const response = await fetch('/codex-api/project-root', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      path,
      createIfMissing: options?.createIfMissing === true,
      label: options?.label ?? '',
    }),
  })
  const payload = (await response.json()) as unknown
  if (!response.ok) {
    const message = getErrorMessageFromPayload(payload, 'Failed to open project root')
    throw new Error(message)
  }
  const record =
    payload && typeof payload === 'object' && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : {}
  const data =
    record.data && typeof record.data === 'object' && !Array.isArray(record.data)
      ? (record.data as Record<string, unknown>)
      : {}
  const normalizedPath = typeof data.path === 'string' ? data.path.trim() : ''
  return normalizedPath
}

export async function getProjectRootSuggestion(basePath: string): Promise<{ name: string; path: string }> {
  const query = new URLSearchParams({ basePath })
  const response = await fetch(`/codex-api/project-root-suggestion?${query.toString()}`)
  const payload = (await response.json()) as unknown
  if (!response.ok) {
    const message = getErrorMessageFromPayload(payload, 'Failed to suggest project name')
    throw new Error(message)
  }
  const record =
    payload && typeof payload === 'object' && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : {}
  const data =
    record.data && typeof record.data === 'object' && !Array.isArray(record.data)
      ? (record.data as Record<string, unknown>)
      : {}
  return {
    name: typeof data.name === 'string' ? data.name.trim() : '',
    path: typeof data.path === 'string' ? data.path.trim() : '',
  }
}

export type FsDirectoryEntry = {
  name: string
  path: string
}

export type FsDirectoryListing = {
  currentPath: string
  homePath: string
  parentPath: string | null
  entries: FsDirectoryEntry[]
}

function normalizeFsDirectoryListing(payload: unknown): FsDirectoryListing {
  const data =
    payload && typeof payload === 'object' && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : {}

  const entriesRaw = Array.isArray(data.entries) ? data.entries : []
  const entries: FsDirectoryEntry[] = []

  for (const row of entriesRaw) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue
    const record = row as Record<string, unknown>
    const name = typeof record.name === 'string' ? record.name.trim() : ''
    const path = typeof record.path === 'string' ? record.path.trim() : ''
    if (!name || !path) continue
    entries.push({ name, path })
  }

  return {
    currentPath: typeof data.currentPath === 'string' ? data.currentPath.trim() : '',
    homePath: typeof data.homePath === 'string' ? data.homePath.trim() : '',
    parentPath: typeof data.parentPath === 'string' ? data.parentPath.trim() : null,
    entries,
  }
}

export async function getFsDirectoryList(path?: string): Promise<FsDirectoryListing> {
  const query = new URLSearchParams()
  const normalizedPath = path?.trim() ?? ''
  if (normalizedPath) {
    query.set('path', normalizedPath)
  }

  const requestUrl = query.size > 0 ? `/codex-api/fs/list?${query.toString()}` : '/codex-api/fs/list'
  const response = await fetch(requestUrl)
  const payload = (await response.json()) as unknown
  if (!response.ok) {
    const message = getErrorMessageFromPayload(payload, 'Failed to list folders')
    throw new Error(message)
  }

  const envelope =
    payload && typeof payload === 'object' && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : {}

  return normalizeFsDirectoryListing(envelope.data)
}

export type ComposerFileSuggestion = {
  path: string
}

function normalizeComposerFileSuggestions(payload: unknown): ComposerFileSuggestion[] {
  const rows = Array.isArray(payload) ? payload : []
  const suggestions: ComposerFileSuggestion[] = []
  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue
    const record = row as Record<string, unknown>
    const path = typeof record.path === 'string' ? record.path.trim() : ''
    if (!path) continue
    suggestions.push({ path })
  }
  return suggestions
}

export async function searchComposerFiles(cwd: string, query = '', limit = 20): Promise<ComposerFileSuggestion[]> {
  const normalizedCwd = cwd.trim()
  if (!normalizedCwd) return []

  const response = await fetch('/codex-api/composer-file-search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      cwd: normalizedCwd,
      query,
      limit,
    }),
  })

  const payload = (await response.json()) as unknown
  if (!response.ok) {
    const message = getErrorMessageFromPayload(payload, 'Failed to search files')
    throw new Error(message)
  }

  const envelope =
    payload && typeof payload === 'object' && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : {}

  return normalizeComposerFileSuggestions(envelope.data)
}

function getErrorMessageFromPayload(payload: unknown, fallback: string): string {
  const record = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : {}
  const error = record.error
  return typeof error === 'string' && error.trim().length > 0 ? error : fallback
}

function normalizeConnectorInfo(payload: unknown): CodexConnectorInfo | null {
  const record = asRecord(payload)
  if (!record) return null

  const id = readString(record.id)
  const serverId = readString(record.serverId) || id
  const name = readString(record.name) || id
  const hubAddress = readString(record.hubAddress)
  const relayAgentId = readString(record.relayAgentId)
  const createdAtIso = readString(record.createdAtIso)
  const updatedAtIso = readString(record.updatedAtIso)
  if (!id || !serverId || !name || !hubAddress || !relayAgentId || !createdAtIso || !updatedAtIso) {
    return null
  }

  const relayE2eeKeyId = readString(record.relayE2eeKeyId) || undefined
  const installStateRaw = readString(record.installState)
  const installState = installStateRaw === 'connected'
    || installStateRaw === 'offline'
    || installStateRaw === 'expired_bootstrap'
    || installStateRaw === 'reinstall_required'
    ? installStateRaw
    : 'pending_install'
  const bootstrapIssuedAtIso = readString(record.bootstrapIssuedAtIso) || undefined
  const bootstrapExpiresAtIso = readString(record.bootstrapExpiresAtIso) || undefined
  const bootstrapConsumedAtIso = readString(record.bootstrapConsumedAtIso) || undefined
  const credentialIssuedAtIso = readString(record.credentialIssuedAtIso) || undefined
  const lastSeenAtIso = readString(record.lastSeenAtIso) || undefined
  const lastStatsAtIso = readString(record.lastStatsAtIso) || undefined
  const projectCount = typeof record.projectCount === 'number' && Number.isFinite(record.projectCount)
    ? Math.max(0, Math.trunc(record.projectCount))
    : undefined
  const threadCount = typeof record.threadCount === 'number' && Number.isFinite(record.threadCount)
    ? Math.max(0, Math.trunc(record.threadCount))
    : undefined

  return {
    id,
    serverId,
    name,
    hubAddress,
    relayAgentId,
    ...(relayE2eeKeyId ? { relayE2eeKeyId } : {}),
    createdAtIso,
    updatedAtIso,
    installState,
    ...(bootstrapIssuedAtIso ? { bootstrapIssuedAtIso } : {}),
    ...(bootstrapExpiresAtIso ? { bootstrapExpiresAtIso } : {}),
    ...(bootstrapConsumedAtIso ? { bootstrapConsumedAtIso } : {}),
    ...(credentialIssuedAtIso ? { credentialIssuedAtIso } : {}),
    connected: record.connected === true,
    ...(lastSeenAtIso ? { lastSeenAtIso } : {}),
    ...(projectCount !== undefined ? { projectCount } : {}),
    ...(threadCount !== undefined ? { threadCount } : {}),
    ...(lastStatsAtIso ? { lastStatsAtIso } : {}),
    ...(typeof record.statsStale === 'boolean' ? { statsStale: record.statsStale } : {}),
  }
}

function normalizeConnectorList(payload: unknown): CodexConnectorInfo[] {
  const root = asRecord(payload)
  const rows = Array.isArray(root?.connectors) ? root.connectors : Array.isArray(payload) ? payload : []
  const connectors: CodexConnectorInfo[] = []
  const seen = new Set<string>()
  for (const row of rows) {
    const connector = normalizeConnectorInfo(row)
    if (!connector || seen.has(connector.id)) continue
    seen.add(connector.id)
    connectors.push(connector)
  }
  return connectors
}

export async function getConnectorRegistrations(options: { includeStats?: boolean } = {}): Promise<CodexConnectorInfo[]> {
  const query = new URLSearchParams()
  if (options.includeStats) query.set('includeStats', '1')
  const requestUrl = query.size > 0 ? `/codex-api/connectors?${query.toString()}` : '/codex-api/connectors'
  const response = await fetch(requestUrl)
  const payload = (await response.json()) as unknown
  if (!response.ok) {
    throw new Error(getErrorMessageFromPayload(payload, 'Failed to load connectors'))
  }
  const envelope = asRecord(payload)
  return normalizeConnectorList(envelope?.data)
}

export async function createConnectorRegistration(input: ConnectorCreateInput): Promise<ConnectorCreateResult> {
  const response = await fetch('/codex-api/connectors', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id: input.id,
      name: input.name,
      hubAddress: input.hubAddress,
      ...(input.e2ee ? { e2ee: input.e2ee } : {}),
    }),
  })
  const payload = (await response.json()) as unknown
  if (!response.ok) {
    throw new Error(getErrorMessageFromPayload(payload, 'Failed to create connector'))
  }
  const envelope = asRecord(payload)
  const data = asRecord(envelope?.data)
  const connector = normalizeConnectorInfo(data?.connector)
  const bootstrapToken = readString(data?.bootstrapToken)
  if (!connector || !bootstrapToken) {
    throw new Error('Connector creation returned an incomplete response')
  }
  return { connector, bootstrapToken }
}

export async function renameConnectorRegistration(
  connectorId: string,
  input: { name: string },
): Promise<CodexConnectorInfo> {
  const normalizedConnectorId = connectorId.trim()
  const response = await fetch(`/codex-api/connectors/${encodeURIComponent(normalizedConnectorId)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: input.name }),
  })
  const payload = (await response.json()) as unknown
  if (!response.ok) {
    throw new Error(getErrorMessageFromPayload(payload, 'Failed to rename connector'))
  }
  const envelope = asRecord(payload)
  const data = asRecord(envelope?.data)
  const connector = normalizeConnectorInfo(data?.connector)
  if (!connector) {
    throw new Error('Connector rename returned an incomplete response')
  }
  return connector
}

export async function rotateConnectorRegistrationToken(connectorId: string): Promise<ConnectorRotateTokenResult> {
  const normalizedConnectorId = connectorId.trim()
  const response = await fetch(`/codex-api/connectors/${encodeURIComponent(normalizedConnectorId)}/rotate-token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  })
  const payload = (await response.json()) as unknown
  if (!response.ok) {
    throw new Error(getErrorMessageFromPayload(payload, 'Failed to rotate connector token'))
  }
  const envelope = asRecord(payload)
  const data = asRecord(envelope?.data)
  const connector = normalizeConnectorInfo(data?.connector)
  const bootstrapToken = readString(data?.bootstrapToken)
  if (!connector || !bootstrapToken) {
    throw new Error('Connector token rotation returned an incomplete response')
  }
  return { connector, bootstrapToken }
}

export async function deleteConnectorRegistration(connectorId: string): Promise<CodexConnectorInfo[]> {
  const normalizedConnectorId = connectorId.trim()
  const response = await fetch(`/codex-api/connectors/${encodeURIComponent(normalizedConnectorId)}`, {
    method: 'DELETE',
  })
  const payload = (await response.json()) as unknown
  if (!response.ok) {
    throw new Error(getErrorMessageFromPayload(payload, 'Failed to delete connector'))
  }
  const envelope = asRecord(payload)
  return normalizeConnectorList(asRecord(envelope?.data))
}

export type ThreadTitleCache = { titles: Record<string, string>; order: string[] }

export async function getThreadTitleCache(): Promise<ThreadTitleCache> {
  try {
    const response = await fetch('/codex-api/thread-titles')
    if (!response.ok) return { titles: {}, order: [] }
    const envelope = (await response.json()) as { data?: ThreadTitleCache }
    return envelope.data ?? { titles: {}, order: [] }
  } catch {
    return { titles: {}, order: [] }
  }
}

export async function persistThreadTitle(id: string, title: string): Promise<void> {
  try {
    await fetch('/codex-api/thread-titles', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, title }),
    })
  } catch {
    // Best-effort persist
  }
}

export async function generateThreadTitle(prompt: string, cwd: string | null): Promise<string> {
  try {
    const result = await callRpc<{ title?: string }>('generate-thread-title', { prompt, cwd })
    return result.title?.trim() ?? ''
  } catch {
    return ''
  }
}

export type SkillInfo = {
  name: string
  description: string
  path: string
  scope: string
  enabled: boolean
}

type SkillsListResponseEntry = {
  cwd: string
  skills: Array<{
    name: string
    description: string
    shortDescription?: string
    path: string
    scope: string
    enabled: boolean
  }>
  errors: unknown[]
}

export async function getSkillsList(cwds?: string[]): Promise<SkillInfo[]> {
  try {
    const params: Record<string, unknown> = {}
    if (cwds && cwds.length > 0) params.cwds = cwds
    const payload = await callRpc<{ data: SkillsListResponseEntry[] }>('skills/list', params)
    const skills: SkillInfo[] = []
    const seen = new Set<string>()
    for (const entry of payload.data) {
      for (const skill of entry.skills) {
        if (!skill.name || seen.has(skill.path)) continue
        seen.add(skill.path)
        skills.push({
          name: skill.name,
          description: skill.shortDescription || skill.description || '',
          path: skill.path,
          scope: skill.scope,
          enabled: skill.enabled,
        })
      }
    }
    return skills
  } catch {
    return []
  }
}

export async function uploadFile(file: File): Promise<string | null> {
  try {
    const form = new FormData()
    form.append('file', file)
    const resp = await fetch('/codex-api/upload-file', { method: 'POST', body: form })
    if (!resp.ok) return null
    const data = (await resp.json()) as { path?: string }
    return data.path ?? null
  } catch {
    return null
  }
}
