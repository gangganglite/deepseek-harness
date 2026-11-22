/** Issue and consume process-local authentication references for approved SSH calls. */

import type { Agent } from '@deepseek-ai/dsh-agent'
import { HarnessError } from '@deepseek-ai/dsh-error'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { readServerAuthentication, verifyCatalogIdentity } from './catalog.ts'
import type { SelectedServer, ServerAuthentication, ServerEndpoint } from './catalog.ts'

class XTerminalConnectionReferenceError extends HarnessError {}

/** Exact task and tool invocation that received connection approval. */
export interface ConnectionCall extends Pick<ToolRunContext, 'callId' | 'token'> {
  readonly agent: Agent
  readonly session: Agent['session']
  readonly turn: number
}

interface Claim {
  readonly call: ConnectionCall
  readonly selection: SelectedServer
  readonly fingerprint: string
  readonly deadline: number
  readonly signal: AbortSignal
}

function unavailable(): XTerminalConnectionReferenceError {
  return new XTerminalConnectionReferenceError(
    'The SSH connection reference is unavailable. Request a new connection for this target.',
    'XTERMINAL_CONNECTION_REFERENCE_UNAVAILABLE',
  )
}

/** Single-use references owned by one XTerminal plugin instance. */
export class ConnectionReferences {
  private readonly issued = new Map<symbol, Claim>()

  constructor(private readonly now: () => number = () => performance.now()) {}

  /**
   * Bind a new reference to the approved call without reading credentials.
   * @param call - Approved task and tool invocation.
   * @param selection - Catalog file and row that were selected for approval.
   * @param fingerprint - Trusted host key bound to the selection.
   * @param timeoutMs - Lifetime starting at issuance.
   * @param signal - Cancellation for the approved call and its task.
   * @returns A process-local, single-use reference.
   */
  issue(call: ConnectionCall, selection: SelectedServer, fingerprint: string, timeoutMs: number, signal: AbortSignal): symbol {
    signal.throwIfAborted()
    const reference = Symbol()
    this.issued.set(reference, { call, selection, fingerprint, deadline: this.now() + timeoutMs, signal })
    return reference
  }

  /**
   * Revoke an unconsumed reference when its issuing call ends.
   * @param reference - Reference issued for that call.
   */
  revoke(reference: symbol): void {
    this.issued.delete(reference)
  }

  /**
   * Consume a matching live reference before checking the catalog or authenticating.
   * @param reference - Reference issued for this invocation.
   * @param call - Task and invocation presented by the consumer.
   * @param endpoint - Exact approved target presented by the consumer.
   * @param authenticate - Host-only consumer of the selected authentication data and handshake budget.
   * @returns The result of the one permitted authentication attempt.
   */
  async redeem<T>(
    reference: symbol,
    call: ConnectionCall,
    endpoint: ServerEndpoint,
    authenticate: (
      target: ServerEndpoint, auth: ServerAuthentication, fingerprint: string, timeoutMs: number, signal: AbortSignal,
    ) => Promise<T>,
  ): Promise<T> {
    const claim = this.issued.get(reference)
    if (claim === undefined) throw unavailable()
    const { target, path } = claim.selection
    if (
      call.agent !== claim.call.agent || call.session !== claim.call.session || call.turn !== claim.call.turn
      || call.callId !== claim.call.callId || call.token !== claim.call.token
      || endpoint.title !== target.title || endpoint.host !== target.host || endpoint.port !== target.port
    ) throw unavailable()
    this.issued.delete(reference)
    if (claim.signal.aborted || this.now() >= claim.deadline) throw unavailable()
    await verifyCatalogIdentity(claim.selection)
    if (claim.signal.aborted || this.now() >= claim.deadline) throw unavailable()
    const auth = readServerAuthentication(path, target)
    const remaining = claim.deadline - this.now()
    if (claim.signal.aborted || remaining <= 0) throw unavailable()
    const { title, host, port } = target
    return authenticate({ title, host, port }, auth, claim.fingerprint, Math.ceil(remaining), claim.signal)
  }
}
