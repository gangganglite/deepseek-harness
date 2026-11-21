/** Exercise both authentication methods and host verification against an isolated SSH listener. */

import { createHash, generateKeyPairSync } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { Server, utils } from 'ssh2'
import { expect, it } from 'vitest'
import { captureCommand, type CommandPreview } from '../src/command-output.ts'
import { connectVerified } from '../src/ssh-session.ts'

function keyPair() {
  return generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
  })
}

function publicKeyBytes(privateKey: string): Buffer {
  const parsed = utils.parseKey(privateKey)
  if (parsed instanceof Error || Array.isArray(parsed)) throw new Error('Expected one valid fixture key')
  return parsed.getPublicSSH()
}

it('authenticates a password and a private key only after verifying the host', async () => {
  const host = keyPair()
  const user = keyPair()
  const userKey = publicKeyBytes(user.privateKey)
  const fingerprint = `SHA256:${createHash('sha256').update(publicKeyBytes(host.privateKey)).digest('base64').replace(/=+$/, '')}`
  const methods: string[] = []
  const server = new Server({ hostKeys: [host.privateKey] }, (client) => {
    client.on('error', (error) => {
      if (error.message !== 'Connection lost before handshake') client.end()
    })
    client.on('authentication', (auth) => {
      methods.push(auth.method)
      if (auth.username !== 'fixture-user') return auth.reject()
      if (auth.method === 'password' && auth.password === 'fixture-password') return auth.accept()
      if (auth.method === 'publickey' && auth.key.data.equals(userKey)) {
        if (!auth.signature) return auth.accept()
        const key = utils.parseKey(user.privateKey)
        if (
          !(key instanceof Error) && !Array.isArray(key) && auth.blob !== undefined
          && key.verify(auth.blob, auth.signature, auth.hashAlgo) === true
        ) {
          return auth.accept()
        }
      }
      auth.reject(['password', 'publickey'])
    })
  })
  try {
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Expected an allocated TCP port')
    const target = { title: 'Fixture', host: '127.0.0.1', port: address.port }
    const signal = new AbortController().signal
    const password = { username: 'fixture-user', password: 'fixture-password' }
    await expect(connectVerified(target, password, 'SHA256:wrong', 2000, signal))
      .rejects.toMatchObject({ code: 'XTERMINAL_HOST_KEY_MISMATCH' })
    expect(methods).toEqual([])
    for (const auth of [password, { username: 'fixture-user', privateKey: user.privateKey }]) {
      const client = await connectVerified(target, auth, fingerprint, 2000, signal)
      const close = once(client, 'close')
      client.end()
      await close
    }
    expect(methods).toContain('password')
    expect(methods).toContain('publickey')
  } finally {
    await new Promise<void>((resolve) => { server.close(() => resolve()) })
  }
})

it('publishes a readable preview before completion and preserves the complete output', async () => {
  const host = keyPair()
  const fingerprint = `SHA256:${createHash('sha256').update(publicKeyBytes(host.privateKey)).digest('base64').replace(/=+$/, '')}`
  const before = '字😀'.repeat(1700)
  const after = '\ntail\n'
  const release = Promise.withResolvers<undefined>()
  const server = new Server({ hostKeys: [host.privateKey] }, (peer) => {
    peer.on('error', () => peer.end())
    peer.on('authentication', (auth) => {
      if (auth.method === 'password' && auth.password === 'fixture-password') auth.accept()
      else auth.reject(['password'])
    })
    peer.on('session', accept => accept().on('exec', (acceptCommand) => {
      const stream = acceptCommand()
      stream.write(before)
      void release.promise.then(() => {
        stream.stderr.write(after)
        stream.exit(0)
        stream.end()
      })
    }))
  })
  const root = await mkdtemp(join(tmpdir(), 'dsh-xterminal-output-'))
  let client: Awaited<ReturnType<typeof connectVerified>> | undefined
  try {
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Expected an allocated TCP port')
    const target = { title: 'Fixture', host: '127.0.0.1', port: address.port }
    const signal = AbortSignal.timeout(4000)
    client = await connectVerified(target, { username: 'fixture-user', password: 'fixture-password' }, fingerprint, 2000, signal)
    const preview = Promise.withResolvers<CommandPreview>()
    const path = join(root, 'output.txt')
    let complete = false
    const done = captureCommand(client, 'fixture-command', path, signal, 'fixture-job', preview.resolve, () => { complete = true })
    const result = await preview.promise
    if ('error' in result) throw result.error
    const { text } = result
    expect(Array.from(text)).toHaveLength(3000)
    expect(text).toContain(path)
    expect(text).toContain('fixture-job')
    expect(await readFile(path, 'utf8')).toBe(before)
    expect(complete).toBe(false)
    release.resolve(undefined)
    await expect(done).resolves.toEqual({ status: 'completed', exitCode: 0 })
    expect(complete).toBe(true)
    expect(await readFile(path, 'utf8')).toBe(before + after)
  } finally {
    release.resolve(undefined)
    if (client) {
      const closed = once(client, 'close')
      client.destroy()
      await closed
    }
    await new Promise<void>((resolve) => { server.close(() => resolve()) })
    await rm(root, { recursive: true, force: true })
  }
})

it('reports a rejected SSH exec as a structured failure and removes its unpublished file', async () => {
  const host = keyPair()
  const fingerprint = `SHA256:${createHash('sha256').update(publicKeyBytes(host.privateKey)).digest('base64').replace(/=+$/, '')}`
  const server = new Server({ hostKeys: [host.privateKey] }, (peer) => {
    peer.on('error', () => peer.end())
    peer.on('authentication', (auth) => {
      if (auth.method === 'password' && auth.password === 'fixture-password') auth.accept()
      else auth.reject(['password'])
    })
    peer.on('session', accept => accept().on('exec', (_acceptCommand, rejectCommand) => rejectCommand()))
  })
  const root = await mkdtemp(join(tmpdir(), 'dsh-xterminal-rejected-'))
  let client: Awaited<ReturnType<typeof connectVerified>> | undefined
  try {
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Expected an allocated TCP port')
    const target = { title: 'Fixture', host: '127.0.0.1', port: address.port }
    const signal = AbortSignal.timeout(4000)
    client = await connectVerified(target, { username: 'fixture-user', password: 'fixture-password' }, fingerprint, 2000, signal)
    const preview = Promise.withResolvers<CommandPreview>()
    let complete = false
    const done = captureCommand(client, 'fixture-command', join(root, 'output.txt'), signal, 'fixture-job', preview.resolve, () => { complete = true })
    await expect(preview.promise).resolves.toEqual({
      error: expect.objectContaining({ name: 'XTerminalCommandError', code: 'XTERMINAL_COMMAND_START_FAILED' }),
    })
    await expect(done).resolves.toMatchObject({ status: 'failed' })
    expect(complete).toBe(false)
    expect(await readdir(root)).toEqual([])
  } finally {
    if (client) {
      const closed = once(client, 'close')
      client.destroy()
      await closed
    }
    await new Promise<void>((resolve) => { server.close(() => resolve()) })
    await rm(root, { recursive: true, force: true })
  }
})
