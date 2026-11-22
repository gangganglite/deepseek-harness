/** Supply a synthetic catalog for a connection request with no approval. */

import { mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

/** Catalog setup requires the isolated profile's directory. */
export const inject = ['profileContext']

/** Write the selected catalog before the connection tool is called. */
export function apply(ctx) {
  const root = join(ctx.profileContext.home, 'xterminal-fixture')
  mkdirSync(root, { recursive: true })
  const path = realpathSync(root)
  const catalog = join(path, 'local-store.db')
  const db = new DatabaseSync(catalog)
  try {
    db.exec('CREATE TABLE local_store (store_key TEXT, item_id TEXT, updated_at INTEGER, payload TEXT)')
    db.prepare('INSERT INTO local_store VALUES (?, ?, ?, ?)').run(
      'GeneralDatabaseServerImp-ServerDatabaseServerImp', 'snapshot-target', 1,
      JSON.stringify({
        title: 'Snapshot SSH', host: '127.0.0.1', port: 22, authType: 'password',
        username: 'xterminal-snapshot-username', password: 'xterminal-snapshot-password',
      }),
    )
  } finally {
    db.close()
  }
  const state = join(ctx.profileContext.dir, 'tool-xterminal')
  mkdirSync(state, { recursive: true })
  writeFileSync(join(state, 'database-path.json'), JSON.stringify(catalog))
}
