/** Check that only the approved live invocation can consume saved authentication. */

import { mkdtemp, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { catalogIdentity, resolveSavedServer } from '../src/catalog.ts'
import { ConnectionReferences, type ConnectionCall } from '../src/connection-reference.ts'

const endpoint = { title: 'Fixture', host: '127.0.0.1', port: 22 }
const credentials = { username: 'fixture-user', password: 'fixture-password' }
const call = {
  agent: {} as Agent,
  session: {} as Agent['session'],
  turn: 1,
  callId: 'approved-call' as ConnectionCall['callId'],
  token: Symbol() as ConnectionCall['token'],
}
const unavailable = {
  name: 'XTerminalConnectionReferenceError',
  code: 'XTERMINAL_CONNECTION_REFERENCE_UNAVAILABLE',
}

let root: string
let path: string

function writeCatalog(file: string, auth = credentials): void {
  using db = new DatabaseSync(file)
  db.exec('CREATE TABLE local_store (store_key TEXT, item_id TEXT, updated_at INTEGER, payload TEXT)')
  db.prepare('INSERT INTO local_store VALUES (?, ?, ?, ?)').run(
    'GeneralDatabaseServerImp-ServerDatabaseServerImp', 'server-1', 1,
    JSON.stringify({ ...endpoint, authType: 'password', ...auth }),
  )
}

async function issue() {
  let clock = 0
  const controller = new AbortController()
  const refs = new ConnectionReferences(() => clock)
  const selection = { path, file: await catalogIdentity(path), target: resolveSavedServer(path, endpoint) }
  const authenticate = vi.fn(async () => 'authenticated')
  return {
    refs, controller, authenticate,
    reference: refs.issue(call, selection, 'fixture-fingerprint', 100, controller.signal),
    advance: (ms: number) => { clock += ms },
  }
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-xterminal-reference-'))
  path = join(root, 'local-store.db')
  writeCatalog(path)
})

afterEach(() => rm(root, { recursive: true, force: true }))

it('binds the reference to the exact agent, session, turn, tool call and endpoint', async () => {
  const { refs, reference, authenticate, advance, controller } = await issue()
  const otherCalls = [
    { ...call, agent: {} as Agent },
    { ...call, session: {} as Agent['session'] },
    { ...call, turn: 2 },
    { ...call, callId: 'another-call' as ConnectionCall['callId'] },
    { ...call, token: Symbol() as ConnectionCall['token'] },
  ]
  for (const other of otherCalls) {
    await expect(refs.redeem(reference, other, endpoint, authenticate)).rejects.toMatchObject(unavailable)
  }
  await expect(refs.redeem(reference, call, { ...endpoint, host: 'localhost' }, authenticate)).rejects.toMatchObject(unavailable)
  expect(authenticate).not.toHaveBeenCalled()
  advance(40)
  await expect(refs.redeem(reference, { ...call }, { ...endpoint }, authenticate)).resolves.toBe('authenticated')
  expect(authenticate).toHaveBeenCalledExactlyOnceWith(endpoint, credentials, 'fixture-fingerprint', 60, controller.signal)
})

it('consumes the reference before asynchronous validation and also on authentication failure', async () => {
  const { refs, reference, authenticate } = await issue()
  const failure = new Error('Fixture authentication failed')
  authenticate.mockRejectedValueOnce(failure)
  const first = refs.redeem(reference, call, endpoint, authenticate)
  await Promise.all([
    expect(first).rejects.toBe(failure),
    expect(refs.redeem(reference, call, endpoint, authenticate)).rejects.toMatchObject(unavailable),
  ])
  await expect(refs.redeem(reference, call, endpoint, authenticate)).rejects.toMatchObject(unavailable)
  expect(authenticate).toHaveBeenCalledTimes(1)
})

it.each(['expires', 'is cancelled', 'is revoked'] as const)('rejects a reference that %s before redemption', async (reason) => {
  const { refs, reference, authenticate, advance, controller } = await issue()
  if (reason === 'expires') advance(100)
  if (reason === 'is cancelled') controller.abort()
  if (reason === 'is revoked') refs.revoke(reference)
  await expect(refs.redeem(reference, call, endpoint, authenticate)).rejects.toMatchObject(unavailable)
  expect(authenticate).not.toHaveBeenCalled()
})

it.each(['expires', 'is cancelled'] as const)('rejects a reference that %s during file validation', async (reason) => {
  using db = new DatabaseSync(path)
  db.prepare('UPDATE local_store SET payload = ?').run(JSON.stringify(endpoint))
  const { refs, reference, authenticate, advance, controller } = await issue()
  const result = refs.redeem(reference, call, endpoint, authenticate)
  if (reason === 'expires') advance(100)
  else controller.abort()
  await expect(result).rejects.toMatchObject(unavailable)
  expect(authenticate).not.toHaveBeenCalled()
})

it.each(['file', 'row'] as const)('refuses a replacement %s even when the public endpoint matches', async (kind) => {
  const { refs, reference, authenticate } = await issue()
  if (kind === 'file') {
    await rename(path, join(root, 'previous.db'))
    writeCatalog(path, { ...credentials, password: 'other-password' })
  } else {
    using db = new DatabaseSync(path)
    db.exec('UPDATE local_store SET updated_at = 2')
  }
  await expect(refs.redeem(reference, call, endpoint, authenticate)).rejects.toMatchObject({ code: 'XTERMINAL_TARGET_CHANGED' })
  expect(authenticate).not.toHaveBeenCalled()
  await expect(refs.redeem(reference, call, endpoint, authenticate)).rejects.toMatchObject(unavailable)
})
