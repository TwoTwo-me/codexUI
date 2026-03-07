import { randomBytes } from 'node:crypto'
import type { RequestHandler, Request, Response, NextFunction } from 'express'
import {
  type BootstrapAdminCredential,
  UserStoreError,
  attemptAuthenticateUser,
  countUsers,
  createUser,
  findUserById,
  listUsers,
  type UserProfile,
  type UserRole,
  upsertBootstrapAdmin,
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
  bootstrapAdminPassword?: string
  bootstrapAdminPasswordHash?: string
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
  return remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1'
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
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#09090b;color:#e4e4e7;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:1.25rem}
.shell{width:100%;max-width:960px;display:grid;gap:1rem}
.hero{display:flex;flex-direction:column;gap:.35rem;align-items:flex-start}
.hero h1{font-size:1.65rem;font-weight:700;color:#fafafa}
.hero p{color:#a1a1aa;font-size:.95rem}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:1rem}
.card{background:#111114;border:1px solid #27272a;border-radius:16px;padding:1.5rem;box-shadow:0 20px 40px rgba(0,0,0,.25)}
.card h2{font-size:1.125rem;font-weight:600;color:#fafafa;margin-bottom:.35rem}
.card p{color:#a1a1aa;font-size:.875rem;margin-bottom:1rem;line-height:1.5}
label{display:block;font-size:.875rem;color:#c4c4c5;margin-bottom:.45rem}
.field{margin-bottom:.95rem}
input{width:100%;padding:.7rem .85rem;background:#09090b;border:1px solid #3f3f46;border-radius:10px;color:#fafafa;font-size:1rem;outline:none;transition:border-color .15s,box-shadow .15s}
input:focus{border-color:#3b82f6;box-shadow:0 0 0 3px rgba(59,130,246,.2)}
button{width:100%;padding:.7rem .85rem;margin-top:.15rem;background:#2563eb;color:#fff;border:none;border-radius:10px;font-size:.95rem;font-weight:600;cursor:pointer;transition:background .15s}
button:hover{background:#1d4ed8}
button.secondary{background:#27272a}
button.secondary:hover{background:#3f3f46}
.hint{color:#71717a;font-size:.78rem;margin-top:.55rem;line-height:1.45}
.message{font-size:.85rem;margin-top:.85rem;display:none;line-height:1.45}
.message.error{color:#f87171}
.message.success{color:#4ade80}
.message.visible{display:block}
.pending-note{display:none;margin-top:.85rem;padding:.75rem .85rem;border-radius:10px;background:rgba(34,197,94,.08);border:1px solid rgba(34,197,94,.28);color:#86efac;font-size:.85rem;line-height:1.5}
.pending-note.visible{display:block}
@media (max-width: 720px){body{padding:1rem}.card{padding:1.25rem}}
</style>
</head>
<body>
<div class="shell">
  <header class="hero">
    <h1>Codex Web Local</h1>
    <p>Sign in to the Hub or request access for a new account.</p>
  </header>
  <div class="grid">
    <section class="card">
      <h2>Sign in</h2>
      <p>Use your approved Hub account to access registered servers, projects, and threads.</p>
      <form id="login-form">
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
        <p class="message error" id="login-error"></p>
      </form>
    </section>
    <section class="card">
      <h2>Request access</h2>
      <p>Create a user request. An administrator must approve it before you can sign in.</p>
      <form id="register-form">
        <div class="field">
          <label for="register-username">Create username</label>
          <input id="register-username" name="username" autocomplete="username" required>
        </div>
        <div class="field">
          <label for="register-password">Create password</label>
          <input id="register-password" name="password" type="password" autocomplete="new-password" required>
        </div>
        <button type="submit" class="secondary">Request access</button>
        <div class="pending-note" id="register-success">Your access request is pending admin approval.</div>
        <p class="message error" id="register-error"></p>
      </form>
    </section>
  </div>
</div>
<script>
const loginForm=document.getElementById('login-form');
const registerForm=document.getElementById('register-form');
const loginError=document.getElementById('login-error');
const registerError=document.getElementById('register-error');
const registerSuccess=document.getElementById('register-success');
const usernameEl=document.getElementById('username');
const pwEl=document.getElementById('pw');
const registerUsernameEl=document.getElementById('register-username');
const registerPasswordEl=document.getElementById('register-password');

function setMessage(el, message, visible){
  if(!el) return;
  el.textContent=message || '';
  el.classList.toggle('visible', !!visible);
}

loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  setMessage(loginError, '', false);
  const payload={password:pwEl.value};
  if(usernameEl.value.trim()){payload.username=usernameEl.value.trim();}
  const res=await fetch('/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
  const body=await res.json().catch(()=>({}));
  if(res.ok){window.location.reload();return;}
  const fallback=res.status===403?'Your account is waiting for admin approval.':'Invalid credentials';
  const message=typeof body.error==='string'&&body.error.trim()?body.error:fallback;
  setMessage(loginError, message, true);
  pwEl.value='';
  pwEl.focus();
});

registerForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  setMessage(registerError, '', false);
  registerSuccess.classList.remove('visible');
  const payload={username:registerUsernameEl.value.trim(),password:registerPasswordEl.value};
  const res=await fetch('/auth/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
  const body=await res.json().catch(()=>({}));
  if(res.ok){
    registerUsernameEl.value='';
    registerPasswordEl.value='';
    registerSuccess.classList.add('visible');
    usernameEl.value=payload.username;
    pwEl.focus();
    return;
  }
  const message=typeof body.error==='string'&&body.error.trim()?body.error:'Unable to submit access request';
  setMessage(registerError, message, true);
});
</script>
</body>
</html>`
}

export function createAuthMiddleware(passwordOrOptions: string | AuthMiddlewareOptions): RequestHandler {
  const options: AuthMiddlewareOptions = typeof passwordOrOptions === 'string'
    ? { bootstrapAdminPassword: passwordOrOptions }
    : passwordOrOptions

  const bootstrapAdminPassword = typeof options.bootstrapAdminPassword === 'string'
    ? options.bootstrapAdminPassword
    : ''
  const bootstrapAdminPasswordHash = typeof options.bootstrapAdminPasswordHash === 'string'
    ? options.bootstrapAdminPasswordHash.trim()
    : ''

  if ((bootstrapAdminPassword ? 1 : 0) + (bootstrapAdminPasswordHash ? 1 : 0) !== 1) {
    throw new Error('createAuthMiddleware requires exactly one bootstrap admin credential source.')
  }

  const bootstrapAdminUsername =
    (options.bootstrapAdminUsername && options.bootstrapAdminUsername.trim().length > 0
      ? options.bootstrapAdminUsername.trim()
      : DEFAULT_BOOTSTRAP_ADMIN_USERNAME)

  const sessionStore = new Map<string, SessionRecord>()
  const loginRateLimitByIp = new Map<string, RateLimitRecord>()
  const loginRateLimitByUsername = new Map<string, RateLimitRecord>()
  const signupRateLimitByIp = new Map<string, RateLimitRecord>()
  const bootstrapCredential: BootstrapAdminCredential = bootstrapAdminPasswordHash
    ? { passwordHash: bootstrapAdminPasswordHash }
    : { password: bootstrapAdminPassword }
  const bootstrapPromise = upsertBootstrapAdmin(bootstrapAdminUsername, bootstrapCredential)

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
    incrementRateLimitAttempt(signupRateLimitByIp, remoteAddressKey, { windowMs: SIGNUP_RATE_LIMIT_WINDOW_MS })

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
      approvalStatus: 'approved',
      approvedByUserId: currentUser?.id,
    })

    if (!currentUser) {
      const token = createSession(created.id)
      res.setHeader('Set-Cookie', buildSessionCookie(req, token))
      setRequestAuthenticatedUser(req, created)
    }

    res.status(201).json({ ok: true, user: created })
  }

  async function handleRegister(req: Request, res: Response): Promise<void> {
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
    incrementRateLimitAttempt(signupRateLimitByIp, remoteAddressKey, { windowMs: SIGNUP_RATE_LIMIT_WINDOW_MS })

    const body = await readJsonBody(req)
    if (!body) {
      res.status(400).json({ error: 'Invalid body: expected object' })
      return
    }

    const created = await createUser({
      username: toUsername(body.username),
      password: toPassword(body.password),
      role: 'user',
      approvalStatus: 'pending',
    })

    res.status(202).json({ ok: true, status: 'pending', user: created })
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
    const ipLimitDecision = evaluateRateLimit(loginRateLimitByIp, remoteAddressKey, {
      maxAttempts: LOGIN_RATE_LIMIT_MAX_PER_IP,
      windowMs: LOGIN_RATE_LIMIT_WINDOW_MS,
      blockMs: LOGIN_RATE_LIMIT_BLOCK_MS,
    })
    if (ipLimitDecision.limited) {
      writeRateLimitedResponse(res, ipLimitDecision.retryAfterSeconds, 'Too many login attempts from this IP. Try again later.')
      return
    }

    const usernameLimitDecision = evaluateRateLimit(loginRateLimitByUsername, usernameKey, {
      maxAttempts: LOGIN_RATE_LIMIT_MAX_PER_USERNAME,
      windowMs: LOGIN_RATE_LIMIT_WINDOW_MS,
      blockMs: LOGIN_RATE_LIMIT_BLOCK_MS,
    })
    if (usernameLimitDecision.limited) {
      writeRateLimitedResponse(
        res,
        usernameLimitDecision.retryAfterSeconds,
        'Too many login attempts for this account. Try again later.',
      )
      return
    }

    const usernameCandidates = username ? [username] : [bootstrapAdminUsername]
    if (!username) {
      const existingUsers = await listUsers()
      if (existingUsers.length === 1 && existingUsers[0].username !== bootstrapAdminUsername) {
        usernameCandidates.push(existingUsers[0].username)
      }
    }

    let signedInUser: UserProfile | null = null
    let pendingApprovalUser: UserProfile | null = null
    for (const usernameCandidate of usernameCandidates) {
      const authenticated = await attemptAuthenticateUser(usernameCandidate, password)
      if (authenticated.status === 'authenticated') {
        signedInUser = authenticated.user
        break
      }
      if (authenticated.status === 'pending') {
        pendingApprovalUser = authenticated.user
      }
    }

    if (!signedInUser && !pendingApprovalUser) {
      incrementRateLimitAttempt(loginRateLimitByIp, remoteAddressKey, { windowMs: LOGIN_RATE_LIMIT_WINDOW_MS })
      incrementRateLimitAttempt(loginRateLimitByUsername, usernameKey, { windowMs: LOGIN_RATE_LIMIT_WINDOW_MS })
      res.status(401).json({ error: 'Invalid credentials' })
      return
    }

    clearRateLimit(loginRateLimitByIp, remoteAddressKey)
    clearRateLimit(loginRateLimitByUsername, usernameKey)

    if (!signedInUser && pendingApprovalUser) {
      res.status(403).json({ error: 'Your account is waiting for admin approval.', user: pendingApprovalUser })
      return
    }

    const token = createSession(signedInUser!.id)
    res.setHeader('Set-Cookie', buildSessionCookie(req, token))
    setRequestAuthenticatedUser(req, signedInUser)
    res.json({ ok: true, user: signedInUser })
  }

  async function handleSession(_req: Request, res: Response, currentUser: UserProfile | null): Promise<void> {
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

    if (req.method === 'POST' && path === '/auth/register') {
      await handleRegister(req, res)
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
