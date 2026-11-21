/** Resolve and remember the database used by one Harness profile. */

import { mkdir, readFile, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { HarnessError } from '@deepseek-ai/dsh-error'
import { searchServers } from './catalog.ts'

class DatabasePathError extends HarnessError {}

function inside(root: string, file: string): boolean {
  const path = relative(root, file)
  return path !== '' && path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path)
}

async function canonicalRoot(root: string): Promise<string> {
  try {
    return await realpath(root)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    return root
  }
}

/**
 * Create a path resolver with first-write semantics.
 * @param profileDir - Launcher-owned profile directory.
 * @param allowedRoots - Extra trusted local directories selected by the Host.
 * @param home - Home directory on the Harness host. Defaults to the OS home.
 * @returns The query resolver and the first-time configuration operation.
 */
export function createDatabasePaths(profileDir: string, allowedRoots: readonly string[], home = homedir()) {
  const defaultRoot = join(home, 'Library', 'Application Support', 'xterminal')
  const defaultPath = join(defaultRoot, 'sqlite', 'local-store.db')
  const roots = process.platform === 'darwin' ? [defaultRoot, ...allowedRoots] : allowedRoots
  const state = join(profileDir, 'tool-xterminal', 'database-path.json')

  async function validate(candidate: string): Promise<string> {
    if (!isAbsolute(candidate) || candidate.includes('\0')) {
      throw new DatabasePathError('Supply an absolute XTerminal database path.', 'XTERMINAL_INVALID_DATABASE')
    }
    try {
      const path = await realpath(candidate)
      const trusted = await Promise.all(roots.map(canonicalRoot))
      if (!trusted.some(root => inside(root, path)) || !(await stat(path)).isFile()) {
        throw new DatabasePathError('The database must be a file inside a trusted XTerminal directory.', 'XTERMINAL_INVALID_DATABASE')
      }
      searchServers(path, '', 0, 1)
      return path
    } catch (error) {
      if (error instanceof DatabasePathError) throw error
      throw new DatabasePathError('Could not validate the XTerminal database.', 'XTERMINAL_INVALID_DATABASE')
    }
  }

  async function discover(signal: AbortSignal): Promise<string | undefined> {
    const candidates = new Set<string>()
    if (process.platform === 'darwin') candidates.add(defaultPath)
    for (const root of roots) {
      signal.throwIfAborted()
      candidates.add(join(root, 'local-store.db'))
      candidates.add(join(root, 'sqlite', 'local-store.db'))
    }

    const found = new Set<string>()
    for (const candidate of candidates) {
      signal.throwIfAborted()
      try {
        found.add(await validate(candidate))
      } catch (error) {
        if (!(error instanceof DatabasePathError)) throw error
      }
    }
    return found.size === 1 ? found.values().next().value : undefined
  }

  async function readSaved(): Promise<string | undefined> {
    try {
      const value: unknown = JSON.parse(await readFile(state, 'utf8'))
      if (typeof value !== 'string') throw new SyntaxError('Invalid path state')
      return value
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw new DatabasePathError('Check the saved XTerminal database configuration.', 'XTERMINAL_PATH_STATE_ERROR')
    }
  }

  async function resolve(signal: AbortSignal, candidate?: string): Promise<string> {
    try {
      const saved = await readSaved()
      if (saved !== undefined && candidate === undefined) return await validate(saved)
      await mkdir(dirname(state), { recursive: true, mode: 0o700 })
      return await withFileLock(state, async () => {
        const current = await readSaved()
        if (current !== undefined) {
          if (candidate !== undefined) {
            throw new DatabasePathError('The XTerminal database path is already configured.', 'XTERMINAL_ALREADY_CONFIGURED')
          }
          return validate(current)
        }
        const discovered = await discover(signal)
        const path = discovered ?? (candidate === undefined ? undefined : await validate(candidate))
        if (path === undefined) {
          throw new DatabasePathError(
            'XTerminal is not configured. Find its local SQLite database and call xterminal_set_database_path.',
            'XTERMINAL_DATABASE_UNCONFIGURED',
          )
        }
        signal.throwIfAborted()
        await writeFileAtomic(state, JSON.stringify(path), { mode: 0o600 })
        return path
      }, { signal })
    } catch (error) {
      signal.throwIfAborted()
      if (error instanceof DatabasePathError) throw error
      throw new DatabasePathError('Could not access XTerminal path configuration.', 'XTERMINAL_PATH_STATE_ERROR')
    }
  }

  return { resolve }
}
