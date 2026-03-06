import { randomBytes } from 'node:crypto'
import type { RequestHandler, Request, Response, NextFunction } from 'express'
import {
  UserStoreError,
  authenticateUser,
  countUsers,
  createUser,
  findUserById,
  listUsers,
  upsertBootstrapAdmin,
  type UserRole,
  type UserProfile,
} from './userStore.js'
import { setRequestAuthenticatedUser } from './requestAuthContext.js'

const TOKEN_COOKIE = 'codex_web_local_token'
const MAX_JSON_BODY_BYTES = 64 * 1024
const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60
const DEFAULT_BOOTSTRAP_ADMIN_USERNAME = 'admin'
const RATE_LIMIT_MAX_ENTRIES = 4096
const LOGIN_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000
const LOGIN_RATE_LIMIT_BLOCK_MS = 15 * 60 * 1000
const LOGIN_RATE_LIMIT_MAX_PER_IP = 30
const LOGIN_RATE_LIMIT_MAX_PER_USERNAME = 10
const SIGNUP_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000
const SIGNUP_RATE_LIMIT_BLOCK_MS = 15 * 60 * 1000
const SIGNUP_RATE_LIMIT_MAX_PER_IP = 20

type AuthMiddlewareOptions = {
  bootstrapAdminPassword: string
  bootstrapAdminUsername?: string
}

type SessionRecord = {
  userId: string
  expiresAtMs: number
}

type RateLimitRecord = {
  attempts: number
  windowStartedAtMs: number
  blockedUntilMs: number
}

function isLocalhostRequest(req: Request): boolean {
  const remote = req.socket.remoteAddress ?? ''
  if (remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1') {
    return true
  }
  return false
}

function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {}
  if (!header) return cookies
  for (const pair of header.split(';')) {
    const idx = pair.indexOf('=')
    if (idx === -1) continue
    const key = pair.slice(0, idx).trim()
    const value = pair.slice(idx + 1).trim()
    cookies[key] = value
  }
  return cookies
}

function getRemoteAddress(req: Request): string {
  const remote = req.socket.remoteAddress
  if (typeof remote === 'string' && remote.trim().length > 0) {
    return remote.trim()
  }
  return 'unknown'
}

function normalizeRateLimitKey(value: string): string {
  const trimmed = value.trim().toLowerCase()
  return trimmed.length > 0 ? trimmed : 'unknown'
}

function compactRateLimitMap(records: Map<string, RateLimitRecord>, nowMs: number, staleAfterMs: number): void {
  if (records.size < RATE_LIMIT_MAX_ENTRIES) {
    return
  }

  for (const [key, record] of records.entries()) {
    const lastRelevantMs = Math.max(record.windowStartedAtMs, record.blockedUntilMs)
    if (nowMs - lastRelevantMs > staleAfterMs) {
      records.delete(key)
    }
  }
}

function evaluateRateLimit(
  records: Map<string, RateLimitRecord>,
  key: string,
  options: { maxAttempts: number; windowMs: number; blockMs: number },
  nowMs = Date.now(),
): { limited: boolean; retryAfterSeconds: number } {
  compactRateLimitMap(records, nowMs, options.windowMs + options.blockMs)

  const existing = records.get(key)
  if (!existing) {
    return { limited: false, retryAfterSeconds: 0 }
  }

  if (existing.blockedUntilMs > nowMs) {
    return {
      limited: true,
      retryAfterSeconds: Math.max(1, Math.ceil((existing.blockedUntilMs - nowMs) / 1000)),
    }
  }

  if (nowMs - existing.windowStartedAtMs > options.windowMs) {
    records.set(key, {
      attempts: 0,
      windowStartedAtMs: nowMs,
      blockedUntilMs: 0,
    })
    return { limited: false, retryAfterSeconds: 0 }
  }

  if (existing.attempts >= options.maxAttempts) {
    const blockedUntilMs = nowMs + options.blockMs
    records.set(key, {
      ...existing,
      blockedUntilMs,
    })
    return {
      limited: true,
      retryAfterSeconds: Math.max(1, Math.ceil((blockedUntilMs - nowMs) / 1000)),
    }
  }

  return { limited: false, retryAfterSeconds: 0 }
}

function incrementRateLimitAttempt(
  records: Map<string, RateLimitRecord>,
  key: string,
  options: { windowMs: number },
  nowMs = Date.now(),
): void {
  compactRateLimitMap(records, nowMs, options.windowMs)
  const existing = records.get(key)
  if (!existing || nowMs - existing.windowStartedAtMs > options.windowMs) {
    records.set(key, {
      attempts: 1,
      windowStartedAtMs: nowMs,
      blockedUntilMs: 0,
    })
    return
  }

  records.set(key, {
    ...existing,
    attempts: existing.attempts + 1,
  })
}

function clearRateLimit(records: Map<string, RateLimitRecord>, key: string): void {
  records.delete(key)
}

function writeRateLimitedResponse(res: Response, retryAfterSeconds: number, message: string): void {
  res.setHeader('Retry-After', String(retryAfterSeconds))
  res.status(429).json({ error: message, retryAfterSeconds })
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function normalizePath(path: string): string {
  if (path.length > 1 && path.endsWith('/')) {
    return path.slice(0, -1)
  }
  return path
}

function getSecureCookieFlag(req: Request): boolean {
  const localRequest = isLocalhostRequest(req)
  return req.secure || (!localRequest && req.headers['x-forwarded-proto'] === 'https')
}

function buildSessionCookie(req: Request, token: string): string {
  const securePart = getSecureCookieFlag(req) ? '; Secure' : ''
  return `${TOKEN_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${String(SESSION_MAX_AGE_SECONDS)}${securePart}`
}

function buildClearSessionCookie(req: Request): string {
  const securePart = getSecureCookieFlag(req) ? '; Secure' : ''
  return `${TOKEN_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${securePart}`
}

function shouldReturnJsonForUnauthorized(req: Request): boolean {
  if (req.path.startsWith('/codex-api/') || req.path.startsWith('/auth/')) {
    return true
  }

  const accept = req.headers.accept
  if (typeof accept === 'string') {
    const lower = accept.toLowerCase()
    if (lower.includes('application/json') && !lower.includes('text/html')) {
      return true
    }
  }

  return false
}

function isPublicRelayAgentPath(path: string, method: string): boolean {
  if (method === 'POST' && /^\/codex-api\/connectors\/[^/]+\/bootstrap-exchange$/u.test(path)) {
    return true
  }
  if (method === 'POST' && path === '/codex-api/relay/agent/connect') {
    return true
  }
  if (method === 'GET' && path === '/codex-api/relay/agent/pull') {
    return true
  }
  if (method === 'POST' && path === '/codex-api/relay/agent/push') {
    return true
  }
  return false
}

async function readJsonBody(req: Request): Promise<Record<string, unknown> | null> {
  const chunks: Uint8Array[] = []
  let totalBytes = 0

  for await (const chunk of req) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
    totalBytes += buffer.byteLength
    if (totalBytes > MAX_JSON_BODY_BYTES) {
      throw new UserStoreError('request_too_large', 'Request body too large.', 413)
    }
    chunks.push(buffer)
  }

  if (chunks.length === 0) return null
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (!text) return null

  try {
    return asRecord(JSON.parse(text) as unknown)
  } catch {
    throw new UserStoreError('invalid_json', 'Invalid JSON body.', 400)
  }
}

function toUsername(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function toPassword(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function toRole(value: unknown): UserRole {
  return value === 'admin' ? 'admin' : 'user'
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;')
    .replace(/'/gu, '&#39;')
}

function renderLoginPage(bootstrapAdminUsername: string): string {
  const escapedUsername = escapeHtml(bootstrapAdminUsername)
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Codex Web Local &mdash; Login</title>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#0a0a0a;color:#e5e5e5;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:1rem}
.card{background:#171717;border:1px solid #262626;border-radius:12px;padding:2rem;width:100%;max-width:400px}
h1{font-size:1.25rem;font-weight:600;margin-bottom:1.5rem;text-align:center;color:#fafafa}
label{display:block;font-size:.875rem;color:#a3a3a3;margin-bottom:.5rem}
.field{margin-bottom:1rem}
input{width:100%;padding:.625rem .75rem;background:#0a0a0a;border:1px solid #404040;border-radius:8px;color:#fafafa;font-size:1rem;outline:none;transition:border-color .15s}
input:focus{border-color:#3b82f6}
button{width:100%;padding:.625rem;margin-top:.25rem;background:#3b82f6;color:#fff;border:none;border-radius:8px;font-size:.9375rem;font-weight:500;cursor:pointer;transition:background .15s}
button:hover{background:#2563eb}
.error{color:#ef4444;font-size:.8125rem;margin-top:.75rem;text-align:center;display:none}
.hint{color:#737373;font-size:.75rem;margin-top:.5rem;text-align:center}
</style>
</head>
<body>
<div class="card">
<h1>Codex Web Local</h1>
<form id="f">
<div class="field">
<label for="username">Username</label>
<input id="username" name="username" autocomplete="username" placeholder="${escapedUsername}">
</div>
<div class="field">
<label for="pw">Password</label>
<input id="pw" name="password" type="password" autocomplete="current-password" autofocus required>
</div>
<button type="submit">Sign in</button>
<p class="hint">Leave username blank to use ${escapedUsername} login compatibility mode.</p>
<p class="error" id="err">Invalid credentials</p>
</form>
</div>
<script>
const form=document.getElementById('f');
const errEl=document.getElementById('err');
const usernameEl=document.getElementById('username');
const pwEl=document.getElementById('pw');
form.addEventListener('submit',async e=>{
  e.preventDefault();
  errEl.style.display='none';
  const payload={password:pwEl.value};
  if(usernameEl.value.trim()){payload.username=usernameEl.value.trim();}
  const res=await fetch('/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
  if(res.ok){window.location.reload()}else{errEl.style.display='block';pwEl.value='';pwEl.focus()}
});
</script>
</body>
</html>`
}

export function createAuthMiddleware(passwordOrOptions: string | AuthMiddlewareOptions): RequestHandler {
  const options: AuthMiddlewareOptions = typeof passwordOrOptions === 'string'
    ? { bootstrapAdminPassword: passwordOrOptions }
    : passwordOrOptions

  const bootstrapAdminUsername =
    (options.bootstrapAdminUsername && options.bootstrapAdminUsername.trim().length > 0
      ? options.bootstrapAdminUsername.trim()
      : DEFAULT_BOOTSTRAP_ADMIN_USERNAME)

  const sessionStore = new Map<string, SessionRecord>()
  const loginRateLimitByIp = new Map<string, RateLimitRecord>()
  const loginRateLimitByUsername = new Map<string, RateLimitRecord>()
  const signupRateLimitByIp = new Map<string, RateLimitRecord>()
  const bootstrapPromise = upsertBootstrapAdmin(bootstrapAdminUsername, options.bootstrapAdminPassword)

  async function resolveSessionUser(req: Request): Promise<UserProfile | null> {
    const cookies = parseCookies(req.headers.cookie)
    const token = cookies[TOKEN_COOKIE]
    if (!token) return null

    const session = sessionStore.get(token)
    if (!session) return null

    if (Date.now() > session.expiresAtMs) {
      sessionStore.delete(token)
      return null
    }

    const user = await findUserById(session.userId)
    if (!user) {
      sessionStore.delete(token)
      return null
    }

    return user
  }

  function createSession(userId: string): string {
    const token = randomBytes(32).toString('hex')
    const nowMs = Date.now()
    sessionStore.set(token, {
      userId,
      expiresAtMs: nowMs + SESSION_MAX_AGE_SECONDS * 1000,
    })
    return token
  }

  function clearSession(req: Request): void {
    const token = parseCookies(req.headers.cookie)[TOKEN_COOKIE]
    if (!token) return
    sessionStore.delete(token)
  }

  async function handleSignup(
    req: Request,
    res: Response,
    currentUser: UserProfile | null,
  ): Promise<void> {
    const remoteAddressKey = normalizeRateLimitKey(getRemoteAddress(req))
    const signupLimitDecision = evaluateRateLimit(
      signupRateLimitByIp,
      remoteAddressKey,
      {
        maxAttempts: SIGNUP_RATE_LIMIT_MAX_PER_IP,
        windowMs: SIGNUP_RATE_LIMIT_WINDOW_MS,
        blockMs: SIGNUP_RATE_LIMIT_BLOCK_MS,
      },
    )
    if (signupLimitDecision.limited) {
      writeRateLimitedResponse(res, signupLimitDecision.retryAfterSeconds, 'Too many signup attempts. Try again later.')
      return
    }
    incrementRateLimitAttempt(
      signupRateLimitByIp,
      remoteAddressKey,
      { windowMs: SIGNUP_RATE_LIMIT_WINDOW_MS },
    )

    const body = await readJsonBody(req)
    if (!body) {
      res.status(400).json({ error: 'Invalid body: expected object' })
      return
    }

    const username = toUsername(body.username)
    const password = toPassword(body.password)
    const requestedRole = toRole(body.role)
    const userCount = await countUsers()
    const allowBootstrapSignup = userCount === 0

    if (!allowBootstrapSignup) {
      if (!currentUser) {
        res.status(401).json({ error: 'Authentication required' })
        return
      }
      if (currentUser.role !== 'admin') {
        res.status(403).json({ error: 'Only admins can create users' })
        return
      }
    }

    const role: UserRole = allowBootstrapSignup ? 'admin' : requestedRole

    const created = await createUser({
      username,
      password,
      role,
    })

    if (!currentUser) {
      const token = createSession(created.id)
      res.setHeader('Set-Cookie', buildSessionCookie(req, token))
      setRequestAuthenticatedUser(req, created)
    }

    res.status(201).json({ ok: true, user: created })
  }

  async function handleLogin(req: Request, res: Response): Promise<void> {
    const body = await readJsonBody(req)
    if (!body) {
      res.status(400).json({ error: 'Invalid body: expected object' })
      return
    }

    const username = toUsername(body.username)
    const password = toPassword(body.password)
    if (!password) {
      res.status(400).json({ error: 'Password is required' })
      return
    }

    const remoteAddressKey = normalizeRateLimitKey(getRemoteAddress(req))
    const usernameKey = normalizeRateLimitKey(username || bootstrapAdminUsername)
    const ipLimitDecision = evaluateRateLimit(
      loginRateLimitByIp,
      remoteAddressKey,
      {
        maxAttempts: LOGIN_RATE_LIMIT_MAX_PER_IP,
        windowMs: LOGIN_RATE_LIMIT_WINDOW_MS,
        blockMs: LOGIN_RATE_LIMIT_BLOCK_MS,
      },
    )
    if (ipLimitDecision.limited) {
      writeRateLimitedResponse(res, ipLimitDecision.retryAfterSeconds, 'Too many login attempts from this IP. Try again later.')
      return
    }

    const usernameLimitDecision = evaluateRateLimit(
      loginRateLimitByUsername,
      usernameKey,
      {
        maxAttempts: LOGIN_RATE_LIMIT_MAX_PER_USERNAME,
        windowMs: LOGIN_RATE_LIMIT_WINDOW_MS,
        blockMs: LOGIN_RATE_LIMIT_BLOCK_MS,
      },
    )
    if (usernameLimitDecision.limited) {
      writeRateLimitedResponse(
        res,
        usernameLimitDecision.retryAfterSeconds,
        'Too many login attempts for this account. Try again later.',
      )
      return
    }

    const usernameCandidates = username
      ? [username]
      : [bootstrapAdminUsername]

    if (!username) {
      const existingUsers = await listUsers()
      if (existingUsers.length === 1 && existingUsers[0].username !== bootstrapAdminUsername) {
        usernameCandidates.push(existingUsers[0].username)
      }
    }

    let signedInUser: UserProfile | null = null
    for (const usernameCandidate of usernameCandidates) {
      const authenticated = await authenticateUser(usernameCandidate, password)
      if (authenticated) {
        signedInUser = authenticated
        break
      }
    }

    if (!signedInUser) {
      incrementRateLimitAttempt(
        loginRateLimitByIp,
        remoteAddressKey,
        { windowMs: LOGIN_RATE_LIMIT_WINDOW_MS },
      )
      incrementRateLimitAttempt(
        loginRateLimitByUsername,
        usernameKey,
        { windowMs: LOGIN_RATE_LIMIT_WINDOW_MS },
      )
      res.status(401).json({ error: 'Invalid credentials' })
      return
    }

    clearRateLimit(loginRateLimitByIp, remoteAddressKey)
    clearRateLimit(loginRateLimitByUsername, usernameKey)

    const token = createSession(signedInUser.id)
    res.setHeader('Set-Cookie', buildSessionCookie(req, token))
    setRequestAuthenticatedUser(req, signedInUser)
    res.json({ ok: true, user: signedInUser })
  }

  async function handleSession(req: Request, res: Response, currentUser: UserProfile | null): Promise<void> {
    if (!currentUser) {
      res.status(200).json({ authenticated: false })
      return
    }

    res.status(200).json({
      authenticated: true,
      user: currentUser,
    })
  }

  async function handleLogout(req: Request, res: Response): Promise<void> {
    clearSession(req)
    setRequestAuthenticatedUser(req, null)
    res.setHeader('Set-Cookie', buildClearSessionCookie(req))
    res.status(200).json({ ok: true })
  }

  async function handleRequest(req: Request, res: Response, next: NextFunction): Promise<void> {
    await bootstrapPromise

    const path = normalizePath(req.path)
    const currentUser = await resolveSessionUser(req)
    setRequestAuthenticatedUser(req, currentUser)

    if (req.method === 'POST' && path === '/auth/signup') {
      await handleSignup(req, res, currentUser)
      return
    }

    if (req.method === 'POST' && path === '/auth/login') {
      await handleLogin(req, res)
      return
    }

    if (req.method === 'GET' && path === '/auth/session') {
      await handleSession(req, res, currentUser)
      return
    }

    if (req.method === 'POST' && path === '/auth/logout') {
      await handleLogout(req, res)
      return
    }

    if (path.startsWith('/auth/')) {
      res.status(405).json({ error: 'Method not allowed' })
      return
    }

    if (currentUser) {
      next()
      return
    }

    if (isPublicRelayAgentPath(path, req.method.toUpperCase())) {
      next()
      return
    }

    if (shouldReturnJsonForUnauthorized(req)) {
      res.status(401).json({ error: 'Authentication required' })
      return
    }

    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    res.status(200).send(renderLoginPage(bootstrapAdminUsername))
  }

  return (req: Request, res: Response, next: NextFunction): void => {
    void handleRequest(req, res, next).catch((error: unknown) => {
      if (error instanceof UserStoreError) {
        res.status(error.statusCode).json({ error: error.message, code: error.code })
        return
      }
      const message = error instanceof Error ? error.message : 'Authentication error'
      res.status(500).json({ error: message })
    })
  }
}
