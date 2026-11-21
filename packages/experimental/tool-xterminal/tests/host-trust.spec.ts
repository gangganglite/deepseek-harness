/** Verify exact host matching and trust-file admission. */

import { chmod, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { readXTerminalHostFingerprint } from '../src/host-trust.ts'

const endpoint = { title: 'Fixture', host: 'example.test', port: 2222 }
const fingerprint = `SHA256:${'A'.repeat(43)}`
let directory: string
let trustFile: string

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'dsh-xterminal-trust-'))
  trustFile = join(directory, 'known_hosts.json')
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

it.skipIf(process.platform === 'win32')('reads only the SHA-256 fingerprint for the matching host and port', async () => {
  await writeFile(trustFile, JSON.stringify({ 'example.test:2222': { sha256: fingerprint } }), { mode: 0o600 })
  await expect(readXTerminalHostFingerprint(trustFile, endpoint)).resolves.toBe(fingerprint)
  await expect(readXTerminalHostFingerprint(trustFile, { ...endpoint, port: 22 })).resolves.toBeUndefined()
})

it.skipIf(process.platform === 'win32')('rejects invalid records, writable files, and symbolic links', async () => {
  await writeFile(trustFile, JSON.stringify({ 'example.test:2222': { sha256: 'invalid' } }), { mode: 0o600 })
  await expect(readXTerminalHostFingerprint(trustFile, endpoint)).resolves.toBeUndefined()
  await writeFile(trustFile, JSON.stringify({ 'example.test:2222': { sha256: fingerprint } }))
  const link = join(directory, 'linked-trust.json')
  await symlink(trustFile, link)
  await expect(readXTerminalHostFingerprint(link, endpoint)).resolves.toBeUndefined()
  await chmod(trustFile, 0o666)
  await expect(readXTerminalHostFingerprint(trustFile, endpoint)).resolves.toBeUndefined()
})
