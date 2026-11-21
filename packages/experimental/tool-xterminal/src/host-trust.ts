/** Read host identity from the local XTerminal trust store. */

import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import type { ServerEndpoint } from './catalog.ts'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Read the saved SHA-256 fingerprint for one exact host and port.
 * @param path - Local XTerminal trust file.
 * @param endpoint - Target selected from the server catalog.
 * @returns The trusted fingerprint, or undefined when the entry cannot be trusted.
 */
export async function readXTerminalHostFingerprint(path: string, endpoint: ServerEndpoint): Promise<string | undefined> {
  try {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const stat = await file.stat()
      if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o022) !== 0) return undefined
      const records: unknown = JSON.parse(await file.readFile('utf8'))
      if (!isRecord(records)) return undefined
      const key = `${endpoint.host}:${endpoint.port}`
      if (!Object.hasOwn(records, key)) return undefined
      const entry = records[key]
      if (!isRecord(entry) || typeof entry.sha256 !== 'string') return undefined
      return /^SHA256:[A-Za-z0-9+/]{43}$/.test(entry.sha256) ? entry.sha256 : undefined
    } finally {
      await file.close()
    }
  } catch (_error) {
    return undefined
  }
}
