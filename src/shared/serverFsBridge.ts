import { spawn } from 'node:child_process'
import { readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'

export const SERVER_FS_LIST_METHOD = 'codexui/fs/list'
export const SERVER_PROJECT_ROOT_SUGGESTION_METHOD = 'codexui/project-root-suggestion'
export const SERVER_COMPOSER_FILE_SEARCH_METHOD = 'codexui/composer-file-search'

export type ServerFsDirectoryEntry = {
  name: string
  path: string
}

export type ServerFsDirectoryListing = {
  currentPath: string
  homePath: string
  parentPath: string | null
  entries: ServerFsDirectoryEntry[]
}

export type ServerProjectRootSuggestion = {
  name: string
  path: string
}

export type ServerComposerFileSuggestion = {
  path: string
}

type ServerFsListParams = {
  path?: string
}

type ServerProjectRootSuggestionParams = {
  basePath?: string
}

type ServerComposerFileSearchParams = {
  cwd?: string
  query?: string
  limit?: number
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
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
  return await new Promise<string[]>((resolvePromise, reject) => {
    const proc = spawn('rg', ['--files', '--hidden', '-g', '!.git', '-g', '!node_modules'], {
      cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    proc.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
    })
    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })
    proc.on('error', reject)
    proc.on('close', (code) => {
      if (code === 0) {
        const rows = stdout
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean)
        resolvePromise(rows)
        return
      }
      const details = [stderr.trim(), stdout.trim()].filter(Boolean).join('\n')
      reject(new Error(details || 'rg --files failed'))
    })
  })
}

export function isServerFsBridgeMethod(method: string): boolean {
  return method === SERVER_FS_LIST_METHOD
    || method === SERVER_PROJECT_ROOT_SUGGESTION_METHOD
    || method === SERVER_COMPOSER_FILE_SEARCH_METHOD
}

export async function executeServerFsBridgeMethod(method: string, params: unknown): Promise<unknown> {
  if (method === SERVER_FS_LIST_METHOD) {
    return await listServerDirectories(params)
  }
  if (method === SERVER_PROJECT_ROOT_SUGGESTION_METHOD) {
    return await suggestServerProjectRoot(params)
  }
  if (method === SERVER_COMPOSER_FILE_SEARCH_METHOD) {
    return await searchServerComposerFiles(params)
  }
  throw new Error(`Unsupported server fs bridge method "${method}"`)
}

export async function listServerDirectories(params: unknown): Promise<ServerFsDirectoryListing> {
  const payload = asRecord(params) as ServerFsListParams | null
  const homePath = homedir()
  const rawPath = typeof payload?.path === 'string' ? payload.path.trim() : ''
  const currentPath = rawPath.length > 0 ? (isAbsolute(rawPath) ? rawPath : resolve(rawPath)) : homePath

  try {
    const info = await stat(currentPath)
    if (!info.isDirectory()) {
      throw new Error('Path exists but is not a directory')
    }
  } catch (error) {
    if (error instanceof Error && error.message === 'Path exists but is not a directory') {
      throw error
    }
    const code = (error as NodeJS.ErrnoException | undefined)?.code
    if (code === 'ENOENT') {
      throw new Error('Directory does not exist')
    }
    throw new Error('Failed to access directory')
  }

  try {
    const parentCandidate = dirname(currentPath)
    const entries = (await readdir(currentPath, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => ({ name: entry.name, path: join(currentPath, entry.name) }))
      .sort((left, right) => left.name.localeCompare(right.name))

    return {
      currentPath,
      homePath,
      parentPath: parentCandidate === currentPath ? null : parentCandidate,
      entries,
    }
  } catch {
    throw new Error('Failed to read directory')
  }
}

export async function suggestServerProjectRoot(params: unknown): Promise<ServerProjectRootSuggestion> {
  const payload = asRecord(params) as ServerProjectRootSuggestionParams | null
  const basePath = typeof payload?.basePath === 'string' ? payload.basePath.trim() : ''
  if (!basePath) {
    throw new Error('Missing basePath')
  }

  const normalizedBasePath = isAbsolute(basePath) ? basePath : resolve(basePath)
  try {
    const info = await stat(normalizedBasePath)
    if (!info.isDirectory()) {
      throw new Error('basePath is not a directory')
    }
  } catch (error) {
    if (error instanceof Error && error.message === 'basePath is not a directory') {
      throw error
    }
    throw new Error('basePath does not exist')
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
      return {
        name: candidateName,
        path: candidatePath,
      }
    }
  }

  throw new Error('Failed to compute project name suggestion')
}

export async function searchServerComposerFiles(params: unknown): Promise<ServerComposerFileSuggestion[]> {
  const payload = asRecord(params) as ServerComposerFileSearchParams | null
  const rawCwd = typeof payload?.cwd === 'string' ? payload.cwd.trim() : ''
  const query = typeof payload?.query === 'string' ? payload.query.trim() : ''
  const limitRaw = typeof payload?.limit === 'number' ? payload.limit : 20
  const limit = Math.max(1, Math.min(100, Math.floor(limitRaw)))
  if (!rawCwd) {
    throw new Error('Missing cwd')
  }

  const cwd = isAbsolute(rawCwd) ? rawCwd : resolve(rawCwd)
  try {
    const info = await stat(cwd)
    if (!info.isDirectory()) {
      throw new Error('cwd is not a directory')
    }
  } catch (error) {
    if (error instanceof Error && error.message === 'cwd is not a directory') {
      throw error
    }
    throw new Error('cwd does not exist')
  }

  const files = await listFilesWithRipgrep(cwd)
  return files
    .map((path) => ({ path, score: scoreFileCandidate(path, query) }))
    .filter((row) => query.length === 0 || row.score < 10)
    .sort((left, right) => (left.score - right.score) || left.path.localeCompare(right.path))
    .slice(0, limit)
    .map((row) => ({ path: row.path }))
}
