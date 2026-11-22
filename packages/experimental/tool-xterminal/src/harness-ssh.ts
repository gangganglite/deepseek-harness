/** Open a task SSH connection from a process-local authentication reference. */

import type { Client } from 'ssh2'
import type { ServerEndpoint } from './catalog.ts'
import type { ConnectionCall, ConnectionReferences } from './connection-reference.ts'
import { connectVerified } from './ssh-session.ts'

/**
 * Start a Host-side handshake for the approved invocation and its target.
 * @param references - XTerminal's process-local authentication provider.
 * @param reference - Single-use reference for the approved invocation.
 * @param call - Task and tool invocation that requested the connection.
 * @param endpoint - Host and port selected for this connection.
 * @returns An authenticated client for the task's SSH connection registry.
 */
export function openHarnessConnection(
  references: ConnectionReferences,
  reference: symbol,
  call: ConnectionCall,
  endpoint: ServerEndpoint,
): Promise<Client> {
  return references.redeem(reference, call, endpoint, connectVerified)
}
