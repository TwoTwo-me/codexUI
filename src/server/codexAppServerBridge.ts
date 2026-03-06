import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, mkdir, stat } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { homedir } from 'node:os'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { writeFile } from 'node:fs/promises'
import { getRequestAuthScopeKey, getRequestAuthenticatedUser } from './requestAuthContext.js'
import { OutboundRelayHub, RelayHubError } from './relay/relayHub.js'
import { listUsers } from './userStore.js'
import {
  RELAY_CHANNEL_ID_HEADER,
  RELAY_HUB_CHANNEL,
  RELAY_SERVER_ID_HEADER,
  isRelayChannelId,
  type RelayChannelId,
} from '../types/relayProtocol.js'
import {
  RELAY_E2EE_ALGORITHM,
  RELAY_E2EE_RPC_METHOD,
  normalizeRelayE2eeEnvelope,
} from '../types/relayE2ee.js'

type JsonRpcCall = {
  jsonrpc: '2.0'
  id: number
  method: string
  params?: unknown
}

type JsonRpcResponse = {
  id?: number
  result?: unknown
  error?: {
    code: number
    message: string
  }
  method?: string
  params?: unknown
}

type RpcProxyRequest = {
  method?: string
  params?: unknown
  e2ee?: unknown
}

type ServerRequestReply = {
  result?: unknown
  error?: {
    code: number
    message: string
  }
}

type WorkspaceRootsState = {
  order: string[]
  labels: Record<string, string>
  active: string[]
}

type PendingServerRequest = {
  id: number
  method: string
  params: unknown
  receivedAtIso: string
}

type CodexRelayServerConfig = {
  agentId: string
  protocol: string
  requestTimeoutMs: number
  e2ee?: CodexRelayE2eeConfig
}

type CodexRelayE2eeConfig = {
  keyId: string
  algorithm: typeof RELAY_E2EE_ALGORITHM
}

type CodexServerTransport = 'local' | 'relay'

type CodexServerRecord = {
  id: string
  name: string
  transport: CodexServerTransport
  relay?: CodexRelayServerConfig
  createdAtIso: string
  updatedAtIso: string
}

type ServerRegistryState = {
  defaultServerId: string
  servers: CodexServerRecord[]
}

type CodexConnectorRecord = {
  id: string
  serverId: string
  name: string
  hubAddress: string
  relayAgentId: string
  relayE2eeKeyId?: string
  tokenHash: string
  lastKnownProjectCount?: number
  lastKnownThreadCount?: number
  lastStatsAtIso?: string
  createdAtIso: string
  updatedAtIso: string
}

type CodexConnectorPublicRecord = {
  id: string
  serverId: string
  name: string
  hubAddress: string
  relayAgentId: string
  relayE2eeKeyId?: string
  createdAtIso: string
  updatedAtIso: string
  connected: boolean
  lastSeenAtIso?: string
  projectCount?: number
  threadCount?: number
  lastStatsAtIso?: string
  statsStale?: boolean
}

type ConnectorRegistryState = {
  connectors: CodexConnectorRecord[]
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function getErrorMessage(payload: unknown, fallback: string): string {
  if (payload instanceof Error && payload.message.trim().length > 0) {
    return payload.message
  }

  const record = asRecord(payload)
  if (!record) return fallback

  const error = record.error
  if (typeof error === 'string' && error.length > 0) return error

  const nestedError = asRecord(error)
  if (nestedError && typeof nestedError.message === 'string' && nestedError.message.length > 0) {
    return nestedError.message
  }

  return fallback
}

function setJson(res: ServerResponse, statusCode: number, payload: unknown): void {
  res.statusCode = statusCode
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(payload))
}

function scoreFileCandidate(path: string, query: string): number {
  if (!query) return 0
  const lowerPath = path.toLowerCase()
  const lowerQuery = query.toLowerCase()
  const baseName = lowerPath.slice(lowerPath.lastIndexOf('/') + 1)
  if (baseName === lowerQuery) return 0
  if (baseName.startsWith(lowerQuery)) return 1
  if (baseName.includes(lowerQuery)) return 2
  if (lowerPath.includes(`/${lowerQuery}`)) return 3
  if (lowerPath.includes(lowerQuery)) return 4
  return 10
}

async function listFilesWithRipgrep(cwd: string): Promise<string[]> {
  return await new Promise<string[]>((resolve, reject) => {
    const proc = spawn('rg', ['--files', '--hidden', '-g', '!.git', '-g', '!node_modules'], {
      cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    proc.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
    proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
    proc.on('error', reject)
    proc.on('close', (code) => {
      if (code === 0) {
        const rows = stdout
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean)
        resolve(rows)
        return
      }
      const details = [stderr.trim(), stdout.trim()].filter(Boolean).join('\n')
      reject(new Error(details || 'rg --files failed'))
    })
  })
}

function getCodexHomeDir(): string {
  const codexHome = process.env.CODEX_HOME?.trim()
  return codexHome && codexHome.length > 0 ? codexHome : join(homedir(), '.codex')
}

function getSkillsInstallDir(): string {
  return join(getCodexHomeDir(), 'skills')
}

async function runCommand(command: string, args: string[], options: { cwd?: string } = {}): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const proc = spawn(command, args, {
      cwd: options.cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    proc.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
    proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
    proc.on('error', reject)
    proc.on('close', (code) => {
      if (code === 0) {
        resolve()
        return
      }
      const details = [stderr.trim(), stdout.trim()].filter(Boolean).join('\n')
      const suffix = details.length > 0 ? `: ${details}` : ''
      reject(new Error(`Command failed (${command} ${args.join(' ')})${suffix}`))
    })
  })
}

async function detectUserSkillsDir(appServer: AppServerProcess): Promise<string> {
  try {
    const result = (await appServer.rpc('skills/list', {})) as {
      data?: Array<{ skills?: Array<{ scope?: string; path?: string }> }>
    }
    for (const entry of result.data ?? []) {
      for (const skill of entry.skills ?? []) {
        if (skill.scope !== 'user' || !skill.path) continue
        const parts = skill.path.split('/').filter(Boolean)
        if (parts.length < 2) continue
        return `/${parts.slice(0, -2).join('/')}`
      }
    }
  } catch {}
  return getSkillsInstallDir()
}

async function ensureInstalledSkillIsValid(appServer: AppServerProcess, skillPath: string): Promise<void> {
  const result = (await appServer.rpc('skills/list', { forceReload: true })) as {
    data?: Array<{ errors?: Array<{ path?: string; message?: string }> }>
  }
  const normalized = skillPath.endsWith('/SKILL.md') ? skillPath : `${skillPath}/SKILL.md`
  for (const entry of result.data ?? []) {
    for (const error of entry.errors ?? []) {
      if (error.path === normalized) {
        throw new Error(error.message || 'Installed skill is invalid')
      }
    }
  }
}

type SkillHubEntry = {
  name: string
  owner: string
  description: string
  displayName: string
  publishedAt: number
  avatarUrl: string
  url: string
  installed: boolean
  path?: string
  enabled?: boolean
}

type SkillsTreeEntry = {
  name: string
  owner: string
  url: string
}

type SkillsTreeCache = {
  entries: SkillsTreeEntry[]
  fetchedAt: number
}

type MetaJson = {
  displayName?: string
  owner?: string
  slug?: string
  latest?: { publishedAt?: number }
}

const TREE_CACHE_TTL_MS = 5 * 60 * 1000
let skillsTreeCache: SkillsTreeCache | null = null
const metaCache = new Map<string, { description: string; displayName: string; publishedAt: number }>()

async function getGhToken(): Promise<string | null> {
  try {
    const proc = spawn('gh', ['auth', 'token'], { stdio: ['ignore', 'pipe', 'ignore'] })
    let out = ''
    proc.stdout.on('data', (d: Buffer) => { out += d.toString() })
    return new Promise((resolve) => {
      proc.on('close', (code) => resolve(code === 0 ? out.trim() : null))
      proc.on('error', () => resolve(null))
    })
  } catch { return null }
}

async function ghFetch(url: string): Promise<Response> {
  const token = await getGhToken()
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'codex-web-local',
  }
  if (token) headers.Authorization = `Bearer ${token}`
  return fetch(url, { headers })
}

async function fetchSkillsTree(): Promise<SkillsTreeEntry[]> {
  if (skillsTreeCache && Date.now() - skillsTreeCache.fetchedAt < TREE_CACHE_TTL_MS) {
    return skillsTreeCache.entries
  }

  const resp = await ghFetch('https://api.github.com/repos/openclaw/skills/git/trees/main?recursive=1')
  if (!resp.ok) throw new Error(`GitHub tree API returned ${resp.status}`)
  const data = (await resp.json()) as { tree?: Array<{ path: string; type: string }> }

  const metaPattern = /^skills\/([^/]+)\/([^/]+)\/_meta\.json$/
  const seen = new Set<string>()
  const entries: SkillsTreeEntry[] = []

  for (const node of data.tree ?? []) {
    const match = metaPattern.exec(node.path)
    if (!match) continue
    const [, owner, skillName] = match
    const key = `${owner}/${skillName}`
    if (seen.has(key)) continue
    seen.add(key)
    entries.push({
      name: skillName,
      owner,
      url: `https://github.com/openclaw/skills/tree/main/skills/${owner}/${skillName}`,
    })
  }

  skillsTreeCache = { entries, fetchedAt: Date.now() }
  return entries
}

async function fetchMetaBatch(entries: SkillsTreeEntry[]): Promise<void> {
  const toFetch = entries.filter((e) => !metaCache.has(`${e.owner}/${e.name}`))
  if (toFetch.length === 0) return

  const batch = toFetch.slice(0, 50)
  const results = await Promise.allSettled(
    batch.map(async (e) => {
      const rawUrl = `https://raw.githubusercontent.com/openclaw/skills/main/skills/${e.owner}/${e.name}/_meta.json`
      const resp = await fetch(rawUrl)
      if (!resp.ok) return
      const meta = (await resp.json()) as MetaJson
      metaCache.set(`${e.owner}/${e.name}`, {
        displayName: typeof meta.displayName === 'string' ? meta.displayName : '',
        description: typeof meta.displayName === 'string' ? meta.displayName : '',
        publishedAt: meta.latest?.publishedAt ?? 0,
      })
    }),
  )
  void results
}

function buildHubEntry(e: SkillsTreeEntry): SkillHubEntry {
  const cached = metaCache.get(`${e.owner}/${e.name}`)
  return {
    name: e.name,
    owner: e.owner,
    description: cached?.description ?? '',
    displayName: cached?.displayName ?? '',
    publishedAt: cached?.publishedAt ?? 0,
    avatarUrl: `https://github.com/${e.owner}.png?size=40`,
    url: e.url,
    installed: false,
  }
}

type InstalledSkillInfo = { name: string; path: string; enabled: boolean }

async function scanInstalledSkillsFromDisk(): Promise<Map<string, InstalledSkillInfo>> {
  const map = new Map<string, InstalledSkillInfo>()
  const skillsDir = getSkillsInstallDir()
  try {
    const entries = await readdir(skillsDir, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue
      const skillMd = join(skillsDir, entry.name, 'SKILL.md')
      try {
        await stat(skillMd)
        map.set(entry.name, { name: entry.name, path: skillMd, enabled: true })
      } catch {}
    }
  } catch {}
  return map
}

async function searchSkillsHub(
  allEntries: SkillsTreeEntry[],
  query: string,
  limit: number,
  sort: string,
  installedMap: Map<string, InstalledSkillInfo>,
): Promise<SkillHubEntry[]> {
  const q = query.toLowerCase().trim()
  let filtered = q
    ? allEntries.filter((s) => {
        if (s.name.toLowerCase().includes(q) || s.owner.toLowerCase().includes(q)) return true
        const cached = metaCache.get(`${s.owner}/${s.name}`)
        if (cached?.displayName?.toLowerCase().includes(q)) return true
        return false
      })
    : allEntries

  const page = filtered.slice(0, Math.min(limit * 2, 200))
  await fetchMetaBatch(page)

  let results = page.map(buildHubEntry)

  if (sort === 'date') {
    results.sort((a, b) => b.publishedAt - a.publishedAt)
  } else if (q) {
    results.sort((a, b) => {
      const aExact = a.name.toLowerCase() === q ? 1 : 0
      const bExact = b.name.toLowerCase() === q ? 1 : 0
      if (aExact !== bExact) return bExact - aExact
      return b.publishedAt - a.publishedAt
    })
  }

  return results.slice(0, limit).map((s) => {
    const local = installedMap.get(s.name)
    return local
      ? { ...s, installed: true, path: local.path, enabled: local.enabled }
      : s
  })
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const normalized: string[] = []
  for (const item of value) {
    if (typeof item === 'string' && item.length > 0 && !normalized.includes(item)) {
      normalized.push(item)
    }
  }
  return normalized
}

function normalizeStringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const next: Record<string, string> = {}
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (typeof key === 'string' && key.length > 0 && typeof item === 'string') {
      next[key] = item
    }
  }
  return next
}

function getCodexAuthPath(): string {
  return join(getCodexHomeDir(), 'auth.json')
}

type CodexAuth = {
  tokens?: {
    access_token?: string
    account_id?: string
  }
}

async function readCodexAuth(): Promise<{ accessToken: string; accountId?: string } | null> {
  try {
    const raw = await readFile(getCodexAuthPath(), 'utf8')
    const auth = JSON.parse(raw) as CodexAuth
    const token = auth.tokens?.access_token
    if (!token) return null
    return { accessToken: token, accountId: auth.tokens?.account_id ?? undefined }
  } catch {
    return null
  }
}

function getCodexGlobalStatePath(): string {
  return join(getCodexHomeDir(), '.codex-global-state.json')
}

const SERVER_REGISTRY_STATE_KEY = 'codexui-server-registry'
const SERVER_REGISTRY_STATE_BY_USER_KEY = 'codexui-server-registry-by-user'
const CONNECTOR_REGISTRY_STATE_KEY = 'codexui-connector-registry'
const CONNECTOR_REGISTRY_STATE_BY_USER_KEY = 'codexui-connector-registry-by-user'
const MAX_SERVER_ID_LENGTH = 64
const SERVER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const CONNECTOR_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const RELAY_AGENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const LEGACY_RELAY_AGENT_ID_PATTERN = /^agent:([A-Za-z0-9][A-Za-z0-9._-]{0,63})$/u
const RELAY_E2EE_KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const DEFAULT_RELAY_PROTOCOL = 'relay-http-v1'
const MIN_RELAY_TIMEOUT_MS = 5_000
const MAX_RELAY_TIMEOUT_MS = 300_000
const DEFAULT_RELAY_TIMEOUT_MS = 60_000
const MAX_JSON_BODY_BYTES = 1024 * 1024
const MAX_TRANSCRIBE_BODY_BYTES = 25 * 1024 * 1024
const RELAY_AGENT_RATE_LIMIT_WINDOW_MS = 60_000
const RELAY_AGENT_RATE_LIMIT_BLOCK_MS = 60_000
const RELAY_AGENT_RATE_LIMIT_MAX_PER_IP = 4_000
const RELAY_AGENT_RATE_LIMIT_MAX_PER_CLIENT_KEY = 480
const RELAY_AGENT_RATE_LIMIT_MAX_ENTRIES = 4096
const cachedServerRegistryStateByScope = new Map<string, ServerRegistryState>()
const cachedConnectorRegistryStateByScope = new Map<string, ConnectorRegistryState>()

type ServerRegistryScope = {
  cacheKey: string
  userId: string | null
}

type RelayEndpointRateLimitRecord = {
  requests: number
  windowStartedAtMs: number
  blockedUntilMs: number
}

function cloneServerRecord(record: CodexServerRecord): CodexServerRecord {
  return {
    ...record,
    ...(record.relay ? { relay: { ...record.relay } } : {}),
  }
}

function cloneServerRegistryState(state: ServerRegistryState): ServerRegistryState {
  return {
    defaultServerId: state.defaultServerId,
    servers: state.servers.map(cloneServerRecord),
  }
}

function cloneConnectorRecord(record: CodexConnectorRecord): CodexConnectorRecord {
  return {
    ...record,
  }
}

function cloneConnectorRegistryState(state: ConnectorRegistryState): ConnectorRegistryState {
  return {
    connectors: state.connectors.map(cloneConnectorRecord),
  }
}

export function isValidServerId(value: string): boolean {
  return SERVER_ID_PATTERN.test(value)
}

function isValidConnectorId(value: string): boolean {
  return CONNECTOR_ID_PATTERN.test(value)
}

function isValidRelayAgentId(value: string): boolean {
  return RELAY_AGENT_ID_PATTERN.test(value)
}

function normalizeRelayAgentId(value: unknown): string {
  const rawValue = typeof value === 'string' ? value.trim() : ''
  if (!rawValue) return ''
  if (isValidRelayAgentId(rawValue)) return rawValue

  const legacyMatch = LEGACY_RELAY_AGENT_ID_PATTERN.exec(rawValue)
  return legacyMatch?.[1] ?? ''
}

function normalizeServerTransport(value: unknown): CodexServerTransport {
  return value === 'relay' ? 'relay' : 'local'
}

function clampRelayTimeoutMs(value: unknown): number {
  const numericValue = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(numericValue)) return DEFAULT_RELAY_TIMEOUT_MS
  const normalized = Math.trunc(numericValue)
  if (normalized < MIN_RELAY_TIMEOUT_MS) return MIN_RELAY_TIMEOUT_MS
  if (normalized > MAX_RELAY_TIMEOUT_MS) return MAX_RELAY_TIMEOUT_MS
  return normalized
}

function normalizeRelayE2eeConfig(value: unknown): CodexRelayE2eeConfig | undefined | null {
  if (value === undefined || value === null) {
    return undefined
  }

  const record = asRecord(value)
  if (!record) return null

  const enabled = record.enabled !== false
  if (!enabled) {
    return undefined
  }

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

function normalizeRelayServerConfig(value: unknown): CodexRelayServerConfig | null {
  const record = asRecord(value)
  if (!record) return null

  const agentId = normalizeRelayAgentId(record.agentId)
  if (!agentId) {
    return null
  }

  const protocol = typeof record.protocol === 'string' && record.protocol.trim().length > 0
    ? record.protocol.trim()
    : DEFAULT_RELAY_PROTOCOL

  const requestTimeoutMs = clampRelayTimeoutMs(record.requestTimeoutMs)
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

function normalizeServerRecord(value: unknown, nowIso: string): CodexServerRecord | null {
  const record = asRecord(value)
  if (!record) return null

  const id = typeof record.id === 'string' ? record.id.trim() : ''
  if (!isValidServerId(id)) {
    return null
  }

  const name = typeof record.name === 'string' && record.name.trim().length > 0
    ? record.name.trim()
    : id

  const createdAtIso = typeof record.createdAtIso === 'string' && record.createdAtIso.trim().length > 0
    ? record.createdAtIso.trim()
    : nowIso
  const updatedAtIso = typeof record.updatedAtIso === 'string' && record.updatedAtIso.trim().length > 0
    ? record.updatedAtIso.trim()
    : createdAtIso
  const transportCandidate = normalizeServerTransport(record.transport)
  const relay = normalizeRelayServerConfig(record.relay)
  const transport: CodexServerTransport = transportCandidate === 'relay' && relay ? 'relay' : 'local'

  return {
    id,
    name,
    transport,
    ...(transport === 'relay' && relay ? { relay } : {}),
    createdAtIso,
    updatedAtIso,
  }
}

export function normalizeServerRegistryState(value: unknown, nowIso = new Date().toISOString()): ServerRegistryState {
  const record = asRecord(value)
  const rawServers = Array.isArray(record?.servers) ? record?.servers : []
  const serversById = new Map<string, CodexServerRecord>()

  for (const item of rawServers) {
    const normalized = normalizeServerRecord(item, nowIso)
    if (!normalized || serversById.has(normalized.id)) continue
    serversById.set(normalized.id, normalized)
  }

  if (serversById.size === 0) {
    return {
      defaultServerId: '',
      servers: [],
    }
  }

  const candidateDefaultServerId = typeof record?.defaultServerId === 'string' ? record.defaultServerId.trim() : ''
  const hasCandidateDefault = candidateDefaultServerId.length > 0 && serversById.has(candidateDefaultServerId)
  const defaultServerId = hasCandidateDefault ? candidateDefaultServerId : (serversById.keys().next().value ?? '')

  return {
    defaultServerId,
    servers: Array.from(serversById.values()),
  }
}

function normalizeConnectorRecord(value: unknown, nowIso: string): CodexConnectorRecord | null {
  const record = asRecord(value)
  if (!record) return null

  const id = typeof record.id === 'string' ? record.id.trim() : ''
  if (!isValidConnectorId(id)) {
    return null
  }

  const relayAgentId = normalizeRelayAgentId(record.relayAgentId)
  if (!relayAgentId) {
    return null
  }

  const tokenHash = typeof record.tokenHash === 'string' ? record.tokenHash.trim() : ''
  if (!tokenHash) {
    return null
  }

  const serverId = typeof record.serverId === 'string' && record.serverId.trim().length > 0
    ? record.serverId.trim()
    : id
  if (!isValidServerId(serverId)) {
    return null
  }

  const name = typeof record.name === 'string' && record.name.trim().length > 0
    ? record.name.trim()
    : id
  const hubAddress = typeof record.hubAddress === 'string' && record.hubAddress.trim().length > 0
    ? record.hubAddress.trim()
    : ''
  const relayE2eeKeyId = typeof record.relayE2eeKeyId === 'string' && record.relayE2eeKeyId.trim().length > 0
    ? record.relayE2eeKeyId.trim()
    : undefined
  if (relayE2eeKeyId && !RELAY_E2EE_KEY_ID_PATTERN.test(relayE2eeKeyId)) {
    return null
  }
  const lastKnownProjectCount = typeof record.lastKnownProjectCount === 'number' && Number.isFinite(record.lastKnownProjectCount)
    ? Math.max(0, Math.trunc(record.lastKnownProjectCount))
    : undefined
  const lastKnownThreadCount = typeof record.lastKnownThreadCount === 'number' && Number.isFinite(record.lastKnownThreadCount)
    ? Math.max(0, Math.trunc(record.lastKnownThreadCount))
    : undefined
  const lastStatsAtIso = typeof record.lastStatsAtIso === 'string' && record.lastStatsAtIso.trim().length > 0
    ? record.lastStatsAtIso.trim()
    : undefined
  const createdAtIso = typeof record.createdAtIso === 'string' && record.createdAtIso.trim().length > 0
    ? record.createdAtIso.trim()
    : nowIso
  const updatedAtIso = typeof record.updatedAtIso === 'string' && record.updatedAtIso.trim().length > 0
    ? record.updatedAtIso.trim()
    : createdAtIso

  return {
    id,
    serverId,
    name,
    hubAddress,
    relayAgentId,
    ...(relayE2eeKeyId ? { relayE2eeKeyId } : {}),
    tokenHash,
    ...(lastKnownProjectCount !== undefined ? { lastKnownProjectCount } : {}),
    ...(lastKnownThreadCount !== undefined ? { lastKnownThreadCount } : {}),
    ...(lastStatsAtIso ? { lastStatsAtIso } : {}),
    createdAtIso,
    updatedAtIso,
  }
}

function normalizeConnectorRegistryState(value: unknown, nowIso = new Date().toISOString()): ConnectorRegistryState {
  const record = asRecord(value)
  const rawConnectors = Array.isArray(record?.connectors) ? record.connectors : []
  const connectorsById = new Map<string, CodexConnectorRecord>()

  for (const item of rawConnectors) {
    const normalized = normalizeConnectorRecord(item, nowIso)
    if (!normalized || connectorsById.has(normalized.id)) continue
    connectorsById.set(normalized.id, normalized)
  }

  return {
    connectors: Array.from(connectorsById.values()),
  }
}

async function readCodexGlobalStatePayload(): Promise<Record<string, unknown>> {
  const statePath = getCodexGlobalStatePath()
  try {
    const raw = await readFile(statePath, 'utf8')
    return asRecord(JSON.parse(raw)) ?? {}
  } catch {
    return {}
  }
}

async function writeCodexGlobalStatePayload(payload: Record<string, unknown>): Promise<void> {
  const statePath = getCodexGlobalStatePath()
  await writeFile(statePath, JSON.stringify(payload), 'utf8')
}

function resolveServerRegistryScope(req: IncomingMessage): ServerRegistryScope {
  const user = getRequestAuthenticatedUser(req)
  if (!user) {
    return {
      cacheKey: 'global',
      userId: null,
    }
  }

  return {
    cacheKey: getRequestAuthScopeKey(req),
    userId: user.id,
  }
}

function readScopedServerRegistryRawValue(
  payload: Record<string, unknown>,
  scope: ServerRegistryScope,
): { rawValue: unknown } {
  if (!scope.userId) {
    return {
      rawValue: payload[SERVER_REGISTRY_STATE_KEY],
    }
  }

  const scopedPayload = asRecord(payload[SERVER_REGISTRY_STATE_BY_USER_KEY])
  if (scopedPayload && Object.prototype.hasOwnProperty.call(scopedPayload, scope.userId)) {
    return {
      rawValue: scopedPayload[scope.userId],
    }
  }

  if (scopedPayload && Object.keys(scopedPayload).length > 0) {
    return {
      rawValue: undefined,
    }
  }

  return {
    rawValue: payload[SERVER_REGISTRY_STATE_KEY],
  }
}

async function readServerRegistryState(
  scope: ServerRegistryScope,
  options: { persistNormalized?: boolean } = {},
): Promise<ServerRegistryState> {
  const cachedState = cachedServerRegistryStateByScope.get(scope.cacheKey)
  if (cachedState && options.persistNormalized !== true) {
    return cloneServerRegistryState(cachedState)
  }

  const payload = await readCodexGlobalStatePayload()
  const { rawValue } = readScopedServerRegistryRawValue(payload, scope)
  const normalized = normalizeServerRegistryState(rawValue)
  cachedServerRegistryStateByScope.set(scope.cacheKey, cloneServerRegistryState(normalized))

  const shouldPersist = options.persistNormalized === true
    && JSON.stringify(rawValue) !== JSON.stringify(normalized)
  if (shouldPersist) {
    if (!scope.userId) {
      payload[SERVER_REGISTRY_STATE_KEY] = normalized
    } else {
      const currentByUser = asRecord(payload[SERVER_REGISTRY_STATE_BY_USER_KEY]) ?? {}
      currentByUser[scope.userId] = normalized
      payload[SERVER_REGISTRY_STATE_BY_USER_KEY] = currentByUser
    }
    await writeCodexGlobalStatePayload(payload)
  }
  return cloneServerRegistryState(normalized)
}

async function writeServerRegistryState(scope: ServerRegistryScope, nextState: ServerRegistryState): Promise<void> {
  const payload = await readCodexGlobalStatePayload()
  const normalized = normalizeServerRegistryState(nextState)

  if (!scope.userId) {
    payload[SERVER_REGISTRY_STATE_KEY] = normalized
  } else {
    const currentByUser = asRecord(payload[SERVER_REGISTRY_STATE_BY_USER_KEY]) ?? {}
    currentByUser[scope.userId] = normalized
    payload[SERVER_REGISTRY_STATE_BY_USER_KEY] = currentByUser
  }

  await writeCodexGlobalStatePayload(payload)
  cachedServerRegistryStateByScope.set(scope.cacheKey, cloneServerRegistryState(normalized))
}

function readScopedConnectorRegistryRawValue(
  payload: Record<string, unknown>,
  scope: ServerRegistryScope,
): { rawValue: unknown } {
  if (!scope.userId) {
    return {
      rawValue: payload[CONNECTOR_REGISTRY_STATE_KEY],
    }
  }

  const scopedPayload = asRecord(payload[CONNECTOR_REGISTRY_STATE_BY_USER_KEY])
  if (scopedPayload && Object.prototype.hasOwnProperty.call(scopedPayload, scope.userId)) {
    return {
      rawValue: scopedPayload[scope.userId],
    }
  }

  if (scopedPayload && Object.keys(scopedPayload).length > 0) {
    return {
      rawValue: undefined,
    }
  }

  return {
    rawValue: payload[CONNECTOR_REGISTRY_STATE_KEY],
  }
}

async function readConnectorRegistryState(
  scope: ServerRegistryScope,
  options: { persistNormalized?: boolean } = {},
): Promise<ConnectorRegistryState> {
  const cachedState = cachedConnectorRegistryStateByScope.get(scope.cacheKey)
  if (cachedState && options.persistNormalized !== true) {
    return cloneConnectorRegistryState(cachedState)
  }

  const payload = await readCodexGlobalStatePayload()
  const { rawValue } = readScopedConnectorRegistryRawValue(payload, scope)
  const normalized = normalizeConnectorRegistryState(rawValue)
  cachedConnectorRegistryStateByScope.set(scope.cacheKey, cloneConnectorRegistryState(normalized))

  const shouldPersist = options.persistNormalized === true
    && JSON.stringify(rawValue) !== JSON.stringify(normalized)
  if (shouldPersist) {
    if (!scope.userId) {
      payload[CONNECTOR_REGISTRY_STATE_KEY] = normalized
    } else {
      const currentByUser = asRecord(payload[CONNECTOR_REGISTRY_STATE_BY_USER_KEY]) ?? {}
      currentByUser[scope.userId] = normalized
      payload[CONNECTOR_REGISTRY_STATE_BY_USER_KEY] = currentByUser
    }
    await writeCodexGlobalStatePayload(payload)
  }

  return cloneConnectorRegistryState(normalized)
}

async function writeConnectorRegistryState(scope: ServerRegistryScope, nextState: ConnectorRegistryState): Promise<void> {
  const payload = await readCodexGlobalStatePayload()
  const normalized = normalizeConnectorRegistryState(nextState)

  if (!scope.userId) {
    payload[CONNECTOR_REGISTRY_STATE_KEY] = normalized
  } else {
    const currentByUser = asRecord(payload[CONNECTOR_REGISTRY_STATE_BY_USER_KEY]) ?? {}
    currentByUser[scope.userId] = normalized
    payload[CONNECTOR_REGISTRY_STATE_BY_USER_KEY] = currentByUser
  }

  await writeCodexGlobalStatePayload(payload)
  cachedConnectorRegistryStateByScope.set(scope.cacheKey, cloneConnectorRegistryState(normalized))
}

function listPersistedConnectorRecords(payload: Record<string, unknown>): CodexConnectorRecord[] {
  const recordsById = new Map<string, CodexConnectorRecord>()
  const nowIso = new Date().toISOString()

  const globalRegistry = normalizeConnectorRegistryState(payload[CONNECTOR_REGISTRY_STATE_KEY], nowIso)
  for (const connector of globalRegistry.connectors) {
    recordsById.set(connector.relayAgentId, connector)
  }

  const perUserPayload = asRecord(payload[CONNECTOR_REGISTRY_STATE_BY_USER_KEY]) ?? {}
  for (const rawRegistry of Object.values(perUserPayload)) {
    const registry = normalizeConnectorRegistryState(rawRegistry, nowIso)
    for (const connector of registry.connectors) {
      recordsById.set(connector.relayAgentId, connector)
    }
  }

  return Array.from(recordsById.values())
}

function buildServerIdSeed(value: string): string {
  const lowered = value.toLowerCase().trim()
  const collapsed = lowered
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+/g, '')
    .replace(/-+$/g, '')
  const candidate = collapsed.length > 0 ? collapsed : 'server'
  const startsWithAlphaNum = /^[a-z0-9]/.test(candidate)
  const withPrefix = startsWithAlphaNum ? candidate : `server-${candidate}`
  return withPrefix.slice(0, MAX_SERVER_ID_LENGTH)
}

function buildUniqueServerId(seed: string, taken: Set<string>): string {
  const normalizedSeed = buildServerIdSeed(seed)
  if (isValidServerId(normalizedSeed) && !taken.has(normalizedSeed)) {
    return normalizedSeed
  }

  let index = 2
  while (index < 100_000) {
    const suffix = `-${String(index)}`
    const baseLength = Math.max(1, MAX_SERVER_ID_LENGTH - suffix.length)
    const base = normalizedSeed.slice(0, baseLength)
    const candidate = `${base}${suffix}`
    if (isValidServerId(candidate) && !taken.has(candidate)) {
      return candidate
    }
    index += 1
  }

  throw new Error('Failed to generate unique server id')
}

function normalizeHubAddress(value: unknown): string {
  const rawValue = typeof value === 'string' ? value.trim() : ''
  if (!rawValue) return ''

  try {
    const parsed = new URL(rawValue)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
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

function inferHubAddress(req: IncomingMessage): string {
  const forwardedProto = getSingleHeaderValue(req.headers['x-forwarded-proto'])
  const socketEncrypted = (req.socket as { encrypted?: boolean }).encrypted === true
  const protocol = forwardedProto || (socketEncrypted ? 'https' : 'http')
  const host = getSingleHeaderValue(req.headers.host)
  if (!host) return ''
  return normalizeHubAddress(`${protocol}://${host}`)
}

function buildConnectorBoundServerRecord(
  connector: Pick<CodexConnectorRecord, 'serverId' | 'name' | 'relayAgentId' | 'relayE2eeKeyId'>,
  nowIso: string,
  existing?: CodexServerRecord,
): CodexServerRecord {
  return {
    id: connector.serverId,
    name: connector.name,
    transport: 'relay',
    relay: {
      agentId: connector.relayAgentId,
      protocol: DEFAULT_RELAY_PROTOCOL,
      requestTimeoutMs: DEFAULT_RELAY_TIMEOUT_MS,
      ...(connector.relayE2eeKeyId
        ? {
            e2ee: {
              keyId: connector.relayE2eeKeyId,
              algorithm: RELAY_E2EE_ALGORITHM,
            },
          }
        : {}),
    },
    createdAtIso: existing?.createdAtIso ?? nowIso,
    updatedAtIso: nowIso,
  }
}

async function upsertConnectorBoundServer(scope: ServerRegistryScope, connector: CodexConnectorRecord): Promise<void> {
  const state = await readServerRegistryState(scope, { persistNormalized: true })
  const existingServer = state.servers.find((server) => server.id === connector.serverId)
  const nextServer = buildConnectorBoundServerRecord(connector, new Date().toISOString(), existingServer)
  const nextServers = existingServer
    ? state.servers.map((server) => (server.id === connector.serverId ? nextServer : server))
    : [...state.servers, nextServer]
  const nextState: ServerRegistryState = {
    defaultServerId: state.defaultServerId.trim().length > 0 ? state.defaultServerId : connector.serverId,
    servers: nextServers,
  }
  await writeServerRegistryState(scope, nextState)
}

async function removeConnectorBoundServer(
  scope: ServerRegistryScope,
  serverId: string,
  runtimeRegistry: AppServerRuntimeRegistry,
): Promise<void> {
  const state = await readServerRegistryState(scope, { persistNormalized: true })
  const existing = state.servers.find((server) => server.id === serverId)
  if (!existing) {
    runtimeRegistry.disposeServer(scope.cacheKey, serverId)
    return
  }
  const remainingServers = state.servers.filter((server) => server.id !== serverId)
  const nextState: ServerRegistryState = {
    defaultServerId: remainingServers.length === 0
      ? ''
      : state.defaultServerId === serverId
        ? remainingServers[0].id
        : state.defaultServerId,
    servers: remainingServers,
  }
  await writeServerRegistryState(scope, nextState)
  runtimeRegistry.disposeServer(scope.cacheKey, serverId)
}

function summarizeThreadListCounts(payload: unknown): { projectCount: number; threadCount: number } {
  const record = asRecord(payload)
  const rows = Array.isArray(record?.data) ? record.data : []
  const projects = new Set<string>()
  let threadCount = 0

  for (const row of rows) {
    const thread = asRecord(row)
    if (!thread) continue
    threadCount += 1
    const cwd = typeof thread.cwd === 'string' ? thread.cwd.trim() : ''
    if (cwd) {
      projects.add(cwd)
    }
  }

  return {
    projectCount: projects.size,
    threadCount,
  }
}

async function buildConnectorPublicRecords(
  connectors: CodexConnectorRecord[],
  scope: ServerRegistryScope,
  relayHub: OutboundRelayHub,
  includeStats: boolean,
): Promise<{ publicRecords: CodexConnectorPublicRecord[]; nextRecords: CodexConnectorRecord[]; changed: boolean }> {
  let changed = false

  const rows = await Promise.all(connectors.map(async (connector) => {
    let nextConnector = connector
    let projectCount = connector.lastKnownProjectCount
    let threadCount = connector.lastKnownThreadCount
    let lastStatsAtIso = connector.lastStatsAtIso
    let statsStale = false

    const relayAgent = relayHub.getAgent(connector.relayAgentId)
    if (includeStats) {
      if (relayAgent?.connected) {
        try {
          const result = await relayHub.dispatchRpc(
            {
              scopeKey: scope.cacheKey,
              serverId: connector.serverId,
              agentId: connector.relayAgentId,
            },
            'thread/list',
            {
              archived: false,
              limit: 500,
              sortKey: 'updated_at',
            },
            DEFAULT_RELAY_TIMEOUT_MS,
          )
          const stats = summarizeThreadListCounts(result)
          const refreshedAtIso = new Date().toISOString()
          projectCount = stats.projectCount
          threadCount = stats.threadCount
          lastStatsAtIso = refreshedAtIso
          nextConnector = {
            ...connector,
            lastKnownProjectCount: projectCount,
            lastKnownThreadCount: threadCount,
            lastStatsAtIso: refreshedAtIso,
            updatedAtIso: connector.updatedAtIso,
          }
          if (
            nextConnector.lastKnownProjectCount !== connector.lastKnownProjectCount
            || nextConnector.lastKnownThreadCount !== connector.lastKnownThreadCount
            || nextConnector.lastStatsAtIso !== connector.lastStatsAtIso
          ) {
            changed = true
          }
        } catch {
          statsStale = projectCount !== undefined || threadCount !== undefined
        }
      } else {
        statsStale = projectCount !== undefined || threadCount !== undefined
      }
    }

    return {
      nextConnector,
      publicRecord: toPublicConnectorRecord(nextConnector, relayHub, {
        projectCount,
        threadCount,
        lastStatsAtIso,
        ...(includeStats ? { statsStale } : {}),
      }),
    }
  }))

  return {
    publicRecords: rows.map((row) => row.publicRecord),
    nextRecords: rows.map((row) => row.nextConnector),
    changed,
  }
}

function toPublicConnectorRecord(
  connector: CodexConnectorRecord,
  relayHub: OutboundRelayHub,
  options: {
    projectCount?: number
    threadCount?: number
    lastStatsAtIso?: string
    statsStale?: boolean
  } = {},
): CodexConnectorPublicRecord {
  const relayAgent = relayHub.getAgent(connector.relayAgentId)
  return {
    id: connector.id,
    serverId: connector.serverId,
    name: connector.name,
    hubAddress: connector.hubAddress,
    relayAgentId: connector.relayAgentId,
    ...(connector.relayE2eeKeyId ? { relayE2eeKeyId: connector.relayE2eeKeyId } : {}),
    createdAtIso: connector.createdAtIso,
    updatedAtIso: connector.updatedAtIso,
    connected: relayAgent?.connected ?? false,
    ...(relayAgent?.lastSeenAtIso ? { lastSeenAtIso: relayAgent.lastSeenAtIso } : {}),
    ...(options.projectCount !== undefined ? { projectCount: options.projectCount } : {}),
    ...(options.threadCount !== undefined ? { threadCount: options.threadCount } : {}),
    ...(options.lastStatsAtIso ? { lastStatsAtIso: options.lastStatsAtIso } : {}),
    ...(options.statsStale !== undefined ? { statsStale: options.statsStale } : {}),
  }
}

async function syncRelayHubPersistedAgents(relayHub: OutboundRelayHub): Promise<void> {
  const payload = await readCodexGlobalStatePayload()
  for (const connector of listPersistedConnectorRecords(payload)) {
    relayHub.upsertPersistedAgent({
      id: connector.relayAgentId,
      name: connector.name,
      tokenHash: connector.tokenHash,
      createdAtIso: connector.createdAtIso,
      updatedAtIso: connector.updatedAtIso,
    })
  }
}

function parseServerResourceId(pathname: string): string | null {
  const prefix = '/codex-api/servers/'
  if (!pathname.startsWith(prefix)) return null
  const encoded = pathname.slice(prefix.length)
  if (encoded.length === 0 || encoded.includes('/')) return null
  try {
    return decodeURIComponent(encoded).trim()
  } catch {
    return null
  }
}

function parseConnectorResourceParts(pathname: string): { connectorId: string; action: string | null } | null {
  const prefix = '/codex-api/connectors/'
  if (!pathname.startsWith(prefix)) return null
  const suffix = pathname.slice(prefix.length)
  if (!suffix || suffix.startsWith('/')) return null
  const parts = suffix.split('/')
  if (parts.length === 0 || parts.length > 2) return null
  try {
    const connectorId = decodeURIComponent(parts[0]).trim()
    const action = parts.length === 2 ? decodeURIComponent(parts[1]).trim() : null
    if (!connectorId) return null
    if (action !== null && action.length === 0) return null
    return { connectorId, action }
  } catch {
    return null
  }
}

function getSingleHeaderValue(header: string | string[] | undefined): string {
  if (typeof header === 'string') return header.trim()
  if (Array.isArray(header)) {
    for (const value of header) {
      if (typeof value === 'string' && value.trim().length > 0) {
        return value.trim()
      }
    }
  }
  return ''
}

export function getRequestedServerId(req: IncomingMessage, url: URL): string | null {
  const headerServerId = getSingleHeaderValue(req.headers[RELAY_SERVER_ID_HEADER])
  if (headerServerId.length > 0) return headerServerId

  const queryServerId = url.searchParams.get('serverId')?.trim() ?? ''
  return queryServerId.length > 0 ? queryServerId : null
}

function parseRequestedRelayChannelId(rawValue: string): RelayChannelId | null {
  const trimmed = rawValue.trim()
  if (!trimmed) return null
  return isRelayChannelId(trimmed) ? trimmed : null
}

export function getRequestedChannelId(req: IncomingMessage, url: URL): RelayChannelId | null {
  const headerChannelId = getSingleHeaderValue(req.headers[RELAY_CHANNEL_ID_HEADER])
  if (headerChannelId.length > 0) {
    return parseRequestedRelayChannelId(headerChannelId)
  }

  const queryChannelId = url.searchParams.get('channelId')
  if (queryChannelId && queryChannelId.trim().length > 0) {
    return parseRequestedRelayChannelId(queryChannelId)
  }

  return RELAY_HUB_CHANNEL
}

function getRemoteAddress(req: IncomingMessage): string {
  const remoteAddress = req.socket.remoteAddress
  if (typeof remoteAddress === 'string' && remoteAddress.trim().length > 0) {
    return remoteAddress.trim()
  }
  return 'unknown'
}

function getTrustedClientAddress(req: IncomingMessage): string {
  const remoteAddress = getRemoteAddress(req)
  if (!isLoopbackRequest(req)) {
    return remoteAddress
  }

  const forwardedFor = getSingleHeaderValue(req.headers['x-forwarded-for'])
  if (forwardedFor.length > 0) {
    const firstForwarded = forwardedFor.split(',')[0]?.trim()
    if (firstForwarded) return firstForwarded
  }

  const realIp = getSingleHeaderValue(req.headers['x-real-ip'])
  if (realIp.length > 0) {
    return realIp
  }

  return remoteAddress
}

function hashRelayRateLimitToken(token: string): string {
  return createHash('sha256').update(token).digest('hex').slice(0, 16)
}

function buildRelayPerIpRateLimitKey(req: IncomingMessage): string {
  return getTrustedClientAddress(req)
}

function buildRelayPerClientRateLimitKey(req: IncomingMessage): string {
  const clientAddress = getTrustedClientAddress(req)
  const token = readBearerToken(req)
  if (!token) return `${clientAddress}:anon`
  return `${clientAddress}:${hashRelayRateLimitToken(token)}`
}

function compactRelayRateLimitRecords(
  recordsByKey: Map<string, RelayEndpointRateLimitRecord>,
  nowMs: number,
): void {
  if (recordsByKey.size < RELAY_AGENT_RATE_LIMIT_MAX_ENTRIES) return

  for (const [key, record] of recordsByKey.entries()) {
    const latestKnownMs = Math.max(record.windowStartedAtMs, record.blockedUntilMs)
    if (nowMs - latestKnownMs > RELAY_AGENT_RATE_LIMIT_WINDOW_MS + RELAY_AGENT_RATE_LIMIT_BLOCK_MS) {
      recordsByKey.delete(key)
    }
  }
}

function enforceRelayRateLimitCapacity(
  recordsByKey: Map<string, RelayEndpointRateLimitRecord>,
  targetKey: string,
  nowMs: number,
): void {
  compactRelayRateLimitRecords(recordsByKey, nowMs)
  if (recordsByKey.size < RELAY_AGENT_RATE_LIMIT_MAX_ENTRIES || recordsByKey.has(targetKey)) return

  while (recordsByKey.size >= RELAY_AGENT_RATE_LIMIT_MAX_ENTRIES) {
    const oldest = recordsByKey.keys().next().value
    if (!oldest) return
    recordsByKey.delete(oldest)
  }
}

function consumeRelayRateLimitForKey(
  key: string,
  maxRequestsPerWindow: number,
  recordsByKey: Map<string, RelayEndpointRateLimitRecord>,
  nowMs: number,
): { limited: boolean; retryAfterSeconds: number } {
  const existing = recordsByKey.get(key)
  if (!existing) {
    enforceRelayRateLimitCapacity(recordsByKey, key, nowMs)
    recordsByKey.set(key, {
      requests: 1,
      windowStartedAtMs: nowMs,
      blockedUntilMs: 0,
    })
    return { limited: false, retryAfterSeconds: 0 }
  }

  if (existing.blockedUntilMs > nowMs) {
    return {
      limited: true,
      retryAfterSeconds: Math.max(1, Math.ceil((existing.blockedUntilMs - nowMs) / 1000)),
    }
  }

  if (nowMs - existing.windowStartedAtMs >= RELAY_AGENT_RATE_LIMIT_WINDOW_MS) {
    recordsByKey.set(key, {
      requests: 1,
      windowStartedAtMs: nowMs,
      blockedUntilMs: 0,
    })
    return { limited: false, retryAfterSeconds: 0 }
  }

  const nextRequests = existing.requests + 1
  if (nextRequests > maxRequestsPerWindow) {
    const blockedUntilMs = nowMs + RELAY_AGENT_RATE_LIMIT_BLOCK_MS
    recordsByKey.set(key, {
      requests: nextRequests,
      windowStartedAtMs: existing.windowStartedAtMs,
      blockedUntilMs,
    })
    return {
      limited: true,
      retryAfterSeconds: Math.max(1, Math.ceil((blockedUntilMs - nowMs) / 1000)),
    }
  }

  recordsByKey.set(key, {
    requests: nextRequests,
    windowStartedAtMs: existing.windowStartedAtMs,
    blockedUntilMs: 0,
  })
  return { limited: false, retryAfterSeconds: 0 }
}

function consumeRelayEndpointRateLimit(
  req: IncomingMessage,
  recordsByIp: Map<string, RelayEndpointRateLimitRecord>,
  recordsByClientKey: Map<string, RelayEndpointRateLimitRecord>,
): { limited: boolean; retryAfterSeconds: number } {
  const nowMs = Date.now()
  compactRelayRateLimitRecords(recordsByIp, nowMs)
  compactRelayRateLimitRecords(recordsByClientKey, nowMs)

  const ipDecision = consumeRelayRateLimitForKey(
    buildRelayPerIpRateLimitKey(req),
    RELAY_AGENT_RATE_LIMIT_MAX_PER_IP,
    recordsByIp,
    nowMs,
  )
  if (ipDecision.limited) {
    return ipDecision
  }

  return consumeRelayRateLimitForKey(
    buildRelayPerClientRateLimitKey(req),
    RELAY_AGENT_RATE_LIMIT_MAX_PER_CLIENT_KEY,
    recordsByClientKey,
    nowMs,
  )
}

function isLoopbackRequest(req: IncomingMessage): boolean {
  const remote = req.socket.remoteAddress ?? ''
  return remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1'
}

function isTrustedLoopbackOrigin(req: IncomingMessage): boolean {
  const originHeader = getSingleHeaderValue(req.headers.origin)
  if (!originHeader) return true

  try {
    const origin = new URL(originHeader)
    return origin.hostname === 'localhost'
      || origin.hostname === '127.0.0.1'
      || origin.hostname === '[::1]'
      || origin.hostname === '::1'
  } catch {
    return false
  }
}

function requireLoopbackForSensitiveMutation(req: IncomingMessage, action: string): void {
  if (!isLoopbackRequest(req)) {
    throw new BridgeHttpError(403, `${action} is only allowed from localhost`)
  }
  if (!isTrustedLoopbackOrigin(req)) {
    throw new BridgeHttpError(403, `${action} rejected due to untrusted origin`)
  }
}

function isPathInside(basePath: string, targetPath: string): boolean {
  const base = resolve(basePath)
  const target = resolve(targetPath)
  if (base === target) return true
  const rel = relative(base, target)
  return rel.length > 0 && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

function ensurePathInside(basePath: string, targetPath: string, errorMessage: string): string {
  const normalized = resolve(targetPath)
  if (!isPathInside(basePath, normalized)) {
    throw new BridgeHttpError(403, errorMessage)
  }
  return normalized
}

type ThreadTitleCache = { titles: Record<string, string>; order: string[] }
const MAX_THREAD_TITLES = 500

function normalizeThreadTitleCache(value: unknown): ThreadTitleCache {
  const record = asRecord(value)
  if (!record) return { titles: {}, order: [] }
  const rawTitles = asRecord(record.titles)
  const titles: Record<string, string> = {}
  if (rawTitles) {
    for (const [k, v] of Object.entries(rawTitles)) {
      if (typeof v === 'string' && v.length > 0) titles[k] = v
    }
  }
  const order = normalizeStringArray(record.order)
  return { titles, order }
}

function updateThreadTitleCache(cache: ThreadTitleCache, id: string, title: string): ThreadTitleCache {
  const titles = { ...cache.titles, [id]: title }
  const order = [id, ...cache.order.filter((o) => o !== id)]
  while (order.length > MAX_THREAD_TITLES) {
    const removed = order.pop()
    if (removed) delete titles[removed]
  }
  return { titles, order }
}

function removeFromThreadTitleCache(cache: ThreadTitleCache, id: string): ThreadTitleCache {
  const { [id]: _, ...titles } = cache.titles
  return { titles, order: cache.order.filter((o) => o !== id) }
}

async function readThreadTitleCache(): Promise<ThreadTitleCache> {
  const statePath = getCodexGlobalStatePath()
  try {
    const raw = await readFile(statePath, 'utf8')
    const payload = asRecord(JSON.parse(raw)) ?? {}
    return normalizeThreadTitleCache(payload['thread-titles'])
  } catch {
    return { titles: {}, order: [] }
  }
}

async function writeThreadTitleCache(cache: ThreadTitleCache): Promise<void> {
  const statePath = getCodexGlobalStatePath()
  let payload: Record<string, unknown> = {}
  try {
    const raw = await readFile(statePath, 'utf8')
    payload = asRecord(JSON.parse(raw)) ?? {}
  } catch {
    payload = {}
  }
  payload['thread-titles'] = cache
  await writeFile(statePath, JSON.stringify(payload), 'utf8')
}

async function readWorkspaceRootsState(): Promise<WorkspaceRootsState> {
  const statePath = getCodexGlobalStatePath()
  let payload: Record<string, unknown> = {}

  try {
    const raw = await readFile(statePath, 'utf8')
    const parsed = JSON.parse(raw) as unknown
    payload = asRecord(parsed) ?? {}
  } catch {
    payload = {}
  }

  return {
    order: normalizeStringArray(payload['electron-saved-workspace-roots']),
    labels: normalizeStringRecord(payload['electron-workspace-root-labels']),
    active: normalizeStringArray(payload['active-workspace-roots']),
  }
}

async function writeWorkspaceRootsState(nextState: WorkspaceRootsState): Promise<void> {
  const statePath = getCodexGlobalStatePath()
  let payload: Record<string, unknown> = {}
  try {
    const raw = await readFile(statePath, 'utf8')
    payload = asRecord(JSON.parse(raw)) ?? {}
  } catch {
    payload = {}
  }

  payload['electron-saved-workspace-roots'] = normalizeStringArray(nextState.order)
  payload['electron-workspace-root-labels'] = normalizeStringRecord(nextState.labels)
  payload['active-workspace-roots'] = normalizeStringArray(nextState.active)

  await writeFile(statePath, JSON.stringify(payload), 'utf8')
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const raw = await readRawBody(req, MAX_JSON_BODY_BYTES)
  if (raw.length === 0) return null
  const text = raw.toString('utf8').trim()
  if (text.length === 0) return null
  return JSON.parse(text) as unknown
}

async function readRawBody(req: IncomingMessage, maxBytes = MAX_JSON_BODY_BYTES): Promise<Buffer> {
  const chunks: Uint8Array[] = []
  let totalBytes = 0
  for await (const chunk of req) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
    totalBytes += buffer.byteLength
    if (totalBytes > maxBytes) {
      throw new BridgeHttpError(413, `Request body too large (limit ${String(maxBytes)} bytes)`)
    }
    chunks.push(buffer)
  }
  return Buffer.concat(chunks)
}

function bufferIndexOf(buf: Buffer, needle: Buffer, start = 0): number {
  for (let i = start; i <= buf.length - needle.length; i++) {
    let match = true
    for (let j = 0; j < needle.length; j++) {
      if (buf[i + j] !== needle[j]) { match = false; break }
    }
    if (match) return i
  }
  return -1
}

function handleFileUpload(req: IncomingMessage, res: ServerResponse): void {
  const chunks: Buffer[] = []
  req.on('data', (chunk: Buffer) => chunks.push(chunk))
  req.on('end', async () => {
    try {
      const body = Buffer.concat(chunks)
      const contentType = req.headers['content-type'] ?? ''
      const boundaryMatch = contentType.match(/boundary=(.+)/i)
      if (!boundaryMatch) { setJson(res, 400, { error: 'Missing multipart boundary' }); return }
      const boundary = boundaryMatch[1]
      const boundaryBuf = Buffer.from(`--${boundary}`)
      const parts: Buffer[] = []
      let searchStart = 0
      while (searchStart < body.length) {
        const idx = body.indexOf(boundaryBuf, searchStart)
        if (idx < 0) break
        if (searchStart > 0) parts.push(body.subarray(searchStart, idx))
        searchStart = idx + boundaryBuf.length
        if (body[searchStart] === 0x0d && body[searchStart + 1] === 0x0a) searchStart += 2
      }
      let fileName = 'uploaded-file'
      let fileData: Buffer | null = null
      const headerSep = Buffer.from('\r\n\r\n')
      for (const part of parts) {
        const headerEnd = bufferIndexOf(part, headerSep)
        if (headerEnd < 0) continue
        const headers = part.subarray(0, headerEnd).toString('utf8')
        const fnMatch = headers.match(/filename="([^"]+)"/i)
        if (!fnMatch) continue
        fileName = fnMatch[1].replace(/[/\\]/g, '_')
        let end = part.length
        if (end >= 2 && part[end - 2] === 0x0d && part[end - 1] === 0x0a) end -= 2
        fileData = part.subarray(headerEnd + 4, end)
        break
      }
      if (!fileData) { setJson(res, 400, { error: 'No file in request' }); return }
      const uploadDir = join(tmpdir(), 'codex-web-uploads')
      await mkdir(uploadDir, { recursive: true })
      const destDir = await mkdtemp(join(uploadDir, 'f-'))
      const destPath = join(destDir, fileName)
      await writeFile(destPath, fileData)
      setJson(res, 200, { path: destPath })
    } catch (err) {
      setJson(res, 500, { error: getErrorMessage(err, 'Upload failed') })
    }
  })
  req.on('error', (err) => {
    setJson(res, 500, { error: getErrorMessage(err, 'Upload stream error') })
  })
}

async function proxyTranscribe(
  body: Buffer,
  contentType: string,
  authToken: string,
  accountId?: string,
): Promise<{ status: number; body: string }> {
  const headers: Record<string, string | number> = {
    'Content-Type': contentType,
    'Content-Length': body.length,
    Authorization: `Bearer ${authToken}`,
    originator: 'Codex Desktop',
    'User-Agent': `Codex Desktop/0.1.0 (${process.platform}; ${process.arch})`,
  }

  if (accountId) {
    headers['ChatGPT-Account-Id'] = accountId
  }

  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      'https://chatgpt.com/backend-api/transcribe',
      { method: 'POST', headers },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => resolve({ status: res.statusCode ?? 500, body: Buffer.concat(chunks).toString('utf8') }))
        res.on('error', reject)
      },
    )
    req.on('error', reject)
    req.write(body)
    req.end()
  })
}

class AppServerProcess {
  private process: ChildProcessWithoutNullStreams | null = null
  private initialized = false
  private initializePromise: Promise<void> | null = null
  private readBuffer = ''
  private nextId = 1
  private stopping = false
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (reason?: unknown) => void }>()
  private readonly notificationListeners = new Set<(value: { method: string; params: unknown }) => void>()
  private readonly pendingServerRequests = new Map<number, PendingServerRequest>()

  private start(): void {
    if (this.process) return

    this.stopping = false
    const proc = spawn('codex', ['app-server'], { stdio: ['pipe', 'pipe', 'pipe'] })
    this.process = proc

    proc.stdout.setEncoding('utf8')
    proc.stdout.on('data', (chunk: string) => {
      this.readBuffer += chunk

      let lineEnd = this.readBuffer.indexOf('\n')
      while (lineEnd !== -1) {
        const line = this.readBuffer.slice(0, lineEnd).trim()
        this.readBuffer = this.readBuffer.slice(lineEnd + 1)

        if (line.length > 0) {
          this.handleLine(line)
        }

        lineEnd = this.readBuffer.indexOf('\n')
      }
    })

    proc.stderr.setEncoding('utf8')
    proc.stderr.on('data', () => {
      // Keep stderr silent in dev middleware; JSON-RPC errors are forwarded via responses.
    })

    proc.on('exit', () => {
      const failure = new Error(this.stopping ? 'codex app-server stopped' : 'codex app-server exited unexpectedly')
      for (const request of this.pending.values()) {
        request.reject(failure)
      }

      this.pending.clear()
      this.pendingServerRequests.clear()
      this.process = null
      this.initialized = false
      this.initializePromise = null
      this.readBuffer = ''
    })
  }

  private sendLine(payload: Record<string, unknown>): void {
    if (!this.process) {
      throw new Error('codex app-server is not running')
    }

    this.process.stdin.write(`${JSON.stringify(payload)}\n`)
  }

  private handleLine(line: string): void {
    let message: JsonRpcResponse
    try {
      message = JSON.parse(line) as JsonRpcResponse
    } catch {
      return
    }

    if (typeof message.id === 'number' && this.pending.has(message.id)) {
      const pendingRequest = this.pending.get(message.id)
      this.pending.delete(message.id)

      if (!pendingRequest) return

      if (message.error) {
        pendingRequest.reject(new Error(message.error.message))
      } else {
        pendingRequest.resolve(message.result)
      }
      return
    }

    if (typeof message.method === 'string' && typeof message.id !== 'number') {
      this.emitNotification({
        method: message.method,
        params: message.params ?? null,
      })
      return
    }

    // Handle server-initiated JSON-RPC requests (approvals, dynamic tool calls, etc.).
    if (typeof message.id === 'number' && typeof message.method === 'string') {
      this.handleServerRequest(message.id, message.method, message.params ?? null)
    }
  }

  private emitNotification(notification: { method: string; params: unknown }): void {
    for (const listener of this.notificationListeners) {
      listener(notification)
    }
  }

  private sendServerRequestReply(requestId: number, reply: ServerRequestReply): void {
    if (reply.error) {
      this.sendLine({
        jsonrpc: '2.0',
        id: requestId,
        error: reply.error,
      })
      return
    }

    this.sendLine({
      jsonrpc: '2.0',
      id: requestId,
      result: reply.result ?? {},
    })
  }

  private resolvePendingServerRequest(requestId: number, reply: ServerRequestReply): void {
    const pendingRequest = this.pendingServerRequests.get(requestId)
    if (!pendingRequest) {
      throw new Error(`No pending server request found for id ${String(requestId)}`)
    }
    this.pendingServerRequests.delete(requestId)

    this.sendServerRequestReply(requestId, reply)
    const requestParams = asRecord(pendingRequest.params)
    const threadId =
      typeof requestParams?.threadId === 'string' && requestParams.threadId.length > 0
        ? requestParams.threadId
        : ''
    this.emitNotification({
      method: 'server/request/resolved',
      params: {
        id: requestId,
        method: pendingRequest.method,
        threadId,
        mode: 'manual',
        resolvedAtIso: new Date().toISOString(),
      },
    })
  }

  private handleServerRequest(requestId: number, method: string, params: unknown): void {
    const pendingRequest: PendingServerRequest = {
      id: requestId,
      method,
      params,
      receivedAtIso: new Date().toISOString(),
    }
    this.pendingServerRequests.set(requestId, pendingRequest)

    this.emitNotification({
      method: 'server/request',
      params: pendingRequest,
    })
  }

  private async call(method: string, params: unknown): Promise<unknown> {
    this.start()
    const id = this.nextId++

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })

      this.sendLine({
        jsonrpc: '2.0',
        id,
        method,
        params,
      } satisfies JsonRpcCall)
    })
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return
    if (this.initializePromise) {
      await this.initializePromise
      return
    }

    this.initializePromise = this.call('initialize', {
      clientInfo: {
        name: 'codex-web-local',
        version: '0.1.0',
      },
    }).then(() => {
      this.initialized = true
    }).finally(() => {
      this.initializePromise = null
    })

    await this.initializePromise
  }

  async rpc(method: string, params: unknown): Promise<unknown> {
    await this.ensureInitialized()
    return this.call(method, params)
  }

  onNotification(listener: (value: { method: string; params: unknown }) => void): () => void {
    this.notificationListeners.add(listener)
    return () => {
      this.notificationListeners.delete(listener)
    }
  }

  async respondToServerRequest(payload: unknown): Promise<void> {
    await this.ensureInitialized()

    const body = asRecord(payload)
    if (!body) {
      throw new Error('Invalid response payload: expected object')
    }

    const id = body.id
    if (typeof id !== 'number' || !Number.isInteger(id)) {
      throw new Error('Invalid response payload: "id" must be an integer')
    }

    const rawError = asRecord(body.error)
    if (rawError) {
      const message = typeof rawError.message === 'string' && rawError.message.trim().length > 0
        ? rawError.message.trim()
        : 'Server request rejected by client'
      const code = typeof rawError.code === 'number' && Number.isFinite(rawError.code)
        ? Math.trunc(rawError.code)
        : -32000
      this.resolvePendingServerRequest(id, { error: { code, message } })
      return
    }

    if (!('result' in body)) {
      throw new Error('Invalid response payload: expected "result" or "error"')
    }

    this.resolvePendingServerRequest(id, { result: body.result })
  }

  listPendingServerRequests(): PendingServerRequest[] {
    return Array.from(this.pendingServerRequests.values())
  }

  dispose(): void {
    if (!this.process) return

    const proc = this.process
    this.stopping = true
    this.process = null
    this.initialized = false
    this.initializePromise = null
    this.readBuffer = ''

    const failure = new Error('codex app-server stopped')
    for (const request of this.pending.values()) {
      request.reject(failure)
    }
    this.pending.clear()
    this.pendingServerRequests.clear()

    try {
      proc.stdin.end()
    } catch {
      // ignore close errors on shutdown
    }

    try {
      proc.kill('SIGTERM')
    } catch {
      // ignore kill errors on shutdown
    }

    const forceKillTimer = setTimeout(() => {
      if (!proc.killed) {
        try {
          proc.kill('SIGKILL')
        } catch {
          // ignore kill errors on shutdown
        }
      }
    }, 1500)
    forceKillTimer.unref()
  }
}

class MethodCatalog {
  private methodCache: string[] | null = null
  private notificationCache: string[] | null = null

  private async runGenerateSchemaCommand(outDir: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const process = spawn('codex', ['app-server', 'generate-json-schema', '--out', outDir], {
        stdio: ['ignore', 'ignore', 'pipe'],
      })

      let stderr = ''

      process.stderr.setEncoding('utf8')
      process.stderr.on('data', (chunk: string) => {
        stderr += chunk
      })

      process.on('error', reject)
      process.on('exit', (code) => {
        if (code === 0) {
          resolve()
          return
        }

        reject(new Error(stderr.trim() || `generate-json-schema exited with code ${String(code)}`))
      })
    })
  }

  private extractMethodsFromClientRequest(payload: unknown): string[] {
    const root = asRecord(payload)
    const oneOf = Array.isArray(root?.oneOf) ? root.oneOf : []
    const methods = new Set<string>()

    for (const entry of oneOf) {
      const row = asRecord(entry)
      const properties = asRecord(row?.properties)
      const methodDef = asRecord(properties?.method)
      const methodEnum = Array.isArray(methodDef?.enum) ? methodDef.enum : []

      for (const item of methodEnum) {
        if (typeof item === 'string' && item.length > 0) {
          methods.add(item)
        }
      }
    }

    return Array.from(methods).sort((a, b) => a.localeCompare(b))
  }

  private extractMethodsFromServerNotification(payload: unknown): string[] {
    const root = asRecord(payload)
    const oneOf = Array.isArray(root?.oneOf) ? root.oneOf : []
    const methods = new Set<string>()

    for (const entry of oneOf) {
      const row = asRecord(entry)
      const properties = asRecord(row?.properties)
      const methodDef = asRecord(properties?.method)
      const methodEnum = Array.isArray(methodDef?.enum) ? methodDef.enum : []

      for (const item of methodEnum) {
        if (typeof item === 'string' && item.length > 0) {
          methods.add(item)
        }
      }
    }

    return Array.from(methods).sort((a, b) => a.localeCompare(b))
  }

  async listMethods(): Promise<string[]> {
    if (this.methodCache) {
      return this.methodCache
    }

    const outDir = await mkdtemp(join(tmpdir(), 'codex-web-local-schema-'))
    await this.runGenerateSchemaCommand(outDir)

    const clientRequestPath = join(outDir, 'ClientRequest.json')
    const raw = await readFile(clientRequestPath, 'utf8')
    const parsed = JSON.parse(raw) as unknown
    const methods = this.extractMethodsFromClientRequest(parsed)

    this.methodCache = methods
    return methods
  }

  async listNotificationMethods(): Promise<string[]> {
    if (this.notificationCache) {
      return this.notificationCache
    }

    const outDir = await mkdtemp(join(tmpdir(), 'codex-web-local-schema-'))
    await this.runGenerateSchemaCommand(outDir)

    const serverNotificationPath = join(outDir, 'ServerNotification.json')
    const raw = await readFile(serverNotificationPath, 'utf8')
    const parsed = JSON.parse(raw) as unknown
    const methods = this.extractMethodsFromServerNotification(parsed)

    this.notificationCache = methods
    return methods
  }
}

type CodexBridgeMiddleware = ((req: IncomingMessage, res: ServerResponse, next: () => void) => Promise<void>) & {
  dispose: () => void
}

type ServerRuntime = {
  appServer: AppServerProcess
  methodCatalog: MethodCatalog
}

class AppServerRuntimeRegistry {
  private readonly runtimesByScope = new Map<string, Map<string, ServerRuntime>>()

  private getScopeRuntimes(scopeKey: string): Map<string, ServerRuntime> {
    const existingScope = this.runtimesByScope.get(scopeKey)
    if (existingScope) return existingScope
    const created = new Map<string, ServerRuntime>()
    this.runtimesByScope.set(scopeKey, created)
    return created
  }

  getRuntime(scopeKey: string, serverId: string): ServerRuntime {
    const scopeRuntimes = this.getScopeRuntimes(scopeKey)
    const existing = scopeRuntimes.get(serverId)
    if (existing) return existing

    const created: ServerRuntime = {
      appServer: new AppServerProcess(),
      methodCatalog: new MethodCatalog(),
    }
    scopeRuntimes.set(serverId, created)
    return created
  }

  disposeServer(scopeKey: string, serverId: string): void {
    const scopeRuntimes = this.runtimesByScope.get(scopeKey)
    if (!scopeRuntimes) return

    const runtime = scopeRuntimes.get(serverId)
    if (!runtime) return
    runtime.appServer.dispose()
    scopeRuntimes.delete(serverId)
    if (scopeRuntimes.size === 0) {
      this.runtimesByScope.delete(scopeKey)
    }
  }

  disposeScope(scopeKey: string): void {
    const scopeRuntimes = this.runtimesByScope.get(scopeKey)
    if (!scopeRuntimes) return

    for (const runtime of scopeRuntimes.values()) {
      runtime.appServer.dispose()
    }
    this.runtimesByScope.delete(scopeKey)
  }

  disposeAll(): void {
    for (const scopeRuntimes of this.runtimesByScope.values()) {
      for (const runtime of scopeRuntimes.values()) {
        runtime.appServer.dispose()
      }
    }
    this.runtimesByScope.clear()
  }
}

class BridgeHttpError extends Error {
  readonly statusCode: number

  constructor(statusCode: number, message: string) {
    super(message)
    this.statusCode = statusCode
  }
}

type ResolvedServerRuntime = {
  scope: ServerRegistryScope
  server: CodexServerRecord
  channelId: RelayChannelId
  runtime: ServerRuntime | null
}

async function resolveServerRuntime(
  req: IncomingMessage,
  url: URL,
  runtimeRegistry: AppServerRuntimeRegistry,
): Promise<ResolvedServerRuntime> {
  const scope = resolveServerRegistryScope(req)
  const registryState = await readServerRegistryState(scope)
  const requestedServerId = getRequestedServerId(req, url)
  const requestedChannelId = getRequestedChannelId(req, url)
  if (!requestedChannelId) {
    throw new BridgeHttpError(400, 'Invalid channelId')
  }
  const selectedServerId = requestedServerId ?? registryState.defaultServerId

  if (!isValidServerId(selectedServerId)) {
    throw new BridgeHttpError(400, `Invalid server id "${selectedServerId}"`)
  }

  const server = registryState.servers.find((item) => item.id === selectedServerId)
  if (!server) {
    throw new BridgeHttpError(404, `Unknown server id "${selectedServerId}"`)
  }

  if (server.transport === 'local' && requestedChannelId !== RELAY_HUB_CHANNEL) {
    throw new BridgeHttpError(409, 'channelId is only supported for relay transport servers')
  }

  if (server.transport === 'relay') {
    const expectedChannelId = server.relay ? `agent:${server.relay.agentId}` : ''
    if (requestedChannelId !== RELAY_HUB_CHANNEL && requestedChannelId !== expectedChannelId) {
      throw new BridgeHttpError(400, `Invalid channel id "${requestedChannelId}" for relay server "${server.id}"`)
    }
  }

  return {
    scope,
    server,
    channelId: requestedChannelId,
    runtime: server.transport === 'relay' ? null : runtimeRegistry.getRuntime(scope.cacheKey, server.id),
  }
}

function requireLocalRuntime(resolved: ResolvedServerRuntime, featureName: string): ServerRuntime {
  if (!resolved.runtime) {
    throw new BridgeHttpError(409, `${featureName} is not available for relay transport servers`)
  }
  return resolved.runtime
}

function mapRelayHubErrorToBridgeError(error: RelayHubError): BridgeHttpError {
  return new BridgeHttpError(error.statusCode, error.message)
}

type SharedBridgeState = {
  runtimeRegistry: AppServerRuntimeRegistry
  relayHub: OutboundRelayHub
}

const SHARED_BRIDGE_KEY = '__codexRemoteSharedBridge__'

function getSharedBridgeState(): SharedBridgeState {
  const globalScope = globalThis as typeof globalThis & {
    [SHARED_BRIDGE_KEY]?: SharedBridgeState
  }

  const existing = globalScope[SHARED_BRIDGE_KEY]
  if (existing) return existing

  const created: SharedBridgeState = {
    runtimeRegistry: new AppServerRuntimeRegistry(),
    relayHub: new OutboundRelayHub(),
  }
  globalScope[SHARED_BRIDGE_KEY] = created
  return created
}

type ServerTransportConfig = {
  transport: CodexServerTransport
  relay?: CodexRelayServerConfig
}

type ServerTransportConfigResult =
  | { ok: true; value: ServerTransportConfig }
  | { ok: false; error: string }

function parseExplicitTransportValue(value: unknown): CodexServerTransport | null {
  if (value === undefined) return null
  if (typeof value !== 'string') return null
  const normalized = value.trim()
  if (normalized === 'local' || normalized === 'relay') {
    return normalized
  }
  return null
}

function resolveCreateServerTransportConfig(payload: Record<string, unknown>): ServerTransportConfigResult {
  const explicitTransport = parseExplicitTransportValue(payload.transport)
  if (payload.transport !== undefined && explicitTransport === null) {
    return {
      ok: false,
      error: 'Invalid body: "transport" must be "local" or "relay"',
    }
  }

  const transport = explicitTransport ?? 'local'
  if (transport === 'local') {
    return {
      ok: true,
      value: { transport: 'local' },
    }
  }

  const relay = normalizeRelayServerConfig(payload.relay)
  if (!relay) {
    return {
      ok: false,
      error: 'Relay transport requires relay.agentId',
    }
  }

  return {
    ok: true,
    value: {
      transport: 'relay',
      relay,
    },
  }
}

function resolveUpdatedServerTransportConfig(
  payload: Record<string, unknown>,
  currentServer: CodexServerRecord,
): ServerTransportConfigResult {
  const explicitTransport = parseExplicitTransportValue(payload.transport)
  if (payload.transport !== undefined && explicitTransport === null) {
    return {
      ok: false,
      error: 'Invalid body: "transport" must be "local" or "relay"',
    }
  }

  if (payload.relay !== undefined && payload.relay !== null && asRecord(payload.relay) === null) {
    return {
      ok: false,
      error: 'Invalid body: "relay" must be an object',
    }
  }

  const hasRelayPayload = payload.relay !== undefined
  let transport: CodexServerTransport = explicitTransport ?? currentServer.transport
  if (!explicitTransport && hasRelayPayload) {
    if (currentServer.transport !== 'relay') {
      return {
        ok: false,
        error: 'Relay config requires transport="relay"',
      }
    }
    transport = 'relay'
  }

  if (transport === 'local') {
    return {
      ok: true,
      value: { transport: 'local' },
    }
  }

  const relay = hasRelayPayload
    ? normalizeRelayServerConfig(payload.relay)
    : currentServer.relay ?? null

  if (!relay) {
    return {
      ok: false,
      error: 'Relay transport requires relay.agentId',
    }
  }

  return {
    ok: true,
    value: {
      transport: 'relay',
      relay,
    },
  }
}

function requireAdminUser(req: IncomingMessage): { id: string; username: string } {
  const user = getRequestAuthenticatedUser(req)
  if (!user) {
    throw new BridgeHttpError(401, 'Authentication required')
  }
  if (user.role !== 'admin') {
    throw new BridgeHttpError(403, 'Admin role required')
  }
  return {
    id: user.id,
    username: user.username,
  }
}

function readBearerToken(req: IncomingMessage): string {
  const authorization = req.headers.authorization
  if (!authorization || typeof authorization !== 'string') {
    return ''
  }

  const [scheme, token] = authorization.split(/\s+/u, 2)
  if (!scheme || !token || scheme.toLowerCase() !== 'bearer') {
    return ''
  }

  return token.trim()
}

export function createCodexBridgeMiddleware(): CodexBridgeMiddleware {
  const { runtimeRegistry, relayHub } = getSharedBridgeState()
  const relayRateLimitByIp = new Map<string, RelayEndpointRateLimitRecord>()
  const relayRateLimitByClientKey = new Map<string, RelayEndpointRateLimitRecord>()

  function enforceRelayRateLimit(req: IncomingMessage, res: ServerResponse): boolean {
    const decision = consumeRelayEndpointRateLimit(req, relayRateLimitByIp, relayRateLimitByClientKey)
    if (!decision.limited) return true

    res.setHeader('Retry-After', String(decision.retryAfterSeconds))
    setJson(res, 429, {
      error: 'Too many relay agent requests. Try again later.',
      retryAfterSeconds: decision.retryAfterSeconds,
    })
    return false
  }

  const middleware = async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    try {
      if (!req.url) {
        next()
        return
      }

      const url = new URL(req.url, 'http://localhost')
      const serverResourceId = parseServerResourceId(url.pathname)
      const connectorResource = parseConnectorResourceParts(url.pathname)
      const registryScope = resolveServerRegistryScope(req)

      if (url.pathname.startsWith('/codex-api/servers/') && serverResourceId === null) {
        setJson(res, 400, { error: 'Invalid server resource path' })
        return
      }
      if (url.pathname.startsWith('/codex-api/connectors/') && connectorResource === null) {
        setJson(res, 400, { error: 'Invalid connector resource path' })
        return
      }

      if (req.method === 'GET' && url.pathname === '/codex-api/admin/users') {
        const authenticatedUser = getRequestAuthenticatedUser(req)
        if (!authenticatedUser) {
          setJson(res, 401, { error: 'Authentication required' })
          return
        }
        if (authenticatedUser.role !== 'admin') {
          setJson(res, 403, { error: 'Admin role required' })
          return
        }

        const users = await listUsers()
        setJson(res, 200, { data: users })
        return
      }

      if (url.pathname === '/codex-api/admin/users') {
        setJson(res, 405, { error: 'Method not allowed' })
        return
      }

      if (req.method === 'GET' && url.pathname === '/codex-api/connectors') {
        const authenticatedUser = getRequestAuthenticatedUser(req)
        if (!authenticatedUser) {
          setJson(res, 401, { error: 'Authentication required' })
          return
        }

        await syncRelayHubPersistedAgents(relayHub)
        const registry = await readConnectorRegistryState(registryScope, { persistNormalized: true })
        const includeStats = ['1', 'true', 'yes'].includes((url.searchParams.get('includeStats') ?? '').trim().toLowerCase())
        const enriched = await buildConnectorPublicRecords(registry.connectors, registryScope, relayHub, includeStats)
        if (enriched.changed) {
          await writeConnectorRegistryState(registryScope, { connectors: enriched.nextRecords })
        }
        setJson(res, 200, {
          data: {
            connectors: enriched.publicRecords,
          },
        })
        return
      }

      if (req.method === 'POST' && url.pathname === '/codex-api/connectors') {
        const authenticatedUser = getRequestAuthenticatedUser(req)
        if (!authenticatedUser) {
          setJson(res, 401, { error: 'Authentication required' })
          return
        }

        const payload = asRecord(await readJsonBody(req))
        if (!payload) {
          setJson(res, 400, { error: 'Invalid body: expected object' })
          return
        }

        const connectorId = typeof payload.id === 'string' ? payload.id.trim() : ''
        if (!connectorId) {
          setJson(res, 400, { error: 'Explicit connector id is required' })
          return
        }
        if (!isValidConnectorId(connectorId)) {
          setJson(res, 400, { error: `Invalid connector id "${connectorId}"` })
          return
        }

        const registry = await readConnectorRegistryState(registryScope, { persistNormalized: true })
        if (registry.connectors.some((connector) => connector.id === connectorId)) {
          setJson(res, 409, { error: `Connector "${connectorId}" already exists` })
          return
        }
        const serverRegistry = await readServerRegistryState(registryScope, { persistNormalized: true })
        if (serverRegistry.servers.some((server) => server.id === connectorId)) {
          setJson(res, 409, { error: `Server "${connectorId}" already exists` })
          return
        }

        const name = typeof payload.name === 'string' && payload.name.trim().length > 0
          ? payload.name.trim()
          : connectorId
        const hubAddress = normalizeHubAddress(payload.hubAddress) || inferHubAddress(req)
        if (!hubAddress) {
          setJson(res, 400, { error: 'Valid hubAddress is required' })
          return
        }
        const relayE2ee = payload.e2ee === undefined
          ? undefined
          : normalizeRelayE2eeConfig(payload.e2ee)
        if (payload.e2ee !== undefined && relayE2ee === null) {
          setJson(res, 400, { error: 'Invalid connector E2EE configuration' })
          return
        }

        const created = relayHub.createAgent(name)
        const connector: CodexConnectorRecord = {
          id: connectorId,
          serverId: connectorId,
          name,
          hubAddress,
          relayAgentId: created.agent.id,
          ...(relayE2ee?.keyId ? { relayE2eeKeyId: relayE2ee.keyId } : {}),
          tokenHash: created.tokenHash,
          createdAtIso: created.agent.createdAtIso,
          updatedAtIso: created.agent.updatedAtIso,
        }
        const nextState: ConnectorRegistryState = {
          connectors: [...registry.connectors, connector],
        }
        await writeConnectorRegistryState(registryScope, nextState)
        await upsertConnectorBoundServer(registryScope, connector)
        relayHub.upsertPersistedAgent({
          id: connector.relayAgentId,
          name: connector.name,
          tokenHash: connector.tokenHash,
          createdAtIso: connector.createdAtIso,
          updatedAtIso: connector.updatedAtIso,
        })
        setJson(res, 201, {
          data: {
            connector: toPublicConnectorRecord(connector, relayHub),
            token: created.token,
          },
        })
        return
      }

      if (connectorResource) {
        const authenticatedUser = getRequestAuthenticatedUser(req)
        if (!authenticatedUser) {
          setJson(res, 401, { error: 'Authentication required' })
          return
        }

        const connectorId = connectorResource.connectorId
        if (!isValidConnectorId(connectorId)) {
          setJson(res, 400, { error: `Invalid connector id "${connectorId}"` })
          return
        }

        const registry = await readConnectorRegistryState(registryScope, { persistNormalized: true })
        const connectorIndex = registry.connectors.findIndex((connector) => connector.id === connectorId)
        if (connectorIndex === -1) {
          setJson(res, 404, { error: `Connector "${connectorId}" not found` })
          return
        }
        const currentConnector = registry.connectors[connectorIndex]

        if (req.method === 'PATCH' && connectorResource.action === null) {
          const payload = asRecord(await readJsonBody(req))
          if (!payload) {
            setJson(res, 400, { error: 'Invalid body: expected object' })
            return
          }
          if ('name' in payload && typeof payload.name !== 'string') {
            setJson(res, 400, { error: 'Invalid body: "name" must be a string' })
            return
          }

          const nextName = typeof payload.name === 'string' && payload.name.trim().length > 0
            ? payload.name.trim()
            : currentConnector.name
          const nextConnector: CodexConnectorRecord = {
            ...currentConnector,
            name: nextName,
            updatedAtIso: new Date().toISOString(),
          }
          const nextConnectors = [...registry.connectors]
          nextConnectors[connectorIndex] = nextConnector
          await writeConnectorRegistryState(registryScope, { connectors: nextConnectors })
          relayHub.renameAgent(nextConnector.relayAgentId, nextConnector.name)
          await upsertConnectorBoundServer(registryScope, nextConnector)
          setJson(res, 200, {
            data: {
              connector: toPublicConnectorRecord(nextConnector, relayHub, {
                projectCount: nextConnector.lastKnownProjectCount,
                threadCount: nextConnector.lastKnownThreadCount,
                lastStatsAtIso: nextConnector.lastStatsAtIso,
              }),
            },
          })
          return
        }

        if (req.method === 'DELETE' && connectorResource.action === null) {
          const nextConnectors = registry.connectors.filter((connector) => connector.id !== connectorId)
          await writeConnectorRegistryState(registryScope, { connectors: nextConnectors })
          relayHub.revokeAgent(currentConnector.relayAgentId)
          await removeConnectorBoundServer(registryScope, currentConnector.serverId, runtimeRegistry)
          setJson(res, 200, { ok: true, data: { connectors: nextConnectors.map((connector) => toPublicConnectorRecord(connector, relayHub)) } })
          return
        }

        if (req.method === 'POST' && connectorResource.action === 'rotate-token') {
          const rotated = relayHub.rotateAgentToken(currentConnector.relayAgentId)
          const nextConnector: CodexConnectorRecord = {
            ...currentConnector,
            tokenHash: rotated.tokenHash,
            updatedAtIso: new Date().toISOString(),
          }
          const nextConnectors = [...registry.connectors]
          nextConnectors[connectorIndex] = nextConnector
          await writeConnectorRegistryState(registryScope, { connectors: nextConnectors })
          setJson(res, 200, {
            data: {
              connector: toPublicConnectorRecord(nextConnector, relayHub, {
                projectCount: nextConnector.lastKnownProjectCount,
                threadCount: nextConnector.lastKnownThreadCount,
                lastStatsAtIso: nextConnector.lastStatsAtIso,
              }),
              token: rotated.token,
            },
          })
          return
        }

        setJson(res, 405, { error: 'Method not allowed' })
        return
      }

      if (url.pathname === '/codex-api/connectors') {
        setJson(res, 405, { error: 'Method not allowed' })
        return
      }

      if (req.method === 'GET' && url.pathname === '/codex-api/relay/agents') {
        requireAdminUser(req)
        await syncRelayHubPersistedAgents(relayHub)
        setJson(res, 200, { data: relayHub.listAgents() })
        return
      }

      if (req.method === 'POST' && url.pathname === '/codex-api/relay/agents') {
        requireLoopbackForSensitiveMutation(req, 'Relay agent provisioning')
        requireAdminUser(req)
        const payload = asRecord(await readJsonBody(req))
        const name = typeof payload?.name === 'string' ? payload.name : undefined
        const created = relayHub.createAgent(name)
        setJson(res, 201, { data: { agent: created.agent, token: created.token } })
        return
      }

      if (req.method === 'POST' && url.pathname === '/codex-api/relay/agent/connect') {
        try {
          if (!enforceRelayRateLimit(req, res)) {
            return
          }
          await syncRelayHubPersistedAgents(relayHub)
          const token = readBearerToken(req)
          const connected = relayHub.connectWithToken(token)
          setJson(res, 200, { data: connected })
          return
        } catch (error) {
          if (error instanceof RelayHubError) {
            throw mapRelayHubErrorToBridgeError(error)
          }
          throw error
        }
      }

      if (req.method === 'GET' && url.pathname === '/codex-api/relay/agent/pull') {
        try {
          if (!enforceRelayRateLimit(req, res)) {
            return
          }
          const token = readBearerToken(req)
          const sessionId = url.searchParams.get('sessionId')?.trim() ?? ''
          if (!sessionId) {
            setJson(res, 400, { error: 'Missing sessionId' })
            return
          }
          const waitMs = url.searchParams.get('waitMs')
          const messages = await relayHub.pullMessagesAuthenticated(token, sessionId, waitMs === null ? undefined : Number(waitMs))
          setJson(res, 200, { data: { messages } })
          return
        } catch (error) {
          if (error instanceof RelayHubError) {
            throw mapRelayHubErrorToBridgeError(error)
          }
          throw error
        }
      }

      if (req.method === 'POST' && url.pathname === '/codex-api/relay/agent/push') {
        try {
          if (!enforceRelayRateLimit(req, res)) {
            return
          }
          const token = readBearerToken(req)
          const sessionId = url.searchParams.get('sessionId')?.trim() ?? ''
          if (!sessionId) {
            setJson(res, 400, { error: 'Missing sessionId' })
            return
          }
          const payload = asRecord(await readJsonBody(req))
          const messages = Array.isArray(payload?.messages) ? payload.messages : []
          const result = relayHub.pushMessagesAuthenticated(token, sessionId, messages)
          setJson(res, 200, { data: result })
          return
        } catch (error) {
          if (error instanceof RelayHubError) {
            throw mapRelayHubErrorToBridgeError(error)
          }
          throw error
        }
      }

      if (url.pathname.startsWith('/codex-api/relay/')) {
        setJson(res, 405, { error: 'Method not allowed' })
        return
      }

      if (req.method === 'GET' && url.pathname === '/codex-api/servers') {
        const state = await readServerRegistryState(registryScope, { persistNormalized: true })
        setJson(res, 200, { data: state })
        return
      }

      if (req.method === 'POST' && url.pathname === '/codex-api/servers') {
        requireLoopbackForSensitiveMutation(req, 'Server registry updates')
        const payload = asRecord(await readJsonBody(req))
        if (!payload) {
          setJson(res, 400, { error: 'Invalid body: expected object' })
          return
        }

        const providedServerId = typeof payload.id === 'string' ? payload.id.trim() : ''
        if (providedServerId.length === 0) {
          setJson(res, 400, { error: 'Explicit server id is required' })
          return
        }
        if (!isValidServerId(providedServerId)) {
          setJson(res, 400, { error: `Invalid server id "${providedServerId}"` })
          return
        }

        const providedName = typeof payload.name === 'string' ? payload.name.trim() : ''
        const makeDefault = payload.isDefault === true || payload.makeDefault === true || payload.default === true
        const transportConfig = resolveCreateServerTransportConfig(payload)
        if (!transportConfig.ok) {
          setJson(res, 400, { error: transportConfig.error })
          return
        }
        const state = await readServerRegistryState(registryScope, { persistNormalized: true })
        const existingIds = new Set(state.servers.map((server) => server.id))
        if (existingIds.has(providedServerId)) {
          setJson(res, 409, { error: `Server "${providedServerId}" already exists` })
          return
        }

        const nowIso = new Date().toISOString()
        const nextServer: CodexServerRecord = {
          id: providedServerId,
          name: providedName.length > 0 ? providedName : `Server ${String(state.servers.length + 1)}`,
          transport: transportConfig.value.transport,
          ...(transportConfig.value.relay ? { relay: transportConfig.value.relay } : {}),
          createdAtIso: nowIso,
          updatedAtIso: nowIso,
        }
        const nextState: ServerRegistryState = {
          defaultServerId: makeDefault || state.defaultServerId.trim().length === 0
            ? providedServerId
            : state.defaultServerId,
          servers: [...state.servers, nextServer],
        }
        await writeServerRegistryState(registryScope, nextState)
        setJson(res, 201, { data: { server: nextServer, registry: nextState } })
        return
      }

      if (url.pathname === '/codex-api/servers') {
        setJson(res, 405, { error: 'Method not allowed' })
        return
      }

      if (serverResourceId !== null && url.pathname !== '/codex-api/servers') {
        if (!isValidServerId(serverResourceId)) {
          setJson(res, 400, { error: `Invalid server id "${serverResourceId}"` })
          return
        }

        if (req.method === 'GET') {
          const state = await readServerRegistryState(registryScope, { persistNormalized: true })
          const server = state.servers.find((item) => item.id === serverResourceId)
          if (!server) {
            setJson(res, 404, { error: `Server "${serverResourceId}" not found` })
            return
          }
          setJson(res, 200, { data: { ...server, isDefault: state.defaultServerId === server.id } })
          return
        }

        if (req.method === 'PUT') {
          requireLoopbackForSensitiveMutation(req, 'Server registry updates')
          const payload = asRecord(await readJsonBody(req))
          if (!payload) {
            setJson(res, 400, { error: 'Invalid body: expected object' })
            return
          }
          if ('name' in payload && typeof payload.name !== 'string') {
            setJson(res, 400, { error: 'Invalid body: "name" must be a string' })
            return
          }

          const state = await readServerRegistryState(registryScope, { persistNormalized: true })
          const serverIndex = state.servers.findIndex((item) => item.id === serverResourceId)
          if (serverIndex === -1) {
            setJson(res, 404, { error: `Server "${serverResourceId}" not found` })
            return
          }

          const rawDefaultFlag = payload.isDefault ?? payload.makeDefault ?? payload.default
          if (rawDefaultFlag !== undefined && typeof rawDefaultFlag !== 'boolean') {
            setJson(res, 400, { error: 'Invalid body: "isDefault" must be a boolean' })
            return
          }

          const nextName = typeof payload.name === 'string' && payload.name.trim().length > 0
            ? payload.name.trim()
            : state.servers[serverIndex].name
          const transportConfig = resolveUpdatedServerTransportConfig(payload, state.servers[serverIndex])
          if (!transportConfig.ok) {
            setJson(res, 400, { error: transportConfig.error })
            return
          }
          const updatedServer: CodexServerRecord = {
            ...state.servers[serverIndex],
            name: nextName,
            transport: transportConfig.value.transport,
            ...(transportConfig.value.relay ? { relay: transportConfig.value.relay } : {}),
            ...(transportConfig.value.transport === 'local' ? { relay: undefined } : {}),
            updatedAtIso: new Date().toISOString(),
          }
          const nextServers = [...state.servers]
          nextServers[serverIndex] = updatedServer

          let nextDefaultServerId = state.defaultServerId
          if (rawDefaultFlag === true) {
            nextDefaultServerId = serverResourceId
          } else if (rawDefaultFlag === false && state.defaultServerId === serverResourceId) {
            setJson(res, 400, { error: 'Cannot unset default server without selecting another default' })
            return
          }

          const nextState: ServerRegistryState = {
            defaultServerId: nextDefaultServerId,
            servers: nextServers,
          }
          await writeServerRegistryState(registryScope, nextState)
          setJson(res, 200, { data: { server: updatedServer, registry: nextState } })
          return
        }

        if (req.method === 'DELETE') {
          requireLoopbackForSensitiveMutation(req, 'Server registry updates')
          const state = await readServerRegistryState(registryScope, { persistNormalized: true })
          const targetServer = state.servers.find((item) => item.id === serverResourceId)
          if (!targetServer) {
            setJson(res, 404, { error: `Server "${serverResourceId}" not found` })
            return
          }

          const remainingServers = state.servers.filter((item) => item.id !== serverResourceId)
          let nextDefaultServerId = state.defaultServerId

          if (remainingServers.length === 0) {
            nextDefaultServerId = ''
          } else if (state.defaultServerId === serverResourceId) {
            nextDefaultServerId = remainingServers[0].id
          }

          const nextState: ServerRegistryState = {
            defaultServerId: nextDefaultServerId,
            servers: remainingServers,
          }
          await writeServerRegistryState(registryScope, nextState)
          runtimeRegistry.disposeServer(registryScope.cacheKey, serverResourceId)
          setJson(res, 200, { ok: true, data: nextState })
          return
        }

        setJson(res, 405, { error: 'Method not allowed' })
        return
      }

      if (req.method === 'POST' && url.pathname === '/codex-api/rpc') {
        const resolved = await resolveServerRuntime(req, url, runtimeRegistry)
        const payload = await readJsonBody(req)
        const body = asRecord(payload) as RpcProxyRequest | null
        const method = typeof body?.method === 'string' ? body.method.trim() : ''
        const encryptedRelayPayload = body ? normalizeRelayE2eeEnvelope(body.e2ee) : null
        if (body?.e2ee !== undefined && encryptedRelayPayload === null) {
          setJson(res, 400, { error: 'Invalid body: malformed relay E2EE envelope' })
          return
        }

        if (!body || (method.length === 0 && encryptedRelayPayload === null)) {
          setJson(res, 400, { error: 'Invalid body: expected { method, params? } or { e2ee }' })
          return
        }

        if (resolved.server.transport === 'relay') {
          const relayConfig = resolved.server.relay
          if (!relayConfig) {
            setJson(res, 503, { error: `Relay server "${resolved.server.id}" is missing relay configuration` })
            return
          }
          if (encryptedRelayPayload) {
            const relayE2eeConfig = relayConfig.e2ee
            if (!relayE2eeConfig) {
              setJson(res, 409, { error: `Relay server "${resolved.server.id}" does not allow E2EE payloads` })
              return
            }
            if (
              encryptedRelayPayload.keyId !== relayE2eeConfig.keyId
              || encryptedRelayPayload.algorithm !== relayE2eeConfig.algorithm
            ) {
              setJson(res, 400, { error: 'Relay E2EE payload does not match configured relay policy' })
              return
            }
          }
          try {
            const relayMethod = encryptedRelayPayload ? RELAY_E2EE_RPC_METHOD : method
            const relayParams = encryptedRelayPayload
              ? { e2ee: encryptedRelayPayload }
              : (body.params ?? null)
            const result = await relayHub.dispatchRpc(
              {
                scopeKey: resolved.scope.cacheKey,
                serverId: resolved.server.id,
                agentId: relayConfig.agentId,
              },
              relayMethod,
              relayParams,
              relayConfig.requestTimeoutMs,
            )
            setJson(res, 200, { result })
            return
          } catch (error) {
            if (error instanceof RelayHubError) {
              throw mapRelayHubErrorToBridgeError(error)
            }
            throw error
          }
        }

        if (encryptedRelayPayload) {
          setJson(res, 409, { error: 'Relay E2EE payloads are only supported for relay transport servers' })
          return
        }

        const runtime = requireLocalRuntime(resolved, 'RPC proxy')
        const result = await runtime.appServer.rpc(method, body.params ?? null)
        setJson(res, 200, { result })
        return
      }

      if (req.method === 'POST' && url.pathname === '/codex-api/transcribe') {
        const auth = await readCodexAuth()
        if (!auth) {
          setJson(res, 401, { error: 'No auth token available for transcription' })
          return
        }

        const rawBody = await readRawBody(req, MAX_TRANSCRIBE_BODY_BYTES)
        const incomingCt = req.headers['content-type'] ?? 'application/octet-stream'
        const upstream = await proxyTranscribe(rawBody, incomingCt, auth.accessToken, auth.accountId)

        res.statusCode = upstream.status
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
        res.end(upstream.body)
        return
      }

      if (req.method === 'POST' && url.pathname === '/codex-api/server-requests/respond') {
        const resolved = await resolveServerRuntime(req, url, runtimeRegistry)
        const runtime = requireLocalRuntime(resolved, 'Server request replies')
        const payload = await readJsonBody(req)
        await runtime.appServer.respondToServerRequest(payload)
        setJson(res, 200, { ok: true })
        return
      }

      if (req.method === 'GET' && url.pathname === '/codex-api/server-requests/pending') {
        const resolved = await resolveServerRuntime(req, url, runtimeRegistry)
        if (resolved.server.transport === 'relay') {
          setJson(res, 200, { data: [] })
          return
        }
        const runtime = requireLocalRuntime(resolved, 'Pending server requests')
        setJson(res, 200, { data: runtime.appServer.listPendingServerRequests() })
        return
      }

      if (req.method === 'GET' && url.pathname === '/codex-api/meta/methods') {
        const resolved = await resolveServerRuntime(req, url, runtimeRegistry)
        if (resolved.server.transport === 'relay') {
          setJson(res, 200, { data: [] })
          return
        }
        const runtime = requireLocalRuntime(resolved, 'Method catalog')
        const methods = await runtime.methodCatalog.listMethods()
        setJson(res, 200, { data: methods })
        return
      }

      if (req.method === 'GET' && url.pathname === '/codex-api/meta/notifications') {
        const resolved = await resolveServerRuntime(req, url, runtimeRegistry)
        if (resolved.server.transport === 'relay') {
          setJson(res, 200, { data: [] })
          return
        }
        const runtime = requireLocalRuntime(resolved, 'Notification catalog')
        const methods = await runtime.methodCatalog.listNotificationMethods()
        setJson(res, 200, { data: methods })
        return
      }

      if (req.method === 'GET' && url.pathname === '/codex-api/workspace-roots-state') {
        const state = await readWorkspaceRootsState()
        setJson(res, 200, { data: state })
        return
      }

      if (req.method === 'PUT' && url.pathname === '/codex-api/workspace-roots-state') {
        const payload = await readJsonBody(req)
        const record = asRecord(payload)
        if (!record) {
          setJson(res, 400, { error: 'Invalid body: expected object' })
          return
        }
        const nextState: WorkspaceRootsState = {
          order: normalizeStringArray(record.order),
          labels: normalizeStringRecord(record.labels),
          active: normalizeStringArray(record.active),
        }
        await writeWorkspaceRootsState(nextState)
        setJson(res, 200, { ok: true })
        return
      }

      if (req.method === 'POST' && url.pathname === '/codex-api/project-root') {
        requireLoopbackForSensitiveMutation(req, 'Project root changes')
        const payload = asRecord(await readJsonBody(req))
        const rawPath = typeof payload?.path === 'string' ? payload.path.trim() : ''
        const createIfMissing = payload?.createIfMissing === true
        const label = typeof payload?.label === 'string' ? payload.label : ''
        if (!rawPath) {
          setJson(res, 400, { error: 'Missing path' })
          return
        }

        const normalizedPath = isAbsolute(rawPath) ? rawPath : resolve(rawPath)
        const userHomePath = homedir()
        let pathExists = true
        try {
          const info = await stat(normalizedPath)
          if (!info.isDirectory()) {
            setJson(res, 400, { error: 'Path exists but is not a directory' })
            return
          }
        } catch {
          pathExists = false
        }

        if (!pathExists && createIfMissing) {
          ensurePathInside(userHomePath, normalizedPath, 'Refusing to create directories outside your home path')
          await mkdir(normalizedPath, { recursive: true })
        } else if (!pathExists) {
          setJson(res, 404, { error: 'Directory does not exist' })
          return
        }

        const existingState = await readWorkspaceRootsState()
        const nextOrder = [normalizedPath, ...existingState.order.filter((item) => item !== normalizedPath)]
        const nextActive = [normalizedPath, ...existingState.active.filter((item) => item !== normalizedPath)]
        const nextLabels = { ...existingState.labels }
        if (label.trim().length > 0) {
          nextLabels[normalizedPath] = label.trim()
        }
        await writeWorkspaceRootsState({
          order: nextOrder,
          labels: nextLabels,
          active: nextActive,
        })
        setJson(res, 200, { data: { path: normalizedPath } })
        return
      }

      if (req.method === 'GET' && url.pathname === '/codex-api/fs/list') {
        const homePath = homedir()
        const rawPath = url.searchParams.get('path')?.trim() ?? ''
        const currentPath = rawPath.length > 0 ? (isAbsolute(rawPath) ? rawPath : resolve(rawPath)) : homePath

        try {
          const info = await stat(currentPath)
          if (!info.isDirectory()) {
            setJson(res, 400, { error: 'Path exists but is not a directory' })
            return
          }
        } catch (error) {
          const code = (error as NodeJS.ErrnoException | undefined)?.code
          if (code === 'ENOENT') {
            setJson(res, 404, { error: 'Directory does not exist' })
            return
          }
          setJson(res, 500, { error: 'Failed to access directory' })
          return
        }

        try {
          const parentCandidate = dirname(currentPath)
          const entries = (await readdir(currentPath, { withFileTypes: true }))
            .filter((entry) => entry.isDirectory())
            .map((entry) => ({ name: entry.name, path: join(currentPath, entry.name) }))
            .sort((a, b) => a.name.localeCompare(b.name))

          setJson(res, 200, {
            data: {
              currentPath,
              homePath,
              parentPath: parentCandidate === currentPath ? null : parentCandidate,
              entries,
            },
          })
          return
        } catch {
          setJson(res, 500, { error: 'Failed to read directory' })
          return
        }
      }

      if (req.method === 'GET' && url.pathname === '/codex-api/project-root-suggestion') {
        const basePath = url.searchParams.get('basePath')?.trim() ?? ''
        if (!basePath) {
          setJson(res, 400, { error: 'Missing basePath' })
          return
        }
        const normalizedBasePath = isAbsolute(basePath) ? basePath : resolve(basePath)
        try {
          const baseInfo = await stat(normalizedBasePath)
          if (!baseInfo.isDirectory()) {
            setJson(res, 400, { error: 'basePath is not a directory' })
            return
          }
        } catch {
          setJson(res, 404, { error: 'basePath does not exist' })
          return
        }

        let index = 1
        while (index < 100000) {
          const candidateName = `New Project (${String(index)})`
          const candidatePath = join(normalizedBasePath, candidateName)
          try {
            await stat(candidatePath)
            index += 1
            continue
          } catch {
            setJson(res, 200, { data: { name: candidateName, path: candidatePath } })
            return
          }
        }

        setJson(res, 500, { error: 'Failed to compute project name suggestion' })
        return
      }

      if (req.method === 'POST' && url.pathname === '/codex-api/composer-file-search') {
        const payload = asRecord(await readJsonBody(req))
        const rawCwd = typeof payload?.cwd === 'string' ? payload.cwd.trim() : ''
        const query = typeof payload?.query === 'string' ? payload.query.trim() : ''
        const limitRaw = typeof payload?.limit === 'number' ? payload.limit : 20
        const limit = Math.max(1, Math.min(100, Math.floor(limitRaw)))
        if (!rawCwd) {
          setJson(res, 400, { error: 'Missing cwd' })
          return
        }
        const cwd = isAbsolute(rawCwd) ? rawCwd : resolve(rawCwd)
        try {
          const info = await stat(cwd)
          if (!info.isDirectory()) {
            setJson(res, 400, { error: 'cwd is not a directory' })
            return
          }
        } catch {
          setJson(res, 404, { error: 'cwd does not exist' })
          return
        }

        try {
          const files = await listFilesWithRipgrep(cwd)
          const scored = files
            .map((path) => ({ path, score: scoreFileCandidate(path, query) }))
            .filter((row) => query.length === 0 || row.score < 10)
            .sort((a, b) => (a.score - b.score) || a.path.localeCompare(b.path))
            .slice(0, limit)
            .map((row) => ({ path: row.path }))
          setJson(res, 200, { data: scored })
        } catch (error) {
          setJson(res, 500, { error: getErrorMessage(error, 'Failed to search files') })
        }
        return
      }

      if (req.method === 'GET' && url.pathname === '/codex-api/thread-titles') {
        const cache = await readThreadTitleCache()
        setJson(res, 200, { data: cache })
        return
      }

      if (req.method === 'PUT' && url.pathname === '/codex-api/thread-titles') {
        const payload = asRecord(await readJsonBody(req))
        const id = typeof payload?.id === 'string' ? payload.id : ''
        const title = typeof payload?.title === 'string' ? payload.title : ''
        if (!id) {
          setJson(res, 400, { error: 'Missing id' })
          return
        }
        const cache = await readThreadTitleCache()
        const next = title ? updateThreadTitleCache(cache, id, title) : removeFromThreadTitleCache(cache, id)
        await writeThreadTitleCache(next)
        setJson(res, 200, { ok: true })
        return
      }

      if (req.method === 'GET' && url.pathname === '/codex-api/skills-hub') {
        try {
          const resolved = await resolveServerRuntime(req, url, runtimeRegistry)
          const runtime = requireLocalRuntime(resolved, 'Skills hub')
          const q = url.searchParams.get('q') || ''
          const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '50', 10) || 50, 1), 200)
          const sort = url.searchParams.get('sort') || 'date'
          const allEntries = await fetchSkillsTree()

          const installedMap = await scanInstalledSkillsFromDisk()
          try {
            const result = (await runtime.appServer.rpc('skills/list', {})) as { data?: Array<{ skills?: Array<{ name?: string; path?: string; enabled?: boolean }> }> }
            for (const entry of result.data ?? []) {
              for (const skill of entry.skills ?? []) {
                if (skill.name) {
                  installedMap.set(skill.name, { name: skill.name, path: skill.path ?? '', enabled: skill.enabled !== false })
                }
              }
            }
          } catch {}

          const installedHubEntries = allEntries.filter((e) => installedMap.has(e.name))
          await fetchMetaBatch(installedHubEntries)

          const installed: SkillHubEntry[] = []
          for (const [, info] of installedMap) {
            const hubEntry = allEntries.find((e) => e.name === info.name)
            const base = hubEntry ? buildHubEntry(hubEntry) : {
              name: info.name, owner: 'local', description: '', displayName: '',
              publishedAt: 0, avatarUrl: '', url: '', installed: false,
            }
            installed.push({ ...base, installed: true, path: info.path, enabled: info.enabled })
          }

          const results = await searchSkillsHub(allEntries, q, limit, sort, installedMap)
          setJson(res, 200, { data: results, installed, total: allEntries.length })
        } catch (error) {
          setJson(res, 502, { error: getErrorMessage(error, 'Failed to fetch skills hub') })
        }
        return
      }

      if (req.method === 'GET' && url.pathname === '/codex-api/skills-hub/readme') {
        try {
          const owner = url.searchParams.get('owner') || ''
          const name = url.searchParams.get('name') || ''
          if (!owner || !name) {
            setJson(res, 400, { error: 'Missing owner or name' })
            return
          }
          const rawUrl = `https://raw.githubusercontent.com/openclaw/skills/main/skills/${owner}/${name}/SKILL.md`
          const resp = await fetch(rawUrl)
          if (!resp.ok) throw new Error(`Failed to fetch SKILL.md: ${resp.status}`)
          const content = await resp.text()
          setJson(res, 200, { content })
        } catch (error) {
          setJson(res, 502, { error: getErrorMessage(error, 'Failed to fetch SKILL.md') })
        }
        return
      }

      if (req.method === 'POST' && url.pathname === '/codex-api/skills-hub/install') {
        try {
          requireLoopbackForSensitiveMutation(req, 'Skills installation')
          const resolved = await resolveServerRuntime(req, url, runtimeRegistry)
          const runtime = requireLocalRuntime(resolved, 'Skills installation')
          const payload = asRecord(await readJsonBody(req))
          const owner = typeof payload?.owner === 'string' ? payload.owner : ''
          const name = typeof payload?.name === 'string' ? payload.name : ''
          if (!owner || !name) {
            setJson(res, 400, { error: 'Missing owner or name' })
            return
          }
          const installerScript = '/Users/igor/.cursor/skills/.system/skill-installer/scripts/install-skill-from-github.py'
          const installDest = await detectUserSkillsDir(runtime.appServer)
          const skillPathInRepo = `skills/${owner}/${name}`
          await runCommand('python3', [
            installerScript,
            '--repo', 'openclaw/skills',
            '--path', skillPathInRepo,
            '--dest', installDest,
            '--method', 'git',
          ])
          const skillDir = join(installDest, name)
          await ensureInstalledSkillIsValid(runtime.appServer, skillDir)
          setJson(res, 200, { ok: true, path: skillDir })
        } catch (error) {
          if (error instanceof BridgeHttpError) {
            setJson(res, error.statusCode, { error: error.message })
            return
          }
          setJson(res, 502, { error: getErrorMessage(error, 'Failed to install skill') })
        }
        return
      }

      if (req.method === 'POST' && url.pathname === '/codex-api/skills-hub/uninstall') {
        try {
          requireLoopbackForSensitiveMutation(req, 'Skills uninstall')
          const resolved = await resolveServerRuntime(req, url, runtimeRegistry)
          const runtime = requireLocalRuntime(resolved, 'Skills uninstall')
          const payload = asRecord(await readJsonBody(req))
          const name = typeof payload?.name === 'string' ? payload.name : ''
          const requestedPath = typeof payload?.path === 'string' ? payload.path.trim() : ''
          if (requestedPath.length > 0) {
            setJson(res, 400, { error: 'Direct path uninstall is disabled. Use skill name only.' })
            return
          }
          if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(name.trim())) {
            setJson(res, 400, { error: 'Invalid skill name' })
            return
          }
          const skillsRoot = resolve(getSkillsInstallDir())
          const target = requestedPath || (name ? join(skillsRoot, name) : '')
          if (!target) {
            setJson(res, 400, { error: 'Missing skill name' })
            return
          }
          const normalizedTarget = ensurePathInside(skillsRoot, target, 'Refusing to delete outside skills directory')
          await rm(normalizedTarget, { recursive: true, force: true })
          try { await runtime.appServer.rpc('skills/list', { forceReload: true }) } catch {}
          setJson(res, 200, { ok: true, deletedPath: normalizedTarget })
        } catch (error) {
          if (error instanceof BridgeHttpError) {
            setJson(res, error.statusCode, { error: error.message })
            return
          }
          setJson(res, 502, { error: getErrorMessage(error, 'Failed to uninstall skill') })
        }
        return
      }

      if (req.method === 'GET' && url.pathname === '/codex-api/events') {
        const resolved = await resolveServerRuntime(req, url, runtimeRegistry)
        const server = resolved.server
        const requestedChannelId = resolved.channelId
        res.statusCode = 200
        res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
        res.setHeader('Cache-Control', 'no-cache, no-transform')
        res.setHeader('Connection', 'keep-alive')
        res.setHeader('X-Accel-Buffering', 'no')

        const unsubscribe = server.transport === 'relay'
          ? relayHub.subscribeNotifications(
              {
                scopeKey: resolved.scope.cacheKey,
                serverId: server.id,
              },
              (notification) => {
                if (res.writableEnded || res.destroyed) return
                if (requestedChannelId !== RELAY_HUB_CHANNEL && notification.route.channelId !== requestedChannelId) {
                  return
                }
                const payload = {
                  method: notification.event,
                  params: notification.params,
                  serverId: server.id,
                  channelId: notification.route.channelId,
                  atIso: notification.sentAtIso,
                }
                res.write(`data: ${JSON.stringify(payload)}\n\n`)
              },
            )
          : requireLocalRuntime(resolved, 'Event stream').appServer.onNotification((notification) => {
              if (res.writableEnded || res.destroyed) return
              const payload = {
                ...notification,
                serverId: server.id,
                atIso: new Date().toISOString(),
              }
              res.write(`data: ${JSON.stringify(payload)}\n\n`)
            })

        res.write(`event: ready\ndata: ${JSON.stringify({ ok: true, serverId: server.id })}\n\n`)
        const keepAlive = setInterval(() => {
          res.write(': ping\n\n')
        }, 15000)

        const close = () => {
          clearInterval(keepAlive)
          unsubscribe()
          if (!res.writableEnded) {
            res.end()
          }
        }

        req.on('close', close)
        req.on('aborted', close)
        return
      }

      next()
    } catch (error) {
      if (error instanceof BridgeHttpError) {
        setJson(res, error.statusCode, { error: error.message })
        return
      }
      const message = getErrorMessage(error, 'Unknown bridge error')
      setJson(res, 502, { error: message })
    }
  }

  middleware.dispose = () => {
    runtimeRegistry.disposeAll()
  }

  return middleware
}
