import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Command } from 'commander'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'
import { spawnSync } from 'node:child_process'
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
  return (await readFile(path, 'utf8')).trim()
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

function buildAuthorizationHeader(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
  }
}

export function createConnectorInstallCommand(
  input: { hubAddress: string; connectorId: string; token?: string; relayE2eeKeyId?: string; tokenFilePath?: string },
): string {
  const tokenFilePath = input.tokenFilePath?.trim() || `~/.codexui-connector/${input.connectorId}.token`
  const parts = [
    'npx codexui-connector connect',
    `--hub ${JSON.stringify(input.hubAddress)}`,
    `--connector ${JSON.stringify(input.connectorId)}`,
    `--token-file ${JSON.stringify(tokenFilePath)}`,
  ]
  if (input.relayE2eeKeyId) {
    parts.push(`--key-id ${JSON.stringify(input.relayE2eeKeyId)}`)
    parts.push('--passphrase "<relay-passphrase>"')
  }
  return parts.join(' ')
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
      throw new Error(createHttpErrorMessage(payload, `Relay connect failed with HTTP ${String(response.status)}`))
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
      throw new Error(createHttpErrorMessage(payload, `Relay pull failed with HTTP ${String(response.status)}`))
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
      throw new Error(createHttpErrorMessage(payload, `Relay push failed with HTTP ${String(response.status)}`))
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
  }
  token: string
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
  const token = typeof data?.token === 'string' ? data.token.trim() : ''

  const connectorId = typeof connector?.id === 'string' ? connector.id.trim() : ''
  const serverId = typeof connector?.serverId === 'string' ? connector.serverId.trim() : connectorId
  const name = typeof connector?.name === 'string' ? connector.name.trim() : ''
  const relayAgentId = typeof connector?.relayAgentId === 'string' ? connector.relayAgentId.trim() : ''
  const relayE2eeKeyId = typeof connector?.relayE2eeKeyId === 'string' ? connector.relayE2eeKeyId.trim() : undefined

  if (!connectorId || !name || !relayAgentId || !token) {
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
    },
    token,
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
  const appServer: RelayConnectorAppServer = new LocalCodexAppServer(codexCommand)
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
    .description('Connect a remote Codex host to a CodexUI hub using a relay token')
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
        ...(provisioned.connector.relayE2eeKeyId ? { relayE2eeKeyId: provisioned.connector.relayE2eeKeyId } : {}),
      })

      if (options.json) {
        console.log(JSON.stringify({
          connector: provisioned.connector,
          token: provisioned.token,
          installCommand,
        }, null, 2))
      } else {
        console.log('Connector registered successfully.\n')
        console.log(`Connector: ${provisioned.connector.name} (${provisioned.connector.id})`)
        console.log(`Hub:       ${provisioned.connector.hubAddress}`)
        console.log('\nSave the one-time token to a secure file on the connector host, then run:')
        console.log(installCommand)
        console.log('\nUse --json if you need to capture the token programmatically, or --run to connect immediately on this host.')
      }

      if (options.run) {
        const relayE2ee = options.keyId && options.passphrase
          ? {
              keyId: options.keyId,
              passphrase: options.passphrase,
            }
          : undefined
        await runConnectorLoop({
          hubAddress: provisioned.connector.hubAddress,
          token: provisioned.token,
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
  return fileURLToPath(import.meta.url) === entrypoint
}

export { CodexRelayConnector } from './core.js'
export { LocalCodexAppServer } from './localCodexAppServer.js'

if (isMainModule()) {
  runCli(process.argv).catch((error) => {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`\nFailed to run codexui-connector: ${message}`)
    process.exit(1)
  })
}
