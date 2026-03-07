import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

const USER_STORE_VERSION = 1
const USER_STORE_RELATIVE_PATH = join('codexui', 'users.json')
const USERNAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{1,63}$/u
const MIN_PASSWORD_LENGTH = 8
const HASH_ALGORITHM = 'scrypt'
const HASH_KEY_BYTES = 64
const DEFAULT_SCRYPT_PARAMS = {
  N: 16_384,
  r: 8,
  p: 1,
  maxmem: 64 * 1024 * 1024,
}

function scrypt(password: string, salt: Buffer, keyLength: number, options: {
  N: number
  r: number
  p: number
  maxmem: number
}): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, keyLength, options, (error, derivedKey) => {
      if (error) {
        reject(error)
        return
      }
      resolve(derivedKey)
    })
  })
}

export type UserRole = 'admin' | 'user'

type StoredUser = {
  id: string
  username: string
  usernameLower: string
  role: UserRole
  passwordHash: string
  createdAtIso: string
  updatedAtIso: string
  lastLoginAtIso?: string
}

type UserStoreState = {
  version: number
  users: StoredUser[]
}

export type UserProfile = {
  id: string
  username: string
  role: UserRole
  createdAtIso: string
  updatedAtIso: string
  lastLoginAtIso?: string
}

export type BootstrapAdminCredential =
  | { password: string; passwordHash?: never }
  | { password?: never; passwordHash: string }

export class UserStoreError extends Error {
  readonly code: string
  readonly statusCode: number

  constructor(code: string, message: string, statusCode = 400) {
    super(message)
    this.code = code
    this.statusCode = statusCode
  }
}

let cachedState: UserStoreState | null = null
let mutationQueue: Promise<unknown> = Promise.resolve()

function getCodexHomeDir(): string {
  const codexHome = process.env.CODEX_HOME?.trim()
  return codexHome && codexHome.length > 0 ? codexHome : join(homedir(), '.codex')
}

function getUserStorePath(): string {
  return join(getCodexHomeDir(), USER_STORE_RELATIVE_PATH)
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function cloneUser(user: StoredUser): StoredUser {
  return { ...user }
}

function cloneState(state: UserStoreState): UserStoreState {
  return {
    version: state.version,
    users: state.users.map(cloneUser),
  }
}

function normalizeUsername(value: string): string {
  return value.trim()
}

function normalizeRole(value: unknown): UserRole {
  return value === 'admin' ? 'admin' : 'user'
}

function parseDate(value: unknown, fallbackIso: string): string {
  if (typeof value !== 'string') return fallbackIso
  const trimmed = value.trim()
  if (!trimmed) return fallbackIso
  const parsed = new Date(trimmed)
  return Number.isNaN(parsed.valueOf()) ? fallbackIso : parsed.toISOString()
}

function normalizeStoredUser(value: unknown, nowIso: string): StoredUser | null {
  const record = asRecord(value)
  if (!record) return null

  const id = typeof record.id === 'string' ? record.id.trim() : ''
  const username = typeof record.username === 'string' ? normalizeUsername(record.username) : ''
  const usernameLower = typeof record.usernameLower === 'string' && record.usernameLower.trim().length > 0
    ? record.usernameLower.trim().toLowerCase()
    : username.toLowerCase()
  const passwordHash = typeof record.passwordHash === 'string' ? record.passwordHash.trim() : ''

  if (!id || !username || !USERNAME_PATTERN.test(username) || !usernameLower || !passwordHash) {
    return null
  }

  const createdAtIso = parseDate(record.createdAtIso, nowIso)
  const updatedAtIso = parseDate(record.updatedAtIso, createdAtIso)
  const lastLoginAtIso = typeof record.lastLoginAtIso === 'string' && record.lastLoginAtIso.trim().length > 0
    ? parseDate(record.lastLoginAtIso, updatedAtIso)
    : undefined

  return {
    id,
    username,
    usernameLower,
    role: normalizeRole(record.role),
    passwordHash,
    createdAtIso,
    updatedAtIso,
    ...(lastLoginAtIso ? { lastLoginAtIso } : {}),
  }
}

function normalizeState(value: unknown, nowIso = new Date().toISOString()): UserStoreState {
  const root = asRecord(value)
  const rows = Array.isArray(root?.users)
    ? root.users
    : Array.isArray(value)
      ? value
      : []

  const usersById = new Map<string, StoredUser>()
  const usernames = new Set<string>()

  for (const row of rows) {
    const user = normalizeStoredUser(row, nowIso)
    if (!user) continue
    if (usersById.has(user.id)) continue
    if (usernames.has(user.usernameLower)) continue
    usersById.set(user.id, user)
    usernames.add(user.usernameLower)
  }

  return {
    version: USER_STORE_VERSION,
    users: Array.from(usersById.values()),
  }
}

async function readStateFromDisk(): Promise<UserStoreState> {
  const storePath = getUserStorePath()
  try {
    const raw = await readFile(storePath, 'utf8')
    return normalizeState(JSON.parse(raw) as unknown)
  } catch {
    return normalizeState(null)
  }
}

async function writeStateToDisk(nextState: UserStoreState): Promise<void> {
  const storePath = getUserStorePath()
  await mkdir(dirname(storePath), { recursive: true })
  const payload = JSON.stringify(nextState, null, 2)
  const tempPath = `${storePath}.${process.pid}.${Date.now()}.tmp`
  await writeFile(tempPath, payload, { encoding: 'utf8', mode: 0o600 })
  await rename(tempPath, storePath)
}

async function loadState(): Promise<UserStoreState> {
  if (cachedState) return cloneState(cachedState)
  const state = await readStateFromDisk()
  cachedState = cloneState(state)
  return cloneState(state)
}

async function persistState(nextState: UserStoreState): Promise<void> {
  const normalized = normalizeState(nextState)
  await writeStateToDisk(normalized)
  cachedState = cloneState(normalized)
}

function waitForMutations(): Promise<void> {
  return mutationQueue.then(() => undefined, () => undefined)
}

function enqueueMutation<T>(run: () => Promise<T>): Promise<T> {
  const pending = mutationQueue.then(run, run)
  mutationQueue = pending.then(() => undefined, () => undefined)
  return pending
}

function toUserProfile(user: StoredUser): UserProfile {
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    createdAtIso: user.createdAtIso,
    updatedAtIso: user.updatedAtIso,
    ...(user.lastLoginAtIso ? { lastLoginAtIso: user.lastLoginAtIso } : {}),
  }
}

function parseScryptParams(raw: string): { N: number; r: number; p: number } | null {
  const rows = raw.split(',')
  const result: Record<string, number> = {}
  for (const row of rows) {
    const [keyRaw, valueRaw] = row.split('=', 2)
    const key = keyRaw?.trim()
    const value = Number(valueRaw)
    if (!key || !Number.isFinite(value) || value <= 0) {
      return null
    }
    result[key] = Math.trunc(value)
  }

  if (!result.N || !result.r || !result.p) return null
  return {
    N: result.N,
    r: result.r,
    p: result.p,
  }
}

async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16)
  const derived = await scrypt(password, salt, HASH_KEY_BYTES, DEFAULT_SCRYPT_PARAMS)
  const params = `N=${String(DEFAULT_SCRYPT_PARAMS.N)},r=${String(DEFAULT_SCRYPT_PARAMS.r)},p=${String(DEFAULT_SCRYPT_PARAMS.p)}`
  return `${HASH_ALGORITHM}$${params}$${salt.toString('base64url')}$${derived.toString('base64url')}`
}

export async function createPasswordHash(password: string): Promise<string> {
  return hashPassword(password)
}

function parsePasswordHash(encodedHash: string): {
  algorithm: string
  params: { N: number; r: number; p: number }
  salt: Buffer
  expected: Buffer
} | null {
  const [algorithm, paramsRaw, saltRaw, expectedRaw] = encodedHash.split('$')
  if (algorithm !== HASH_ALGORITHM || !paramsRaw || !saltRaw || !expectedRaw) {
    return null
  }

  const params = parseScryptParams(paramsRaw)
  if (!params) return null

  let salt: Buffer
  let expected: Buffer
  try {
    salt = Buffer.from(saltRaw, 'base64url')
    expected = Buffer.from(expectedRaw, 'base64url')
  } catch {
    return null
  }

  if (salt.length === 0 || expected.length === 0) {
    return null
  }

  return {
    algorithm,
    params,
    salt,
    expected,
  }
}

export function isSupportedPasswordHash(encodedHash: string): boolean {
  return parsePasswordHash(encodedHash) !== null
}

async function verifyPassword(password: string, encodedHash: string): Promise<boolean> {
  const parsed = parsePasswordHash(encodedHash)
  if (!parsed) {
    return false
  }

  const derived = await scrypt(password, parsed.salt, parsed.expected.length, {
    ...parsed.params,
    maxmem: DEFAULT_SCRYPT_PARAMS.maxmem,
  })
  const actual = derived

  if (actual.length !== parsed.expected.length) {
    return false
  }
  return timingSafeEqual(actual, parsed.expected)
}

function assertValidUsername(username: string): void {
  if (!USERNAME_PATTERN.test(username)) {
    throw new UserStoreError(
      'invalid_username',
      'Username must be 2-64 chars and use letters, numbers, dot, underscore, or dash.',
      400,
    )
  }
}

function assertValidPassword(password: string): void {
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new UserStoreError('invalid_password', `Password must be at least ${String(MIN_PASSWORD_LENGTH)} characters.`, 400)
  }
}

function assertNonEmptyPassword(password: string): void {
  if (!password) {
    throw new UserStoreError('invalid_password', 'Password cannot be empty.', 400)
  }
}

function normalizeBootstrapAdminCredential(
  credential: string | BootstrapAdminCredential,
): BootstrapAdminCredential {
  if (typeof credential === 'string') {
    assertNonEmptyPassword(credential)
    return { password: credential }
  }

  const password = typeof credential.password === 'string' ? credential.password : ''
  const passwordHash = typeof credential.passwordHash === 'string' ? credential.passwordHash.trim() : ''

  if (password && passwordHash) {
    throw new UserStoreError(
      'invalid_bootstrap_credential',
      'Bootstrap admin credential cannot include both a password and a password hash.',
      400,
    )
  }

  if (passwordHash) {
    if (!isSupportedPasswordHash(passwordHash)) {
      throw new UserStoreError('invalid_password_hash', 'Unsupported password hash format.', 400)
    }
    return { passwordHash }
  }

  assertNonEmptyPassword(password)
  return { password }
}

function findUserByUsername(state: UserStoreState, username: string): StoredUser | null {
  const normalized = username.toLowerCase()
  return state.users.find((candidate) => candidate.usernameLower === normalized) ?? null
}

export async function countUsers(): Promise<number> {
  await waitForMutations()
  const state = await loadState()
  return state.users.length
}

export async function listUsers(): Promise<UserProfile[]> {
  await waitForMutations()
  const state = await loadState()
  return state.users
    .map(toUserProfile)
    .sort((a, b) => a.username.localeCompare(b.username))
}

export async function findUserById(userId: string): Promise<UserProfile | null> {
  const normalized = userId.trim()
  if (!normalized) return null

  await waitForMutations()
  const state = await loadState()
  const user = state.users.find((candidate) => candidate.id === normalized)
  return user ? toUserProfile(user) : null
}

export async function authenticateUser(username: string, password: string): Promise<UserProfile | null> {
  const normalizedUsername = normalizeUsername(username)
  if (!normalizedUsername || !password) {
    return null
  }

  return enqueueMutation(async () => {
    const state = await loadState()
    const user = findUserByUsername(state, normalizedUsername)
    if (!user) return null

    const valid = await verifyPassword(password, user.passwordHash)
    if (!valid) return null

    const nowIso = new Date().toISOString()
    user.lastLoginAtIso = nowIso
    user.updatedAtIso = nowIso

    await persistState(state)
    return toUserProfile(user)
  })
}

export async function createUser(input: {
  username: string
  password: string
  role?: UserRole
}): Promise<UserProfile> {
  const username = normalizeUsername(input.username)
  const password = input.password
  assertValidUsername(username)
  assertValidPassword(password)

  const role = normalizeRole(input.role)

  return enqueueMutation(async () => {
    const state = await loadState()
    if (findUserByUsername(state, username)) {
      throw new UserStoreError('user_exists', `User "${username}" already exists.`, 409)
    }

    const nowIso = new Date().toISOString()
    const user: StoredUser = {
      id: randomBytes(16).toString('hex'),
      username,
      usernameLower: username.toLowerCase(),
      role,
      passwordHash: await hashPassword(password),
      createdAtIso: nowIso,
      updatedAtIso: nowIso,
    }

    state.users.push(user)
    await persistState(state)
    return toUserProfile(user)
  })
}

export async function upsertBootstrapAdmin(
  username: string,
  credential: string | BootstrapAdminCredential,
): Promise<UserProfile> {
  const normalizedUsername = normalizeUsername(username)
  const normalizedCredential = normalizeBootstrapAdminCredential(credential)
  assertValidUsername(normalizedUsername)

  return enqueueMutation(async () => {
    const state = await loadState()
    const nowIso = new Date().toISOString()
    const existing = findUserByUsername(state, normalizedUsername)
    const passwordHash = 'passwordHash' in normalizedCredential
      ? normalizedCredential.passwordHash
      : await hashPassword(normalizedCredential.password)

    if (existing) {
      existing.passwordHash = passwordHash
      existing.role = 'admin'
      existing.updatedAtIso = nowIso
      await persistState(state)
      return toUserProfile(existing)
    }

    const created: StoredUser = {
      id: randomBytes(16).toString('hex'),
      username: normalizedUsername,
      usernameLower: normalizedUsername.toLowerCase(),
      role: 'admin',
      passwordHash,
      createdAtIso: nowIso,
      updatedAtIso: nowIso,
    }

    state.users.push(created)
    await persistState(state)
    return toUserProfile(created)
  })
}
