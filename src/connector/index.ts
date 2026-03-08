import { existsSync, realpathSync } from 'node:fs'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { Command } from 'commander'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import {
  createConnectorConnectCommand,
  createConnectorInstallCommand,
  createConnectorPm2RegistrationCommand,
  createConnectorSystemdUserRegistrationCommand,
} from '../shared/connectorInstallCommand.js'
import { CodexUiConnectorAppServer } from './codexUiConnectorAppServer.js'
import { LocalCodexAppServer } from './localCodexAppServer.js'
import {
  CodexRelayConnector,
  type RelayConnectorAppServer,
  type RelayConnectorE2eeConfig,
  type RelayConnectorSession,
  type RelayConnectorTransport,
} from './core.js'
import { normalizeHubAddress } from '../utils/hubAddress.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

async function readConnectorVersion(): Promise<string> {
  try {
    const packageJsonPath = join(__dirname, '..', 'package.json')
    const response = await fetch(`file://${packageJsonPath}`)
    const parsed = (await response.json()) as { version?: unknown }
    return typeof parsed.version === 'string' ? parsed.version : 'unknown'
  } catch {
    return 'unknown'
  }
}

function createHubAddressError(): Error {
  return new Error('A valid hub address is required. HTTPS is required for non-local hubs unless you pass --allow-insecure-http for local lab testing.')
}

async function readSecretFromStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
  }
  return Buffer.concat(chunks).toString('utf8').trim()
}

async function readSecretFile(path: string): Promise<string> {
  return (await readFile(expandUserPath(path), 'utf8')).trim()
}

function expandUserPath(path: string): string {
  const trimmed = path.trim()
  if (!trimmed) return trimmed
  if (trimmed === '~') {
    return homedir()
  }
  if (trimmed.startsWith('~/')) {
    return join(homedir(), trimmed.slice(2))
  }
  return trimmed
}

function canRun(command: string, args: string[] = []): boolean {
  const result = spawnSync(command, args, { stdio: 'ignore' })
  return result.status === 0
}

function resolveCodexCommand(): string {
  if (canRun('codex', ['--version'])) {
    return 'codex'
  }
  const prefix = process.env.PREFIX?.trim()
  if (prefix) {
    const candidate = join(prefix, 'bin', 'codex')
    if (existsSync(candidate) && canRun(candidate, ['--version'])) {
      return candidate
    }
  }
  throw new Error('Codex CLI is required on the connector host')
}

function hasCodexAuth(): boolean {
  const codexHome = process.env.CODEX_HOME?.trim() || join(homedir(), '.codex')
  return existsSync(join(codexHome, 'auth.json'))
}

function createHttpErrorMessage(payload: unknown, fallback: string): string {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return fallback
  }
  const record = payload as Record<string, unknown>
  return typeof record.error === 'string' && record.error.trim().length > 0 ? record.error : fallback
}

async function parseJsonResponse(response: Response): Promise<unknown> {
  try {
    return await response.json()
  } catch {
    return null
  }
}

function parseRetryAfterMs(response: Response, payload: unknown): number | undefined {
  const retryAfterHeader = response.headers.get('Retry-After')
  if (retryAfterHeader) {
    const numeric = Number(retryAfterHeader)
    if (Number.isFinite(numeric) && numeric > 0) {
      return Math.max(1_000, Math.trunc(numeric * 1000))
    }
  }

  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    const retryAfterSeconds = (payload as Record<string, unknown>).retryAfterSeconds
    if (typeof retryAfterSeconds === 'number' && Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) {
      return Math.max(1_000, Math.trunc(retryAfterSeconds * 1000))
    }
  }

  return undefined
}

function createRelayHttpError(response: Response, payload: unknown, fallback: string): Error {
  const error = new Error(createHttpErrorMessage(payload, fallback)) as Error & {
    statusCode?: number
    retryAfterMs?: number
  }
  error.name = 'RelayHttpError'
  error.statusCode = response.status
  const retryAfterMs = parseRetryAfterMs(response, payload)
  if (retryAfterMs !== undefined) {
    error.retryAfterMs = retryAfterMs
  }
  return error
}

function buildAuthorizationHeader(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
  }
}

export class HttpRelayHubTransport implements RelayConnectorTransport {
  private readonly hubAddress: string

  constructor(hubAddress: string, options?: { allowInsecureHttp?: boolean }) {
    this.hubAddress = normalizeHubAddress(hubAddress, {
      allowInsecureHttp: options?.allowInsecureHttp === true,
    })
    if (!this.hubAddress) {
      throw createHubAddressError()
    }
  }

  async connect(token: string): Promise<RelayConnectorSession> {
    const response = await fetch(`${this.hubAddress}/codex-api/relay/agent/connect`, {
      method: 'POST',
      headers: {
        ...buildAuthorizationHeader(token),
        Accept: 'application/json',
      },
    })
    const payload = await parseJsonResponse(response)
    if (!response.ok) {
      throw createRelayHttpError(response, payload, `Relay connect failed with HTTP ${String(response.status)}`)
    }
    const data = payload && typeof payload === 'object' && !Array.isArray(payload)
      ? (payload as Record<string, unknown>).data as Record<string, unknown>
      : null
    const sessionId = typeof data?.sessionId === 'string' ? data.sessionId.trim() : ''
    const pollTimeoutMs = typeof data?.pollTimeoutMs === 'number' ? data.pollTimeoutMs : undefined
    if (!sessionId) {
      throw new Error('Relay connect response did not include a session id')
    }
    return {
      sessionId,
      ...(pollTimeoutMs !== undefined ? { pollTimeoutMs } : {}),
    }
  }

  async pull(token: string, sessionId: string, waitMs?: number) {
    const query = new URLSearchParams({ sessionId })
    if (typeof waitMs === 'number' && Number.isFinite(waitMs)) {
      query.set('waitMs', String(Math.max(0, Math.trunc(waitMs))))
    }
    const response = await fetch(`${this.hubAddress}/codex-api/relay/agent/pull?${query.toString()}`, {
      method: 'GET',
      headers: {
        ...buildAuthorizationHeader(token),
        Accept: 'application/json',
      },
    })
    const payload = await parseJsonResponse(response)
    if (!response.ok) {
      throw createRelayHttpError(response, payload, `Relay pull failed with HTTP ${String(response.status)}`)
    }
    const data = payload && typeof payload === 'object' && !Array.isArray(payload)
      ? (payload as Record<string, unknown>).data as Record<string, unknown>
      : null
    return Array.isArray(data?.messages) ? data.messages as never[] : []
  }

  async push(token: string, sessionId: string, messages: Array<unknown>): Promise<void> {
    const query = new URLSearchParams({ sessionId })
    const response = await fetch(`${this.hubAddress}/codex-api/relay/agent/push?${query.toString()}`, {
      method: 'POST',
      headers: {
        ...buildAuthorizationHeader(token),
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ messages }),
    })
    const payload = await parseJsonResponse(response)
    if (!response.ok) {
      throw createRelayHttpError(response, payload, `Relay push failed with HTTP ${String(response.status)}`)
    }
  }
}

function readSetCookieHeader(response: Response): string {
  const direct = response.headers.get('set-cookie')
  if (direct) return direct
  const maybeHeaders = response.headers as Headers & { getSetCookie?: () => string[] }
  const fromHelper = maybeHeaders.getSetCookie?.()
  if (Array.isArray(fromHelper) && fromHelper.length > 0) {
    return fromHelper.join('; ')
  }
  return ''
}

function normalizeCookieHeader(setCookieHeader: string): string {
  const raw = setCookieHeader.trim()
  if (!raw) return ''
  const firstCookie = raw.split(/,\s*(?=[^;=]+=[^;]+)/u)[0] ?? raw
  return firstCookie.split(';', 1)[0]?.trim() ?? ''
}

export type ProvisionConnectorInput = {
  hubAddress: string
  username: string
  password: string
  connectorId: string
  connectorName: string
  relayE2eeKeyId?: string
  allowInsecureHttp?: boolean
}

export async function provisionConnectorRegistration(input: ProvisionConnectorInput): Promise<{
  connector: {
    id: string
    serverId: string
    name: string
    hubAddress: string
    relayAgentId: string
    relayE2eeKeyId?: string
    installState?: string
    bootstrapExpiresAtIso?: string
  }
  bootstrapToken: string
}> {
  const hubAddress = normalizeHubAddress(input.hubAddress, {
    allowInsecureHttp: input.allowInsecureHttp === true,
  })
  if (!hubAddress) {
    throw createHubAddressError()
  }

  const loginResponse = await fetch(`${hubAddress}/auth/login`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      username: input.username,
      password: input.password,
    }),
  })
  const loginPayload = await parseJsonResponse(loginResponse)
  if (!loginResponse.ok) {
    throw new Error(createHttpErrorMessage(loginPayload, `Hub login failed with HTTP ${String(loginResponse.status)}`))
  }

  const cookieHeader = normalizeCookieHeader(readSetCookieHeader(loginResponse))
  if (!cookieHeader) {
    throw new Error('Hub login did not return a session cookie')
  }

  const createResponse = await fetch(`${hubAddress}/codex-api/connectors`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Cookie: cookieHeader,
    },
    body: JSON.stringify({
      id: input.connectorId,
      name: input.connectorName,
      hubAddress,
      ...(input.relayE2eeKeyId ? { e2ee: { keyId: input.relayE2eeKeyId } } : {}),
    }),
  })
  const createPayload = await parseJsonResponse(createResponse)
  if (!createResponse.ok) {
    throw new Error(createHttpErrorMessage(createPayload, `Connector provisioning failed with HTTP ${String(createResponse.status)}`))
  }

  const envelope = createPayload && typeof createPayload === 'object' && !Array.isArray(createPayload)
    ? (createPayload as Record<string, unknown>)
    : null
  const data = envelope && typeof envelope.data === 'object' && !Array.isArray(envelope.data)
    ? envelope.data as Record<string, unknown>
    : null
  const connector = data && typeof data.connector === 'object' && !Array.isArray(data.connector)
    ? data.connector as Record<string, unknown>
    : null
  const bootstrapToken = typeof data?.bootstrapToken === 'string' ? data.bootstrapToken.trim() : ''
  const installState = typeof connector?.installState === 'string' ? connector.installState.trim() : undefined
  const bootstrapExpiresAtIso = typeof connector?.bootstrapExpiresAtIso === 'string'
    ? connector.bootstrapExpiresAtIso.trim()
    : undefined

  const connectorId = typeof connector?.id === 'string' ? connector.id.trim() : ''
  const serverId = typeof connector?.serverId === 'string' ? connector.serverId.trim() : connectorId
  const name = typeof connector?.name === 'string' ? connector.name.trim() : ''
  const relayAgentId = typeof connector?.relayAgentId === 'string' ? connector.relayAgentId.trim() : ''
  const relayE2eeKeyId = typeof connector?.relayE2eeKeyId === 'string' ? connector.relayE2eeKeyId.trim() : undefined

  if (!connectorId || !name || !relayAgentId || !bootstrapToken) {
    throw new Error('Connector provisioning returned an incomplete response')
  }

  return {
    connector: {
      id: connectorId,
      serverId,
      name,
      hubAddress,
      relayAgentId,
      ...(relayE2eeKeyId ? { relayE2eeKeyId } : {}),
      ...(installState ? { installState } : {}),
      ...(bootstrapExpiresAtIso ? { bootstrapExpiresAtIso } : {}),
    },
    bootstrapToken,
  }
}

export async function writeConnectorTokenFile(path: string, token: string): Promise<void> {
  const normalizedPath = expandUserPath(path)
  if (!normalizedPath) {
    throw new Error('A token file path is required.')
  }
  await mkdir(dirname(normalizedPath), { recursive: true, mode: 0o700 })
  await writeFile(normalizedPath, token.trim(), { encoding: 'utf8', mode: 0o600 })
}

function getConnectorHelperScriptPath(connectorId: string, kind: 'start' | 'systemd' | 'pm2'): string {
  return join(process.cwd(), `codexui-connector-${connectorId}-${kind}.sh`)
}

async function writeExecutableScript(path: string, body: string): Promise<void> {
  await writeFile(path, body, { encoding: 'utf8', mode: 0o700 })
  await chmod(path, 0o700)
}

async function writeConnectorHelperScripts(input: {
  connectorId: string
  connectCommand: string
  systemdRegistrationCommand: string
  pm2RegistrationCommand: string
}): Promise<{
  directory: string
  startScriptPath: string
  systemdScriptPath: string
  pm2ScriptPath: string
}> {
  const startScriptPath = getConnectorHelperScriptPath(input.connectorId, 'start')
  const systemdScriptPath = getConnectorHelperScriptPath(input.connectorId, 'systemd')
  const pm2ScriptPath = getConnectorHelperScriptPath(input.connectorId, 'pm2')

  await writeExecutableScript(startScriptPath, [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    '',
    `exec ${input.connectCommand}`,
    '',
  ].join('\n'))
  await writeExecutableScript(systemdScriptPath, [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    '',
    input.systemdRegistrationCommand,
    '',
  ].join('\n'))
  await writeExecutableScript(pm2ScriptPath, [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    '',
    input.pm2RegistrationCommand,
    '',
  ].join('\n'))

  return {
    directory: process.cwd(),
    startScriptPath,
    systemdScriptPath,
    pm2ScriptPath,
  }
}

export async function exchangeConnectorBootstrap(input: {
  hubAddress: string
  connectorId: string
  bootstrapToken: string
  allowInsecureHttp?: boolean
}): Promise<{
  connector: {
    id: string
    serverId: string
    name: string
    hubAddress: string
    relayAgentId: string
    relayE2eeKeyId?: string
    installState?: string
    credentialIssuedAtIso?: string
  }
  credentialToken: string
}> {
  const hubAddress = normalizeHubAddress(input.hubAddress, {
    allowInsecureHttp: input.allowInsecureHttp === true,
  })
  if (!hubAddress) {
    throw createHubAddressError()
  }

  const response = await fetch(`${hubAddress}/codex-api/connectors/${encodeURIComponent(input.connectorId)}/bootstrap-exchange`, {
    method: 'POST',
    headers: {
      ...buildAuthorizationHeader(input.bootstrapToken),
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      connectorVersion: await readConnectorVersion(),
      platform: process.platform,
      hostname: process.env.HOSTNAME ?? '',
    }),
  })
  const payload = await parseJsonResponse(response)
  if (!response.ok) {
    const fallback = `Bootstrap exchange failed with HTTP ${String(response.status)}`
    const baseMessage = createHttpErrorMessage(payload, fallback)
    const guidance = response.status === 409 || response.status === 410
      ? ' Reissue a new install token from Settings and retry.'
      : ''
    throw new Error(`${baseMessage}${guidance}`)
  }

  const envelope = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? payload as Record<string, unknown>
    : null
  const data = envelope && typeof envelope.data === 'object' && !Array.isArray(envelope.data)
    ? envelope.data as Record<string, unknown>
    : null
  const connector = data && typeof data.connector === 'object' && !Array.isArray(data.connector)
    ? data.connector as Record<string, unknown>
    : null
  const credentialToken = typeof data?.credentialToken === 'string' ? data.credentialToken.trim() : ''

  const connectorId = typeof connector?.id === 'string' ? connector.id.trim() : ''
  const serverId = typeof connector?.serverId === 'string' ? connector.serverId.trim() : connectorId
  const name = typeof connector?.name === 'string' ? connector.name.trim() : ''
  const relayAgentId = typeof connector?.relayAgentId === 'string' ? connector.relayAgentId.trim() : ''
  const relayE2eeKeyId = typeof connector?.relayE2eeKeyId === 'string' ? connector.relayE2eeKeyId.trim() : undefined
  const installState = typeof connector?.installState === 'string' ? connector.installState.trim() : undefined
  const credentialIssuedAtIso = typeof connector?.credentialIssuedAtIso === 'string'
    ? connector.credentialIssuedAtIso.trim()
    : undefined

  if (!connectorId || !name || !relayAgentId || !credentialToken) {
    throw new Error('Bootstrap exchange returned an incomplete response')
  }

  return {
    connector: {
      id: connectorId,
      serverId,
      name,
      hubAddress,
      relayAgentId,
      ...(relayE2eeKeyId ? { relayE2eeKeyId } : {}),
      ...(installState ? { installState } : {}),
      ...(credentialIssuedAtIso ? { credentialIssuedAtIso } : {}),
    },
    credentialToken,
  }
}

export async function installConnectorFromBootstrap(input: {
  hubAddress: string
  connectorId: string
  bootstrapToken?: string
  tokenFile?: string
  tokenStdin?: boolean
  allowInsecureHttp?: boolean
}): Promise<{
  connector: {
    id: string
    serverId: string
    name: string
    hubAddress: string
    relayAgentId: string
    relayE2eeKeyId?: string
    installState?: string
    credentialIssuedAtIso?: string
  }
  credentialToken: string
  tokenFilePath?: string
}> {
  const bootstrapToken = await resolveInstallToken({
    token: input.bootstrapToken,
    tokenFile: input.tokenFile,
    tokenStdin: input.tokenStdin,
  })
  const exchanged = await exchangeConnectorBootstrap({
    hubAddress: input.hubAddress,
    connectorId: input.connectorId,
    bootstrapToken,
    allowInsecureHttp: input.allowInsecureHttp === true,
  })

  if (input.tokenFile?.trim()) {
    await writeConnectorTokenFile(input.tokenFile.trim(), exchanged.credentialToken)
  }

  return {
    ...exchanged,
    ...(input.tokenFile?.trim() ? { tokenFilePath: expandUserPath(input.tokenFile.trim()) } : {}),
  }
}

function createLogger(verbose: boolean): (level: string, message: string) => void {
  return (level, message) => {
    if (!verbose && level === 'debug') return
    const prefix = `[codexui-connector:${level}]`
    if (level === 'error') {
      console.error(`${prefix} ${message}`)
      return
    }
    console.log(`${prefix} ${message}`)
  }
}

async function runConnectorLoop(input: {
  hubAddress: string
  token: string
  connectorId: string
  relayE2ee?: RelayConnectorE2eeConfig
  verbose: boolean
  allowInsecureHttp?: boolean
}): Promise<void> {
  if (!hasCodexAuth()) {
    throw new Error('Codex auth.json is missing on the connector host. Run `codex login` first.')
  }

  const codexCommand = resolveCodexCommand()
  const logger = createLogger(input.verbose)
  const appServer: RelayConnectorAppServer = new CodexUiConnectorAppServer(new LocalCodexAppServer(codexCommand))
  const normalizedHubAddress = normalizeHubAddress(input.hubAddress, {
    allowInsecureHttp: input.allowInsecureHttp === true,
  })
  const transport = new HttpRelayHubTransport(input.hubAddress, {
    allowInsecureHttp: input.allowInsecureHttp === true,
  })
  const connector = new CodexRelayConnector({
    token: input.token,
    transport,
    appServer,
    connectorId: input.connectorId,
    ...(input.relayE2ee ? { relayE2ee: input.relayE2ee } : {}),
    onLog: (level, message) => logger(level, message),
  })

  const shutdown = () => {
    connector.dispose()
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  logger('info', `Starting connector ${input.connectorId} against ${normalizedHubAddress}`)
  await connector.run()
}

async function resolveConnectToken(options: {
  token?: string
  tokenFile?: string
  tokenStdin?: boolean
}): Promise<string> {
  const sources = [
    typeof options.token === 'string' && options.token.trim().length > 0 ? 'token' : '',
    typeof options.tokenFile === 'string' && options.tokenFile.trim().length > 0 ? 'tokenFile' : '',
    options.tokenStdin === true ? 'tokenStdin' : '',
  ].filter((entry) => entry.length > 0)

  if (sources.length !== 1) {
    throw new Error('Provide exactly one relay token source: --token, --token-file, or --token-stdin.')
  }

  if (sources[0] === 'token') {
    return options.token!.trim()
  }
  if (sources[0] === 'tokenFile') {
    const token = await readSecretFile(options.tokenFile!.trim())
    if (!token) {
      throw new Error('The relay token file is empty.')
    }
    return token
  }

  const token = await readSecretFromStdin()
  if (!token) {
    throw new Error('No relay token was provided on stdin.')
  }
  return token
}

async function resolveInstallToken(options: {
  token?: string
  tokenFile?: string
  tokenStdin?: boolean
}): Promise<string> {
  const inlineToken = options.token?.trim()
  const hasInlineToken = typeof inlineToken === 'string' && inlineToken.length > 0
  const hasTokenStdin = options.tokenStdin === true
  const tokenFilePath = options.tokenFile?.trim()
  const hasTokenFile = typeof tokenFilePath === 'string' && tokenFilePath.length > 0

  const inlineSourceCount = (hasInlineToken ? 1 : 0) + (hasTokenStdin ? 1 : 0)
  if (inlineSourceCount > 1) {
    throw new Error('Provide exactly one bootstrap token input source: --token, --token-file, or --token-stdin.')
  }

  if (hasInlineToken) {
    return inlineToken
  }

  if (hasTokenStdin) {
    const token = await readSecretFromStdin()
    if (!token) {
      throw new Error('No bootstrap token was provided on stdin.')
    }
    return token
  }

  if (hasTokenFile) {
    const token = await readSecretFile(tokenFilePath)
    if (!token) {
      throw new Error('The relay token file is empty.')
    }
    return token
  }

  throw new Error('No bootstrap token was provided.')
}

function validateInstallTokenSource(options: {
  token?: string
  tokenFile?: string
  tokenStdin?: boolean
}): void {
  const hasInlineToken = typeof options.token === 'string' && options.token.trim().length > 0
  const hasTokenStdin = options.tokenStdin === true
  const hasTokenFile = typeof options.tokenFile === 'string' && options.tokenFile.trim().length > 0

  const sourceCount = (hasInlineToken ? 1 : 0) + (hasTokenStdin ? 1 : 0) + ((hasTokenFile && !hasInlineToken && !hasTokenStdin) ? 1 : 0)
  if (sourceCount !== 1) {
    throw new Error('Provide exactly one bootstrap token input source: --token, --token-file, or --token-stdin.')
  }
}

function validateInstallPersistence(options: {
  token?: string
  tokenFile?: string
  tokenStdin?: boolean
  run?: boolean
}): void {
  const hasPersistentFile = typeof options.tokenFile === 'string' && options.tokenFile.trim().length > 0
  if (hasPersistentFile || options.run === true) {
    return
  }

  const ephemeralSecret = (typeof options.token === 'string' && options.token.trim().length > 0)
    || options.tokenStdin === true
  if (ephemeralSecret) {
    throw new Error('Use --token-file (recommended) or pass --run so the durable credential is not lost after bootstrap exchange.')
  }
}

async function resolveProvisionPassword(options: {
  password?: string
  passwordStdin?: boolean
}): Promise<string> {
  const sources = [
    typeof options.password === 'string' && options.password.trim().length > 0 ? 'password' : '',
    options.passwordStdin === true ? 'passwordStdin' : '',
  ].filter((entry) => entry.length > 0)

  if (sources.length !== 1) {
    throw new Error('Provide exactly one hub password source: --password or --password-stdin.')
  }
  if (sources[0] === 'password') {
    return options.password!.trim()
  }

  const password = await readSecretFromStdin()
  if (!password) {
    throw new Error('No hub password was provided on stdin.')
  }
  return password
}

async function runCli(argv: string[]): Promise<void> {
  const version = await readConnectorVersion()
  const program = new Command()
    .name('codexui-connector')
    .description('Outbound connector daemon for CodexUI hubs')
    .version(version)

  program.command('connect')
    .description('Connect a remote Codex host to a CodexUI hub using a durable relay credential')
    .requiredOption('--hub <url>', 'CodexUI hub base URL')
    .requiredOption('--connector <id>', 'Connector identifier (for logging)')
    .option('--token <token>', 'Connector relay token (least secure)')
    .option('--token-file <path>', 'Read the connector relay token from a local file')
    .option('--token-stdin', 'Read the connector relay token from stdin')
    .option('--key-id <keyId>', 'Relay E2EE key id')
    .option('--passphrase <passphrase>', 'Relay E2EE passphrase')
    .option('--allow-insecure-http', 'Allow plaintext HTTP for non-loopback hubs (lab use only)', false)
    .option('--verbose', 'Enable verbose logging', false)
    .action(async (options: {
      hub: string
      connector: string
      token?: string
      tokenFile?: string
      tokenStdin?: boolean
      keyId?: string
      passphrase?: string
      allowInsecureHttp?: boolean
      verbose?: boolean
    }) => {
      const token = await resolveConnectToken(options)
      const relayE2ee = options.keyId && options.passphrase
        ? {
            keyId: options.keyId,
            passphrase: options.passphrase,
          }
        : undefined
      await runConnectorLoop({
        hubAddress: options.hub,
        token,
        connectorId: options.connector,
        ...(relayE2ee ? { relayE2ee } : {}),
        allowInsecureHttp: options.allowInsecureHttp === true,
        verbose: options.verbose === true,
      })
    })

  program.command('install')
    .description('Exchange a one-time bootstrap token for a durable connector credential')
    .requiredOption('--hub <url>', 'CodexUI hub base URL')
    .requiredOption('--connector <id>', 'Connector identifier')
    .option('--token <token>', 'Bootstrap token (least secure)')
    .option('--token-file <path>', 'Read the bootstrap token from this file, or rewrite the durable credential to this file when used with --token/--token-stdin')
    .option('--token-stdin', 'Read the bootstrap token from stdin')
    .option('--key-id <keyId>', 'Relay E2EE key id')
    .option('--passphrase <passphrase>', 'Relay E2EE passphrase')
    .option('--run', 'Immediately start the connector after installing the durable credential', false)
    .option('--allow-insecure-http', 'Allow plaintext HTTP for non-loopback hubs (lab use only)', false)
    .option('--verbose', 'Enable verbose logging', false)
    .action(async (options: {
      hub: string
      connector: string
      token?: string
      tokenFile?: string
      tokenStdin?: boolean
      keyId?: string
      passphrase?: string
      run?: boolean
      allowInsecureHttp?: boolean
      verbose?: boolean
    }) => {
      validateInstallTokenSource(options)
      validateInstallPersistence(options)
      const installed = await installConnectorFromBootstrap({
        hubAddress: options.hub,
        connectorId: options.connector,
        bootstrapToken: options.token,
        tokenFile: options.tokenFile,
        tokenStdin: options.tokenStdin === true,
        allowInsecureHttp: options.allowInsecureHttp === true,
      })

      console.log('Connector bootstrap exchange complete.\n')
      console.log(`Connector: ${installed.connector.name} (${installed.connector.id})`)
      if (installed.tokenFilePath) {
        console.log(`Credential file updated: ${installed.tokenFilePath}`)
        const connectCommand = createConnectorConnectCommand({
          hubAddress: options.hub,
          connectorId: options.connector,
          tokenFilePath: options.tokenFile?.trim() || `$HOME/.codexui-connector/${options.connector}.token`,
          ...(installed.connector.relayE2eeKeyId ? { relayE2eeKeyId: installed.connector.relayE2eeKeyId } : {}),
          allowInsecureHttp: options.allowInsecureHttp === true,
        })
        const systemdRegistrationCommand = createConnectorSystemdUserRegistrationCommand({
          hubAddress: options.hub,
          connectorId: options.connector,
          tokenFilePath: options.tokenFile?.trim() || `$HOME/.codexui-connector/${options.connector}.token`,
          ...(installed.connector.relayE2eeKeyId ? { relayE2eeKeyId: installed.connector.relayE2eeKeyId } : {}),
          allowInsecureHttp: options.allowInsecureHttp === true,
        })
        const pm2RegistrationCommand = createConnectorPm2RegistrationCommand({
          hubAddress: options.hub,
          connectorId: options.connector,
          tokenFilePath: options.tokenFile?.trim() || `$HOME/.codexui-connector/${options.connector}.token`,
          ...(installed.connector.relayE2eeKeyId ? { relayE2eeKeyId: installed.connector.relayE2eeKeyId } : {}),
          allowInsecureHttp: options.allowInsecureHttp === true,
        })
        const helperScripts = await writeConnectorHelperScripts({
          connectorId: options.connector,
          connectCommand,
          systemdRegistrationCommand,
          pm2RegistrationCommand,
        })
        console.log('\nStart or restart the connector with:')
        console.log(connectCommand)
        console.log('\nCreated helper scripts in:')
        console.log(helperScripts.directory)
        console.log(`- start: ${helperScripts.startScriptPath}`)
        console.log(`- systemd: ${helperScripts.systemdScriptPath}`)
        console.log(`- pm2: ${helperScripts.pm2ScriptPath}`)
      } else {
        console.log('\nNo token file was written because the connector is running immediately in this process.')
      }

      if (options.run) {
        const relayE2ee = options.keyId && options.passphrase
          ? {
              keyId: options.keyId,
              passphrase: options.passphrase,
            }
          : undefined
        await runConnectorLoop({
          hubAddress: options.hub,
          token: installed.credentialToken,
          connectorId: options.connector,
          ...(relayE2ee ? { relayE2ee } : {}),
          allowInsecureHttp: options.allowInsecureHttp === true,
          verbose: options.verbose === true,
        })
      }
    })

  program.command('provision')
    .description('Log in to a hub, register a connector, and print the one-time install token')
    .requiredOption('--hub <url>', 'CodexUI hub base URL')
    .requiredOption('--username <username>', 'Hub username')
    .requiredOption('--connector <id>', 'Connector identifier to register')
    .option('--password <password>', 'Hub password (least secure)')
    .option('--password-stdin', 'Read the hub password from stdin')
    .option('--name <name>', 'Human-readable connector name')
    .option('--key-id <keyId>', 'Relay E2EE key id')
    .option('--json', 'Print JSON output only', false)
    .option('--run', 'Immediately start the connector after provisioning', false)
    .option('--passphrase <passphrase>', 'Relay E2EE passphrase used when --run is enabled')
    .option('--allow-insecure-http', 'Allow plaintext HTTP for non-loopback hubs (lab use only)', false)
    .action(async (options: {
      hub: string
      username: string
      password?: string
      passwordStdin?: boolean
      connector: string
      name?: string
      keyId?: string
      json?: boolean
      run?: boolean
      passphrase?: string
      allowInsecureHttp?: boolean
    }) => {
      const password = await resolveProvisionPassword(options)
      const provisioned = await provisionConnectorRegistration({
        hubAddress: options.hub,
        username: options.username,
        password,
        connectorId: options.connector,
        connectorName: options.name?.trim() || options.connector,
        ...(options.keyId ? { relayE2eeKeyId: options.keyId } : {}),
        allowInsecureHttp: options.allowInsecureHttp === true,
      })

      const installCommand = createConnectorInstallCommand({
        hubAddress: provisioned.connector.hubAddress,
        connectorId: provisioned.connector.id,
        bootstrapToken: provisioned.bootstrapToken,
        allowInsecureHttp: options.allowInsecureHttp === true,
        ...(provisioned.connector.relayE2eeKeyId ? { relayE2eeKeyId: provisioned.connector.relayE2eeKeyId } : {}),
      })

      if (options.json) {
        console.log(JSON.stringify({
          connector: provisioned.connector,
          bootstrapToken: provisioned.bootstrapToken,
          installCommand,
        }, null, 2))
      } else {
        console.log('Connector registered successfully.\n')
        console.log(`Connector: ${provisioned.connector.name} (${provisioned.connector.id})`)
        console.log(`Hub:       ${provisioned.connector.hubAddress}`)
        console.log('\nRun the one-time install command below on the connector host:')
        console.log(installCommand)
        console.log('\nThis command embeds the bootstrap token inline and writes the durable credential to --token-file.')
        console.log('Use --json if you need to capture the token separately, or --run to connect immediately on this host.')
      }

      if (options.run) {
        const installed = await installConnectorFromBootstrap({
          hubAddress: provisioned.connector.hubAddress,
          connectorId: provisioned.connector.id,
          bootstrapToken: provisioned.bootstrapToken,
          allowInsecureHttp: options.allowInsecureHttp === true,
        })
        const relayE2ee = options.keyId && options.passphrase
          ? {
              keyId: options.keyId,
              passphrase: options.passphrase,
            }
          : undefined
        await runConnectorLoop({
          hubAddress: provisioned.connector.hubAddress,
          token: installed.credentialToken,
          connectorId: provisioned.connector.id,
          ...(relayE2ee ? { relayE2ee } : {}),
          allowInsecureHttp: options.allowInsecureHttp === true,
          verbose: false,
        })
      }
    })

  await program.parseAsync(argv)
}

function isMainModule(): boolean {
  const entrypoint = process.argv[1]
  if (!entrypoint) return false
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(entrypoint)
  } catch {
    return fileURLToPath(import.meta.url) === entrypoint
  }
}

export { CodexRelayConnector } from './core.js'
export { LocalCodexAppServer } from './localCodexAppServer.js'
export {
  createConnectorConnectCommand,
  createConnectorInstallCommand,
  CONNECTOR_NPM_PACKAGE_SPEC,
} from '../shared/connectorInstallCommand.js'

if (isMainModule()) {
  runCli(process.argv).catch((error) => {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`\nFailed to run codexui-connector: ${message}`)
    process.exit(1)
  })
}
