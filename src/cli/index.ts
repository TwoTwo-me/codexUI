import { createServer } from 'node:http'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'
import { Command } from 'commander'
import { createServer as createApp } from '../server/httpServer.js'
import { generatePassword } from '../server/password.js'
import { createPasswordHash, isSupportedPasswordHash } from '../server/userStore.js'

const program = new Command().name('codexui').description('Web interface for Codex app-server')
const __dirname = dirname(fileURLToPath(import.meta.url))

async function readCliVersion(): Promise<string> {
  try {
    const packageJsonPath = join(__dirname, '..', 'package.json')
    const raw = await readFile(packageJsonPath, 'utf8')
    const parsed = JSON.parse(raw) as { version?: unknown }
    return typeof parsed.version === 'string' ? parsed.version : 'unknown'
  } catch {
    return 'unknown'
  }
}

function isTermuxRuntime(): boolean {
  return Boolean(process.env.TERMUX_VERSION || process.env.PREFIX?.includes('/com.termux/'))
}

function canRun(command: string, args: string[] = []): boolean {
  const result = spawnSync(command, args, { stdio: 'ignore' })
  return result.status === 0
}

function runOrFail(command: string, args: string[], label: string): void {
  const result = spawnSync(command, args, { stdio: 'inherit' })
  if (result.status !== 0) {
    throw new Error(`${label} failed with exit code ${String(result.status ?? -1)}`)
  }
}

function resolveCodexCommand(): string | null {
  if (canRun('codex', ['--version'])) {
    return 'codex'
  }
  const prefix = process.env.PREFIX?.trim()
  if (!prefix) {
    return null
  }
  const candidate = join(prefix, 'bin', 'codex')
  if (existsSync(candidate) && canRun(candidate, ['--version'])) {
    return candidate
  }
  return null
}

function hasCodexAuth(): boolean {
  const codexHome = process.env.CODEX_HOME?.trim() || join(homedir(), '.codex')
  return existsSync(join(codexHome, 'auth.json'))
}

function shouldSkipCodexLogin(): boolean {
  const raw = process.env.CODEXUI_SKIP_CODEX_LOGIN?.trim().toLowerCase()
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on'
}

function ensureTermuxCodexInstalled(): string | null {
  if (!isTermuxRuntime()) {
    return resolveCodexCommand()
  }

  let codexCommand = resolveCodexCommand()
  if (!codexCommand) {
    console.log('\nCodex CLI not found. Installing Termux-compatible Codex CLI from npm...\n')
    runOrFail('npm', ['install', '-g', '@mmmbuto/codex-cli-termux'], 'Codex CLI install')
    codexCommand = resolveCodexCommand()
    if (!codexCommand) {
      console.log('\nTermux npm package did not expose `codex`. Installing official CLI fallback...\n')
      runOrFail('npm', ['install', '-g', '@openai/codex'], 'Codex CLI fallback install')
      codexCommand = resolveCodexCommand()
    }
    if (!codexCommand) {
      throw new Error('Codex CLI install completed but binary is still not available in PATH')
    }
    console.log('\nCodex CLI installed.\n')
  }
  return codexCommand
}

type BootstrapCredential =
  | { enabled: false }
  | { enabled: true; kind: 'password'; value: string; source: 'cli' | 'env' | 'generated' }
  | { enabled: true; kind: 'hash'; value: string; source: 'cli' | 'env' }

function resolveBootstrapAdminUsername(input?: string): string {
  const provided = input?.trim()
  if (provided && provided.length > 0) {
    return provided
  }
  const envUsername = process.env.CODEXUI_ADMIN_USERNAME?.trim()
  if (envUsername && envUsername.length > 0) {
    return envUsername
  }
  return 'admin'
}

function normalizeEnvSecret(name: string): string | undefined {
  const value = process.env[name]?.trim()
  return value && value.length > 0 ? value : undefined
}

function escapeForComposeEnv(value: string): string {
  return value.replace(/\$/gu, '$$$$')
}

function assertSupportedPasswordHash(passwordHash: string, sourceLabel: string): void {
  if (!isSupportedPasswordHash(passwordHash)) {
    throw new Error(`${sourceLabel} is not a supported password hash.`)
  }
}

function resolveBootstrapCredential(options: {
  password: string | boolean
  passwordHash?: string
}): BootstrapCredential {
  const cliPassword = typeof options.password === 'string' ? options.password : undefined
  const cliPasswordHash = options.passwordHash?.trim() || undefined
  const envPassword = normalizeEnvSecret('CODEXUI_ADMIN_PASSWORD')
  const envPasswordHash = normalizeEnvSecret('CODEXUI_ADMIN_PASSWORD_HASH')

  if (options.password === false) {
    if (cliPasswordHash) {
      throw new Error('Cannot combine --no-password with --password-hash.')
    }
    if (cliPassword) {
      throw new Error('Cannot combine --no-password with --password.')
    }
    return { enabled: false }
  }

  if (cliPassword && cliPasswordHash) {
    throw new Error('Specify only one of --password or --password-hash.')
  }

  if (envPassword && envPasswordHash) {
    throw new Error('CODEXUI_ADMIN_PASSWORD and CODEXUI_ADMIN_PASSWORD_HASH cannot both be set.')
  }

  if (cliPasswordHash) {
    assertSupportedPasswordHash(cliPasswordHash, '--password-hash')
    return {
      enabled: true,
      kind: 'hash',
      value: cliPasswordHash,
      source: 'cli',
    }
  }

  if (cliPassword) {
    return {
      enabled: true,
      kind: 'password',
      value: cliPassword,
      source: 'cli',
    }
  }

  if (envPasswordHash) {
    assertSupportedPasswordHash(envPasswordHash, 'CODEXUI_ADMIN_PASSWORD_HASH')
    return {
      enabled: true,
      kind: 'hash',
      value: envPasswordHash,
      source: 'env',
    }
  }

  if (envPassword) {
    return {
      enabled: true,
      kind: 'password',
      value: envPassword,
      source: 'env',
    }
  }

  return {
    enabled: true,
    kind: 'password',
    value: generatePassword(),
    source: 'generated',
  }
}

function shouldOpenBrowser(): boolean {
  const envValue = process.env.CODEXUI_OPEN_BROWSER?.trim().toLowerCase()
  if (!envValue) {
    return true
  }
  if (['0', 'false', 'no', 'off'].includes(envValue)) {
    return false
  }
  if (['1', 'true', 'yes', 'on'].includes(envValue)) {
    return true
  }
  return true
}

function printTermuxKeepAlive(lines: string[]): void {
  if (!isTermuxRuntime()) {
    return
  }
  lines.push('')
  lines.push('  Android/Termux keep-alive:')
  lines.push('  1) Keep this Termux session open (do not swipe it away).')
  lines.push('  2) Disable battery optimization for Termux in Android settings.')
  lines.push('  3) Optional: run `termux-wake-lock` in another shell.')
}

function openBrowser(url: string): void {
  const command = process.platform === 'darwin'
    ? { cmd: 'open', args: [url] }
    : process.platform === 'win32'
      ? { cmd: 'cmd', args: ['/c', 'start', '', url] }
      : { cmd: 'xdg-open', args: [url] }

  const child = spawn(command.cmd, command.args, { detached: true, stdio: 'ignore' })
  child.on('error', () => {})
  child.unref()
}

function resolveBindHost(explicitHost: string | undefined): string {
  const envHost = process.env.CODEXUI_BIND_HOST?.trim()
  const provided = explicitHost?.trim()
  if (provided && provided.length > 0) return provided
  if (envHost && envHost.length > 0) return envHost
  return '127.0.0.1'
}

function getPrimaryLocalUrl(host: string, port: number): string {
  const displayHost = host === '0.0.0.0' || host === '::' ? 'localhost' : host
  return `http://${displayHost}:${String(port)}`
}

function listenWithFallback(server: ReturnType<typeof createServer>, startPort: number, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const attempt = (port: number) => {
      const onError = (error: NodeJS.ErrnoException) => {
        server.off('listening', onListening)
        if (error.code === 'EADDRINUSE' || error.code === 'EACCES') {
          attempt(port + 1)
          return
        }
        reject(error)
      }
      const onListening = () => {
        server.off('error', onError)
        resolve(port)
      }

      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(port, host)
    }

    attempt(startPort)
  })
}

async function startServer(options: {
  port: string
  host?: string
  password: string | boolean
  passwordHash?: string
  username?: string
}) {
  const version = await readCliVersion()
  const codexCommand = ensureTermuxCodexInstalled() ?? resolveCodexCommand()
  if (!hasCodexAuth() && codexCommand) {
    if (shouldSkipCodexLogin()) {
      console.log('\nCodex auth not found. Skipping `codex login` because CODEXUI_SKIP_CODEX_LOGIN is enabled.\n')
    } else {
      console.log('\nCodex is not logged in. Starting `codex login`...\n')
      runOrFail(codexCommand, ['login'], 'Codex login')
    }
  }
  const requestedPort = parseInt(options.port, 10)
  const host = resolveBindHost(options.host)
  const bootstrapCredential = resolveBootstrapCredential(options)
  const bootstrapAdminUsername = resolveBootstrapAdminUsername(options.username)
  const { app, dispose } = createApp({
    bootstrapAdminUsername,
    ...(bootstrapCredential.enabled && bootstrapCredential.kind === 'password'
      ? { password: bootstrapCredential.value }
      : {}),
    ...(bootstrapCredential.enabled && bootstrapCredential.kind === 'hash'
      ? { passwordHash: bootstrapCredential.value }
      : {}),
  })
  const server = createServer(app)
  const port = await listenWithFallback(server, requestedPort, host)
  const localUrl = getPrimaryLocalUrl(host, port)
  const lines = [
    '',
    'Codex Web Local is running!',
    `  Version:  ${version}`,
    '',
    `  Local:    ${localUrl}`,
  ]

  if (port !== requestedPort) {
    lines.push(`  Requested port ${String(requestedPort)} was unavailable; using ${String(port)}.`)
  }

  if (bootstrapCredential.enabled) {
    lines.push(`  Username: ${bootstrapAdminUsername}`)
    if (bootstrapCredential.kind === 'password') {
      lines.push(`  Password: ${bootstrapCredential.value}`)
    } else {
      lines.push('  Password: configured via precomputed hash (not displayed)')
    }
  }

  if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') {
    lines.push(`  Bound host: ${host}`)
  }

  printTermuxKeepAlive(lines)

  lines.push('')
  console.log(lines.join('\n'))
  if (shouldOpenBrowser()) {
    openBrowser(localUrl)
  }

  function shutdown() {
    console.log('\nShutting down...')
    server.close(() => {
      dispose()
      process.exit(0)
    })
    // Force exit after timeout
    setTimeout(() => {
      dispose()
      process.exit(1)
    }, 5000).unref()
  }

  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

async function runLogin() {
  const codexCommand = ensureTermuxCodexInstalled() ?? 'codex'
  console.log('\nStarting `codex login`...\n')
  runOrFail(codexCommand, ['login'], 'Codex login')
}

async function readPasswordFromStdin(): Promise<string> {
  if (process.stdin.isTTY) {
    throw new Error('Use --password-stdin with piped input or the helper script.')
  }

  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
  }

  const value = Buffer.concat(chunks).toString('utf8').replace(/(?:\r?\n)+$/u, '')
  if (!value) {
    throw new Error('Password cannot be empty.')
  }

  return value
}

async function runHashPassword(options: { password?: string; passwordStdin?: boolean; env?: boolean }) {
  if (options.password && options.passwordStdin) {
    throw new Error('Specify only one of --password or --password-stdin.')
  }

  const password = options.password ?? (options.passwordStdin ? await readPasswordFromStdin() : '')
  if (!password) {
    throw new Error('Provide a password with --password or --password-stdin.')
  }

  const passwordHash = await createPasswordHash(password)
  console.log(options.env ? `CODEXUI_ADMIN_PASSWORD_HASH=${escapeForComposeEnv(passwordHash)}` : passwordHash)
}

program
  .option('-p, --port <port>', 'port to listen on', process.env.CODEXUI_PORT?.trim() || '3000')
  .option('--host <host>', 'host/interface to bind (default: 127.0.0.1 or CODEXUI_BIND_HOST)')
  .option('--username <username>', 'bootstrap admin username (default: admin or CODEXUI_ADMIN_USERNAME)')
  .option('--password <pass>', 'set a specific password')
  .option('--password-hash <hash>', 'set a precomputed bootstrap admin password hash')
  .option('--no-password', 'disable password protection')
  .action(async (opts: { port: string; host?: string; username?: string; password: string | boolean; passwordHash?: string }) => {
    await startServer(opts)
  })

program.command('login').description('Install/check Codex CLI in Termux and run `codex login`').action(runLogin)

program.command('hash-password')
  .description('Generate a bootstrap admin password hash.')
  .option('--password <pass>', 'generate a hash for a plaintext password')
  .option('--password-stdin', 'read the plaintext password from stdin')
  .option('--env', 'print the hash as CODEXUI_ADMIN_PASSWORD_HASH=...')
  .action(runHashPassword)

program.command('help').description('Show codexui command help').action(() => {
  program.outputHelp()
})

program.parseAsync(process.argv).catch((error) => {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`\nFailed to run codexui: ${message}`)
  process.exit(1)
})
