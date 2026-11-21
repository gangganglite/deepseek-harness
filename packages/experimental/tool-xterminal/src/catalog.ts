/** Read the model-visible fields from the local XTerminal SQLite store. */

import { isIP } from 'node:net'
import { DatabaseSync } from 'node:sqlite'
import { HarnessError } from '@deepseek-ai/dsh-error'

const SERVER_STORE = '%GeneralDatabaseServerImp-ServerDatabaseServerImp'

const SEARCH_SERVERS = `
  WITH servers AS (
    SELECT store_key, item_id,
           CASE WHEN json_type(payload, '$.title') = 'text' THEN json_extract(payload, '$.title') END AS title,
           CASE WHEN json_type(payload, '$.host') = 'text' THEN json_extract(payload, '$.host') END AS host,
           CASE WHEN json_type(payload, '$.port') = 'integer' THEN json_extract(payload, '$.port') END AS port
    FROM local_store
    WHERE store_key LIKE ?
  )
  SELECT title, host, port
  FROM servers
  WHERE ? = '' OR instr(lower(title), lower(?)) > 0 OR instr(lower(host), lower(?)) > 0
  ORDER BY store_key, item_id
  LIMIT ? OFFSET ?
`

class XTerminalCatalogError extends HarnessError {}

function isHost(value: string): boolean {
  if (isIP(value)) return true
  if (value.length > 253 || /\s/.test(value)) return false
  return value.replace(/\.$/, '').split('.').every(label =>
    /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label),
  )
}

/**
 * Read a page of server labels and endpoints in store order.
 * @param path - Absolute path to the local store.
 * @param query - Literal substring of the title or host. Empty lists all servers.
 * @param offset - Zero-based row offset in the filtered list.
 * @param limit - Maximum number of servers to return.
 * @returns The page and the offset of the next page, if present.
 */
export function searchServers(path: string, query: string, offset: number, limit: number) {
  return readCatalog(path, (db) => {
    const rows = db.prepare(SEARCH_SERVERS).all(SERVER_STORE, query, query, query, limit + 1, offset)
    const servers = rows.slice(0, limit).map(({ title, host, port }) => {
      if (
        typeof title !== 'string' || !title.trim() || title.length > 256
        || typeof host !== 'string' || !isHost(host)
        || typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65_535
      ) {
        throw new XTerminalCatalogError(
          'A saved XTerminal server has an invalid name, host, or port.',
          'XTERMINAL_INVALID_SERVER',
        )
      }
      return { title, host, port }
    })
    return { servers, nextOffset: rows.length > limit ? offset + limit : null }
  })
}

/** Endpoint fields that can be displayed before requesting connection approval. */
export interface ServerEndpoint {
  readonly title: string
  readonly host: string
  readonly port: number
}

/** A saved endpoint and the database row version pinned by approval. */
export interface SavedServer extends ServerEndpoint {
  readonly storeKey: string
  readonly itemId: string
  readonly revision: number
}

/** Authentication input owned by the local SSH client. */
export type ServerAuthentication =
  | { readonly username: string; readonly password: string }
  | { readonly username: string; readonly privateKey: string; readonly passphrase?: string }

const MATCH_SERVER = `
  FROM local_store
  WHERE store_key LIKE ? AND json_extract(payload, '$.title') = ?
    AND json_extract(payload, '$.host') = ? AND json_extract(payload, '$.port') = ?
`

function readCatalog<T>(path: string, read: (db: DatabaseSync) => T): T {
  try {
    const db = new DatabaseSync(path, { readOnly: true })
    try {
      return read(db)
    } finally {
      db.close()
    }
  } catch (error) {
    if (error instanceof XTerminalCatalogError) throw error
    throw new XTerminalCatalogError('Could not read the XTerminal server catalog.', 'XTERMINAL_CATALOG_UNAVAILABLE')
  }
}

/**
 * Resolve exactly one catalog record for an endpoint before approval.
 * @param path - Validated local database path.
 * @param endpoint - Target selected from the public catalog.
 * @returns The selected record, without authentication fields.
 */
export function resolveSavedServer(path: string, endpoint: ServerEndpoint): SavedServer {
  return readCatalog(path, (db) => {
    const rows = db.prepare(`SELECT store_key, item_id, updated_at ${MATCH_SERVER} LIMIT 2`).all(
      SERVER_STORE, endpoint.title, endpoint.host, endpoint.port,
    )
    const row = rows[0]
    if (
      rows.length !== 1 || row === undefined || typeof row.store_key !== 'string'
      || typeof row.item_id !== 'string' || typeof row.updated_at !== 'number'
      || !isHost(endpoint.host) || endpoint.port < 1 || endpoint.port > 65_535
    ) {
      throw new XTerminalCatalogError('Select a unique saved XTerminal server.', 'XTERMINAL_TARGET_UNRESOLVED')
    }
    return { ...endpoint, storeKey: row.store_key, itemId: row.item_id, revision: row.updated_at }
  })
}

/**
 * Load authentication for the approved record version.
 * @param path - Database in which the target was resolved.
 * @param target - Previously resolved record.
 * @returns Local authentication inputs for password or private-key authentication.
 */
export function readServerAuthentication(path: string, target: SavedServer): ServerAuthentication {
  return readCatalog(path, (db) => {
    const row = db.prepare(`
      SELECT json_extract(payload, '$.username') AS username,
             json_extract(payload, '$.authType') AS kind,
             CASE WHEN json_extract(payload, '$.authType') = 'password'
                  THEN json_extract(payload, '$.password') END AS password,
             CASE WHEN json_extract(payload, '$.authType') = 'privateKey'
                  THEN json_extract(payload, '$.privateKey') END AS privateKey,
             CASE WHEN json_extract(payload, '$.authType') = 'privateKey'
                  THEN json_extract(payload, '$.passphrase') END AS passphrase
      ${MATCH_SERVER}
        AND store_key = ? AND item_id = ? AND updated_at = ?
    `).get(SERVER_STORE, target.title, target.host, target.port, target.storeKey, target.itemId, target.revision)
    if (!row) {
      throw new XTerminalCatalogError('The XTerminal record changed. Select the server again.', 'XTERMINAL_TARGET_CHANGED')
    }
    const { username, kind, password, privateKey, passphrase } = row
    if (typeof username === 'string' && username.length > 0) {
      if (kind === 'password' && typeof password === 'string' && password.length > 0) return { username, password }
      if (kind === 'privateKey' && typeof privateKey === 'string' && privateKey.length > 0) {
        return typeof passphrase === 'string' && passphrase.length > 0
          ? { username, privateKey, passphrase }
          : { username, privateKey }
      }
    }
    throw new XTerminalCatalogError('Local XTerminal authentication is unavailable.', 'XTERMINAL_AUTH_UNAVAILABLE')
  })
}
