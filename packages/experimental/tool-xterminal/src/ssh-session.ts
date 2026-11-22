/** Establish an SSH session using local authentication and a pinned host key. */

import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { HarnessError } from '@deepseek-ai/dsh-error'
import type { Client } from 'ssh2'
import type { ServerAuthentication, ServerEndpoint } from './catalog.ts'

const require = createRequire(import.meta.url)

class XTerminalSshError extends HarnessError {}

/**
 * Establish an SSH connection after checking the server key.
 * @param endpoint - Approved target.
 * @param authentication - Credentials read locally for this target.
 * @param fingerprint - Trusted OpenSSH SHA-256 fingerprint for the endpoint.
 * @param timeoutMs - Maximum handshake duration.
 * @param signal - Cancellation signal for connection setup.
 * @returns The authenticated SSH client, owned by the caller.
 */
export async function connectVerified(
  endpoint: ServerEndpoint,
  authentication: ServerAuthentication,
  fingerprint: string,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<Client> {
  signal.throwIfAborted()
  // Use ssh2's CommonJS exports directly when the Desktop Loader mounts the bundle.
  const { Client: SshClient } = require('ssh2') as typeof import('ssh2')
  const client = new SshClient()
  return new Promise((resolve, reject) => {
    let rejectedHost = false
    let failure: unknown
    let failed = false

    const detach = () => {
      signal.removeEventListener('abort', abort)
      client.off('ready', ready)
      client.off('close', closed)
      client.off('error', errored)
    }
    const fail = (error: unknown) => {
      if (failed) return
      failed = true
      failure = error
      client.destroy()
    }
    const abort = () => fail(signal.reason)
    const ready = () => {
      if (failed) return
      detach()
      resolve(client)
    }
    const closed = () => {
      detach()
      reject(failed ? failure : new XTerminalSshError(
        'SSH disconnected during authentication.', 'XTERMINAL_SSH_DISCONNECTED',
      ))
    }
    const errored = () => {
      fail(rejectedHost
        ? new XTerminalSshError('The SSH host key did not match the trusted fingerprint.', 'XTERMINAL_HOST_KEY_MISMATCH')
        : new XTerminalSshError('SSH connection failed. Check the target and local authentication.', 'XTERMINAL_SSH_CONNECTION_FAILED'))
    }

    client.once('ready', ready)
    client.once('close', closed)
    client.on('error', errored)
    signal.addEventListener('abort', abort, { once: true })
    try {
      client.connect({
        host: endpoint.host,
        port: endpoint.port,
        ...authentication,
        readyTimeout: timeoutMs,
        agentForward: false,
        hostVerifier: (key: Buffer) => {
          const actual = `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`
          rejectedHost = actual !== fingerprint
          return !rejectedHost
        },
      })
    } catch (_error) {
      detach()
      client.destroy()
      reject(new XTerminalSshError('Could not start SSH with the saved authentication.', 'XTERMINAL_AUTH_UNAVAILABLE'))
    }
  })
}
