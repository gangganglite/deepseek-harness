/** Verify persisted catalog discovery and first-write behavior with private SQLite fixtures. */

import { mkdtemp, realpath, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { readServerAuthentication, resolveSavedServer, searchServers } from '../src/catalog.ts'
import { createDatabasePaths } from '../src/database-path.ts'

let root: string
const signal = new AbortController().signal

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-xterminal-')))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

function database(name: string): string {
  const path = join(root, name)
  const db = new DatabaseSync(path)
  try {
    db.exec('CREATE TABLE local_store (store_key TEXT, item_id TEXT, payload TEXT, updated_at INTEGER)')
    db.prepare('INSERT INTO local_store VALUES (?, ?, ?, ?)').run(
      'fixture-GeneralDatabaseServerImp-ServerDatabaseServerImp',
      '1',
      JSON.stringify({
        title: 'Example', host: 'example.test', port: 22,
        authType: 'password', username: 'fixture-account', password: 'fixture-password', privateKey: 'fixture-key',
      }),
      1,
    )
  } finally {
    db.close()
  }
  return path
}

it('lists only the allowed fields from a read-only catalog', () => {
  const path = database('fixture.db')
  expect(searchServers(path, 'example', 0, 1)).toEqual({
    servers: [{ title: 'Example', host: 'example.test', port: 22 }],
    nextOffset: null,
  })
  expect(searchServers(path, 'fixture-password', 0, 1).servers).toEqual([])
})

it('remembers the first supplied valid path after re-creating the resolver', async () => {
  const path = database('fixture.db')
  const stored = join(root, 'profile')
  await expect(createDatabasePaths(stored, [root], root).resolve(signal, path)).resolves.toBe(path)
  const next = createDatabasePaths(stored, [root], root)
  await expect(next.resolve(signal)).resolves.toBe(path)
  await expect(next.resolve(signal, path)).rejects.toMatchObject({ code: 'XTERMINAL_ALREADY_CONFIGURED' })
})

it('rejects invalid candidates and serializes competing initializations', async () => {
  const first = database('first.db')
  const second = database('second.db')
  const paths = createDatabasePaths(join(root, 'profile'), [root], root)
  await expect(paths.resolve(signal, join(root, 'missing.db'))).rejects.toMatchObject({
    code: 'XTERMINAL_INVALID_DATABASE',
  })
  const outcomes = await Promise.allSettled([paths.resolve(signal, first), paths.resolve(signal, second)])
  expect(outcomes.filter(result => result.status === 'fulfilled')).toHaveLength(1)
  expect(outcomes).toContainEqual({
    status: 'rejected', reason: expect.objectContaining({ code: 'XTERMINAL_ALREADY_CONFIGURED' }),
  })
})

it('rejects a candidate symlink to a database outside its trusted directory', async () => {
  const outside = database('fixture.db')
  const trusted = await mkdtemp(join(root, 'trusted-'))
  const candidate = join(trusted, 'catalog.db')
  await symlink(outside, candidate)
  const paths = createDatabasePaths(join(root, 'profile'), [trusted], root)
  await expect(paths.resolve(signal, candidate)).rejects.toMatchObject({ code: 'XTERMINAL_INVALID_DATABASE' })
})

it('prefers auto-discovery before accepting a model-provided candidate', async () => {
  const discovered = database('local-store.db')
  const supplied = database('supplied.db')
  const paths = createDatabasePaths(join(root, 'profile'), [root], root)
  await expect(paths.resolve(signal, supplied)).resolves.toBe(discovered)
  await expect(paths.resolve(signal)).resolves.toBe(discovered)
})

it('reads authentication only for the approved record revision', () => {
  const path = database('fixture.db')
  const endpoint = { title: 'Example', host: 'example.test', port: 22 }
  const approved = resolveSavedServer(path, endpoint)
  expect(approved).not.toHaveProperty('username')
  expect(readServerAuthentication(path, approved)).toEqual({
    username: 'fixture-account', password: 'fixture-password',
  })
  const db = new DatabaseSync(path)
  try {
    db.exec('UPDATE local_store SET updated_at = 2')
  } finally {
    db.close()
  }
  expect(() => readServerAuthentication(path, approved)).toThrow(
    expect.objectContaining({ code: 'XTERMINAL_TARGET_CHANGED' }),
  )
})
