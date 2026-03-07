import Database from 'better-sqlite3'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

const HUB_SQLITE_RELATIVE_PATH = join('codexui', 'hub.sqlite')
const LEGACY_GLOBAL_STATE_FILENAME = '.codex-global-state.json'
const LEGACY_USER_STORE_RELATIVE_PATH = join('codexui', 'users.json')

const HUB_STATE_SCOPE = 'hub'
const HUB_GLOBAL_STATE_ENTRY_KEY = 'codex-global-state'
const LEGACY_GLOBAL_STATE_MIGRATED_METADATA_KEY = 'legacy-global-state-migrated-v1'

type SqliteDatabase = InstanceType<typeof Database>

const databaseCache = new Map<string, SqliteDatabase>()

function normalizeCodexHomeDir(value: string | undefined): string {
  const trimmed = value?.trim() ?? ''
  return trimmed.length > 0 ? trimmed : join(homedir(), '.codex')
}

export function getCodexHomeDir(): string {
  return normalizeCodexHomeDir(process.env.CODEX_HOME)
}

export function getHubDatabasePath(): string {
  return join(getCodexHomeDir(), HUB_SQLITE_RELATIVE_PATH)
}

export function getLegacyGlobalStatePath(): string {
  return join(getCodexHomeDir(), LEGACY_GLOBAL_STATE_FILENAME)
}

export function getLegacyUserStorePath(): string {
  return join(getCodexHomeDir(), LEGACY_USER_STORE_RELATIVE_PATH)
}

function ensureUsersTable(database: SqliteDatabase): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      username_lower TEXT NOT NULL UNIQUE,
      role TEXT NOT NULL,
      approval_status TEXT NOT NULL DEFAULT 'approved',
      password_hash TEXT NOT NULL,
      created_at_iso TEXT NOT NULL,
      updated_at_iso TEXT NOT NULL,
      last_login_at_iso TEXT,
      approved_at_iso TEXT,
      approved_by_user_id TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS users_username_lower_idx ON users(username_lower);
  `)

  const columns = database.prepare('PRAGMA table_info(users)').all() as Array<{ name: string }>
  const columnNames = new Set(columns.map((column) => column.name))

  if (!columnNames.has('approval_status')) {
    database.exec("ALTER TABLE users ADD COLUMN approval_status TEXT NOT NULL DEFAULT 'approved'")
    database.exec("UPDATE users SET approval_status = 'approved' WHERE approval_status IS NULL OR approval_status = ''")
  }
  if (!columnNames.has('approved_at_iso')) {
    database.exec('ALTER TABLE users ADD COLUMN approved_at_iso TEXT')
  }
  if (!columnNames.has('approved_by_user_id')) {
    database.exec('ALTER TABLE users ADD COLUMN approved_by_user_id TEXT')
  }
  if (!columnNames.has('last_login_at_iso')) {
    database.exec('ALTER TABLE users ADD COLUMN last_login_at_iso TEXT')
  }
}

function ensureMetadataTable(database: SqliteDatabase): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `)
}

function ensureStateEntriesTable(database: SqliteDatabase): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS state_entries (
      scope TEXT NOT NULL,
      entry_key TEXT NOT NULL,
      json_value TEXT NOT NULL,
      updated_at_iso TEXT NOT NULL,
      PRIMARY KEY (scope, entry_key)
    );
  `)
}

function initializeDatabase(database: SqliteDatabase): void {
  database.pragma('journal_mode = WAL')
  database.pragma('foreign_keys = ON')
  ensureMetadataTable(database)
  ensureUsersTable(database)
  ensureStateEntriesTable(database)
}

export function getHubDatabase(): SqliteDatabase {
  const databasePath = getHubDatabasePath()
  const cached = databaseCache.get(databasePath)
  if (cached) {
    return cached
  }

  mkdirSync(dirname(databasePath), { recursive: true })
  const database = new Database(databasePath)
  initializeDatabase(database)
  databaseCache.set(databasePath, database)
  return database
}

export function readStateEntry<T = unknown>(scope: string, entryKey: string): T | null {
  const row = getHubDatabase()
    .prepare('SELECT json_value FROM state_entries WHERE scope = ? AND entry_key = ?')
    .get(scope, entryKey) as { json_value?: string } | undefined
  if (!row || typeof row.json_value !== 'string') {
    return null
  }

  try {
    return JSON.parse(row.json_value) as T
  } catch {
    return null
  }
}

export function writeStateEntry(scope: string, entryKey: string, value: unknown): void {
  const nowIso = new Date().toISOString()
  getHubDatabase().prepare(`
    INSERT INTO state_entries (scope, entry_key, json_value, updated_at_iso)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(scope, entry_key) DO UPDATE SET
      json_value = excluded.json_value,
      updated_at_iso = excluded.updated_at_iso
  `).run(scope, entryKey, JSON.stringify(value), nowIso)
}

export function readMetadataValue(key: string): string | undefined {
  const row = getHubDatabase()
    .prepare('SELECT value FROM metadata WHERE "key" = ?')
    .get(key) as { value?: string } | undefined
  return typeof row?.value === 'string' ? row.value : undefined
}

export function writeMetadataValue(key: string, value: string): void {
  getHubDatabase().prepare(`
    INSERT INTO metadata ("key", value)
    VALUES (?, ?)
    ON CONFLICT("key") DO UPDATE SET value = excluded.value
  `).run(key, value)
}

export function readLegacyJsonFile<T = unknown>(filePath: string): T | null {
  if (!existsSync(filePath)) {
    return null
  }

  try {
    return JSON.parse(readFileSync(filePath, 'utf8')) as T
  } catch {
    return null
  }
}

function ensureLegacyGlobalStateMigrated(): void {
  if (readMetadataValue(LEGACY_GLOBAL_STATE_MIGRATED_METADATA_KEY) === '1') {
    return
  }

  const database = getHubDatabase()
  const existing = database.prepare(`
    SELECT json_value
    FROM state_entries
    WHERE scope = ? AND entry_key = ?
    LIMIT 1
  `).get(HUB_STATE_SCOPE, HUB_GLOBAL_STATE_ENTRY_KEY) as { json_value?: string } | undefined

  if (!existing) {
    const legacyPayload = readLegacyJsonFile<Record<string, unknown>>(getLegacyGlobalStatePath()) ?? {}
    writeStateEntry(HUB_STATE_SCOPE, HUB_GLOBAL_STATE_ENTRY_KEY, legacyPayload)
  }

  writeMetadataValue(LEGACY_GLOBAL_STATE_MIGRATED_METADATA_KEY, '1')
}

export function readHubStatePayload(): Record<string, unknown> {
  ensureLegacyGlobalStateMigrated()
  return readStateEntry<Record<string, unknown>>(HUB_STATE_SCOPE, HUB_GLOBAL_STATE_ENTRY_KEY) ?? {}
}

export function writeHubStatePayload(payload: Record<string, unknown>): void {
  ensureLegacyGlobalStateMigrated()
  writeStateEntry(HUB_STATE_SCOPE, HUB_GLOBAL_STATE_ENTRY_KEY, payload)
}
