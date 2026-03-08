import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto'
import { join } from 'node:path'
import {
  getHubDatabase,
  getLegacyUserStorePath,
  readLegacyJsonFile,
} from './sqliteStore.js'

const USER_STORE_VERSION = 2
const LEGACY_USER_STORE_RELATIVE_PATH = join('codexui', 'users.json')
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
export type UserApprovalStatus = 'pending' | 'approved'
export type BootstrapState = 'none' | 'pending_setup' | 'consumed'

type StoredUser = {
  id: string
  username: string
  usernameLower: string
  role: UserRole
  approvalStatus: UserApprovalStatus
  passwordHash: string
  mustChangeUsername: boolean
  mustChangePassword: boolean
  isBootstrapAdmin: boolean
  bootstrapState: BootstrapState
  setupCompletedAtIso?: string
  createdAtIso: string
  updatedAtIso: string
  lastLoginAtIso?: string
  approvedAtIso?: string
  approvedByUserId?: string
}

type UserStoreState = {
  version: number
  users: StoredUser[]
}

export type UserProfile = {
  id: string
  username: string
  role: UserRole
  approvalStatus: UserApprovalStatus
  mustChangeUsername: boolean
  mustChangePassword: boolean
  isBootstrapAdmin: boolean
  bootstrapState: BootstrapState
  setupCompletedAtIso?: string
  createdAtIso: string
  updatedAtIso: string
  lastLoginAtIso?: string
  approvedAtIso?: string
  approvedByUserId?: string
}

export type BootstrapAdminCredential =
  | { password: string; passwordHash?: never }
  | { password?: never; passwordHash: string }

export type AuthenticationResult =
  | { status: 'authenticated'; user: UserProfile }
  | { status: 'invalid' }
  | { status: 'pending'; user: UserProfile }

export class UserStoreError extends Error {
  readonly code: string
  readonly statusCode: number

  constructor(code: string, message: string, statusCode = 400) {
    super(message)
    this.code = code
    this.statusCode = statusCode
  }
}

let hasImportedLegacyUsers = false
let mutationQueue: Promise<unknown> = Promise.resolve()

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function normalizeUsername(value: string): string {
  return value.trim()
}

function normalizeRole(value: unknown): UserRole {
  return value === 'admin' ? 'admin' : 'user'
}

function normalizeApprovalStatus(value: unknown): UserApprovalStatus {
  return value === 'pending' ? 'pending' : 'approved'
}

function normalizeBootstrapState(value: unknown): BootstrapState {
  return value === 'pending_setup' || value === 'consumed' ? value : 'none'
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
  const mustChangeUsername = record.mustChangeUsername === true
  const mustChangePassword = record.mustChangePassword === true
  const isBootstrapAdmin = record.isBootstrapAdmin === true
  const bootstrapState = normalizeBootstrapState(record.bootstrapState)
  const setupCompletedAtIso = typeof record.setupCompletedAtIso === 'string' && record.setupCompletedAtIso.trim().length > 0
    ? parseDate(record.setupCompletedAtIso, updatedAtIso)
    : undefined
  const approvalStatus = normalizeApprovalStatus(record.approvalStatus)
  const approvedAtIso = typeof record.approvedAtIso === 'string' && record.approvedAtIso.trim().length > 0
    ? parseDate(record.approvedAtIso, updatedAtIso)
    : approvalStatus === 'approved'
      ? updatedAtIso
      : undefined
  const approvedByUserId = typeof record.approvedByUserId === 'string' && record.approvedByUserId.trim().length > 0
    ? record.approvedByUserId.trim()
    : undefined

  return {
    id,
    username,
    usernameLower,
    role: normalizeRole(record.role),
    approvalStatus,
    passwordHash,
    mustChangeUsername,
    mustChangePassword,
    isBootstrapAdmin,
    bootstrapState,
    ...(setupCompletedAtIso ? { setupCompletedAtIso } : {}),
    createdAtIso,
    updatedAtIso,
    ...(lastLoginAtIso ? { lastLoginAtIso } : {}),
    ...(approvedAtIso ? { approvedAtIso } : {}),
    ...(approvedByUserId ? { approvedByUserId } : {}),
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

function toUserProfile(user: StoredUser): UserProfile {
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    approvalStatus: user.approvalStatus,
    mustChangeUsername: user.mustChangeUsername,
    mustChangePassword: user.mustChangePassword,
    isBootstrapAdmin: user.isBootstrapAdmin,
    bootstrapState: user.bootstrapState,
    ...(user.setupCompletedAtIso ? { setupCompletedAtIso: user.setupCompletedAtIso } : {}),
    createdAtIso: user.createdAtIso,
    updatedAtIso: user.updatedAtIso,
    ...(user.lastLoginAtIso ? { lastLoginAtIso: user.lastLoginAtIso } : {}),
    ...(user.approvedAtIso ? { approvedAtIso: user.approvedAtIso } : {}),
    ...(user.approvedByUserId ? { approvedByUserId: user.approvedByUserId } : {}),
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

  if (derived.length !== parsed.expected.length) {
    return false
  }
  return timingSafeEqual(derived, parsed.expected)
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

function rowToStoredUser(row: Record<string, unknown>): StoredUser {
  return {
    id: String(row.id),
    username: String(row.username),
    usernameLower: String(row.username_lower),
    role: normalizeRole(row.role),
    approvalStatus: normalizeApprovalStatus(row.approval_status),
    passwordHash: String(row.password_hash),
    mustChangeUsername: Number(row.must_change_username) === 1,
    mustChangePassword: Number(row.must_change_password) === 1,
    isBootstrapAdmin: Number(row.is_bootstrap_admin) === 1,
    bootstrapState: normalizeBootstrapState(row.bootstrap_state),
    ...(typeof row.setup_completed_at_iso === 'string' ? { setupCompletedAtIso: row.setup_completed_at_iso } : {}),
    createdAtIso: String(row.created_at_iso),
    updatedAtIso: String(row.updated_at_iso),
    ...(typeof row.last_login_at_iso === 'string' ? { lastLoginAtIso: row.last_login_at_iso } : {}),
    ...(typeof row.approved_at_iso === 'string' ? { approvedAtIso: row.approved_at_iso } : {}),
    ...(typeof row.approved_by_user_id === 'string' ? { approvedByUserId: row.approved_by_user_id } : {}),
  }
}

function importLegacyUsersIfNeeded(): void {
  if (hasImportedLegacyUsers) {
    return
  }

  const database = getHubDatabase()
  const countRow = database.prepare('SELECT COUNT(*) AS total FROM users').get() as { total: number }
  if (countRow.total > 0) {
    hasImportedLegacyUsers = true
    return
  }

  const legacyState = normalizeState(readLegacyJsonFile(getLegacyUserStorePath()))
  if (legacyState.users.length === 0) {
    hasImportedLegacyUsers = true
    return
  }

  const insert = database.prepare(`
    INSERT INTO users (
      id,
      username,
      username_lower,
      role,
      approval_status,
      password_hash,
      created_at_iso,
      updated_at_iso,
      last_login_at_iso,
      approved_at_iso,
      approved_by_user_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  const insertMany = database.transaction((users: StoredUser[]) => {
    for (const user of users) {
      insert.run(
        user.id,
        user.username,
        user.usernameLower,
        user.role,
        user.approvalStatus,
        user.passwordHash,
        user.createdAtIso,
        user.updatedAtIso,
        user.lastLoginAtIso ?? null,
        user.approvedAtIso ?? user.updatedAtIso,
        user.approvedByUserId ?? null,
      )
    }
  })

  insertMany(legacyState.users)
  hasImportedLegacyUsers = true
}

function waitForMutations(): Promise<void> {
  return mutationQueue.then(() => undefined, () => undefined)
}

function enqueueMutation<T>(run: () => Promise<T>): Promise<T> {
  const pending = mutationQueue.then(run, run)
  mutationQueue = pending.then(() => undefined, () => undefined)
  return pending
}

function findUserByUsernameRow(username: string): Record<string, unknown> | undefined {
  importLegacyUsersIfNeeded()
  return getHubDatabase().prepare('SELECT * FROM users WHERE username_lower = ?').get(username.toLowerCase()) as Record<string, unknown> | undefined
}

export async function countUsers(): Promise<number> {
  await waitForMutations()
  importLegacyUsersIfNeeded()
  const row = getHubDatabase().prepare('SELECT COUNT(*) AS total FROM users').get() as { total: number }
  return row.total
}

export async function listUsers(): Promise<UserProfile[]> {
  await waitForMutations()
  importLegacyUsersIfNeeded()
  const rows = getHubDatabase().prepare('SELECT * FROM users ORDER BY username_lower ASC').all() as Record<string, unknown>[]
  return rows.map((row) => toUserProfile(rowToStoredUser(row)))
}

export async function findUserById(userId: string): Promise<UserProfile | null> {
  const normalized = userId.trim()
  if (!normalized) return null

  await waitForMutations()
  importLegacyUsersIfNeeded()
  const row = getHubDatabase().prepare('SELECT * FROM users WHERE id = ?').get(normalized) as Record<string, unknown> | undefined
  return row ? toUserProfile(rowToStoredUser(row)) : null
}

export async function attemptAuthenticateUser(username: string, password: string): Promise<AuthenticationResult> {
  const normalizedUsername = normalizeUsername(username)
  if (!normalizedUsername || !password) {
    return { status: 'invalid' }
  }

  return enqueueMutation(async () => {
    const row = findUserByUsernameRow(normalizedUsername)
    if (!row) return { status: 'invalid' }

    const user = rowToStoredUser(row)
    const valid = await verifyPassword(password, user.passwordHash)
    if (!valid) return { status: 'invalid' }

    if (user.approvalStatus !== 'approved') {
      return {
        status: 'pending',
        user: toUserProfile(user),
      }
    }

    const nowIso = new Date().toISOString()
    getHubDatabase().prepare(`
      UPDATE users
      SET last_login_at_iso = ?, updated_at_iso = ?
      WHERE id = ?
    `).run(nowIso, nowIso, user.id)

    return {
      status: 'authenticated',
      user: {
        ...toUserProfile(user),
        lastLoginAtIso: nowIso,
        updatedAtIso: nowIso,
      },
    }
  })
}

export async function authenticateUser(username: string, password: string): Promise<UserProfile | null> {
  const result = await attemptAuthenticateUser(username, password)
  return result.status === 'authenticated' ? result.user : null
}

export async function createUser(input: {
  username: string
  password: string
  role?: UserRole
  approvalStatus?: UserApprovalStatus
  approvedByUserId?: string
}): Promise<UserProfile> {
  const username = normalizeUsername(input.username)
  const password = input.password
  assertValidUsername(username)
  assertValidPassword(password)

  const role = normalizeRole(input.role)
  const approvalStatus = normalizeApprovalStatus(input.approvalStatus)

  return enqueueMutation(async () => {
    importLegacyUsersIfNeeded()
    if (findUserByUsernameRow(username)) {
      throw new UserStoreError('user_exists', `User "${username}" already exists.`, 409)
    }

    const nowIso = new Date().toISOString()
    const passwordHash = await hashPassword(password)
    const approvedAtIso = approvalStatus === 'approved' ? nowIso : undefined
    const approvedByUserId = approvalStatus === 'approved'
      ? (input.approvedByUserId?.trim() || undefined)
      : undefined

    getHubDatabase().prepare(`
      INSERT INTO users (
        id,
        username,
        username_lower,
        role,
        approval_status,
        password_hash,
        must_change_username,
        must_change_password,
        is_bootstrap_admin,
        bootstrap_state,
        setup_completed_at_iso,
        created_at_iso,
        updated_at_iso,
        last_login_at_iso,
        approved_at_iso,
        approved_by_user_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      randomBytes(16).toString('hex'),
      username,
      username.toLowerCase(),
      role,
      approvalStatus,
      passwordHash,
      0,
      0,
      0,
      'none',
      null,
      nowIso,
      nowIso,
      null,
      approvedAtIso ?? null,
      approvedByUserId ?? null,
    )

    const createdRow = findUserByUsernameRow(username)
    if (!createdRow) {
      throw new UserStoreError('user_create_failed', `Failed to create user "${username}".`, 500)
    }
    return toUserProfile(rowToStoredUser(createdRow))
  })
}

export async function approveUser(userId: string, approvedByUserId: string): Promise<UserProfile> {
  const normalizedUserId = userId.trim()
  const normalizedApprovedByUserId = approvedByUserId.trim()
  if (!normalizedUserId) {
    throw new UserStoreError('invalid_user_id', 'User id is required.', 400)
  }
  if (!normalizedApprovedByUserId) {
    throw new UserStoreError('invalid_approver', 'Approver user id is required.', 400)
  }

  return enqueueMutation(async () => {
    importLegacyUsersIfNeeded()
    const currentRow = getHubDatabase().prepare('SELECT * FROM users WHERE id = ?').get(normalizedUserId) as Record<string, unknown> | undefined
    if (!currentRow) {
      throw new UserStoreError('user_not_found', `User "${normalizedUserId}" was not found.`, 404)
    }

    const user = rowToStoredUser(currentRow)
    const nowIso = new Date().toISOString()
    const approvedAtIso = user.approvalStatus === 'approved' && user.approvedAtIso
      ? user.approvedAtIso
      : nowIso

    getHubDatabase().prepare(`
      UPDATE users
      SET approval_status = 'approved',
          approved_at_iso = ?,
          approved_by_user_id = ?,
          updated_at_iso = ?
      WHERE id = ?
    `).run(approvedAtIso, normalizedApprovedByUserId, nowIso, normalizedUserId)

    const updatedRow = getHubDatabase().prepare('SELECT * FROM users WHERE id = ?').get(normalizedUserId) as Record<string, unknown>
    return toUserProfile(rowToStoredUser(updatedRow))
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
    importLegacyUsersIfNeeded()
    const nowIso = new Date().toISOString()
    const existingRow = findUserByUsernameRow(normalizedUsername)
    const passwordHash = ('passwordHash' in normalizedCredential && typeof normalizedCredential.passwordHash === 'string')
      ? normalizedCredential.passwordHash
      : await hashPassword(normalizedCredential.password)

    if (existingRow) {
      getHubDatabase().prepare(`
        UPDATE users
        SET password_hash = ?,
            role = 'admin',
            approval_status = 'approved',
            must_change_username = 1,
            must_change_password = 1,
            is_bootstrap_admin = 1,
            bootstrap_state = 'pending_setup',
            setup_completed_at_iso = NULL,
            approved_at_iso = COALESCE(approved_at_iso, ?),
            updated_at_iso = ?
        WHERE id = ?
      `).run(passwordHash, nowIso, nowIso, existingRow.id)
      const updatedRow = getHubDatabase().prepare('SELECT * FROM users WHERE id = ?').get(existingRow.id) as Record<string, unknown>
      return toUserProfile(rowToStoredUser(updatedRow))
    }

    const created: StoredUser = {
      id: randomBytes(16).toString('hex'),
      username: normalizedUsername,
      usernameLower: normalizedUsername.toLowerCase(),
      role: 'admin',
      approvalStatus: 'approved',
      passwordHash,
      mustChangeUsername: true,
      mustChangePassword: true,
      isBootstrapAdmin: true,
      bootstrapState: 'pending_setup',
      createdAtIso: nowIso,
      updatedAtIso: nowIso,
      approvedAtIso: nowIso,
    }

    getHubDatabase().prepare(`
      INSERT INTO users (
        id,
        username,
        username_lower,
        role,
        approval_status,
        password_hash,
        must_change_username,
        must_change_password,
        is_bootstrap_admin,
        bootstrap_state,
        setup_completed_at_iso,
        created_at_iso,
        updated_at_iso,
        last_login_at_iso,
        approved_at_iso,
        approved_by_user_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      created.id,
      created.username,
      created.usernameLower,
      created.role,
      created.approvalStatus,
      created.passwordHash,
      1,
      1,
      1,
      'pending_setup',
      null,
      created.createdAtIso,
      created.updatedAtIso,
      null,
      created.approvedAtIso,
      null,
    )

    return toUserProfile(created)
  })
}
