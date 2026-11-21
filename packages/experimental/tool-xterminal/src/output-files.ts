/** Retain closed output files independently of live job records. */

import { lstat, readdir, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const SESSION = /^[a-f0-9]{64}$/
const CLOSED = /^[a-f0-9-]{36}\.txt\.closed$/

/**
 * Mark a published file eligible for age-based cleanup after closing its writer.
 * @param path - Closed output file path.
 */
export async function recordClosedOutput(path: string): Promise<void> {
  await writeFile(`${path}.closed`, '', { mode: 0o600, flag: 'wx' })
}

/**
 * Remove expired closed outputs under the private profile directory.
 * @param root - Profile output directory owned by the plugin.
 * @param cutoff - Oldest retained completion timestamp.
 */
export async function pruneClosedOutputs(root: string, cutoff: number): Promise<void> {
  const sessions = await readdir(root, { withFileTypes: true }).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  })
  for (const session of sessions) {
    if (!session.isDirectory() || !SESSION.test(session.name)) continue
    const directory = join(root, session.name)
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!entry.isFile() || !CLOSED.test(entry.name)) continue
      const marker = join(directory, entry.name)
      try {
        if ((await lstat(marker)).mtimeMs >= cutoff) continue
        await unlink(marker.slice(0, -'.closed'.length))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      await unlink(marker).catch((error) => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      })
    }
  }
}
