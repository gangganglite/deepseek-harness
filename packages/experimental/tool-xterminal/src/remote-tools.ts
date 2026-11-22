/** Task-scoped SSH connection and command tools for the local XTerminal catalog. */

import { createHash, randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { JobId, JobOutcome } from '@deepseek-ai/dsh-jobs'
import type {} from '@deepseek-ai/dsh-user-approval'
import { defineTool, ToolArgsError, ToolContextUnavailableError, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { Client } from 'ssh2'
import { catalogIdentity, readServerAuthentication, resolveSavedServer, verifyCatalogIdentity, type ServerEndpoint } from './catalog.ts'
import { captureCommand, type CommandPreview } from './command-output.ts'
import { ConnectionReferences } from './connection-reference.ts'
import { openHarnessConnection } from './harness-ssh.ts'
import { readXTerminalHostFingerprint } from './host-trust.ts'
import { pruneClosedOutputs } from './output-files.ts'
import { XTerminalRemoteError } from './remote-error.ts'
import { connectVerified } from './ssh-session.ts'

declare module '@deepseek-ai/dsh-jobs' {
  interface JobKindMap {
    'xterminal-ssh': 'xterminal-ssh'
  }
}

const connectionModes = ['plugin', 'harness'] as const
type ConnectionMode = typeof connectionModes[number]

interface Connection {
  readonly turn: number
  readonly mode: ConnectionMode
  readonly client: Client
  readonly closed: Promise<void>
  readonly cancel: AbortController
  readonly jobs: Set<Promise<JobOutcome>>
  retired: boolean
}

interface PendingConnection {
  readonly turn: number
  readonly mode: ConnectionMode
  readonly cancel: AbortController
  readonly ready: Promise<Connection>
}

/** Local trusted keys and deadlines for the remote tools. */
export interface RemoteConfig {
  /** Host:port fingerprint overrides for the local XTerminal trust store. */
  hostKeys?: Record<string, string>
  /** Maximum SSH handshake duration in milliseconds. */
  connectTimeoutMs?: number
  /** Maximum remote command duration after approval in milliseconds. */
  commandTimeoutMs?: number
  /** Days to retain closed command output files, or zero to disable cleanup. */
  outputRetentionDays?: number
}

const targetParameters = {
  title: { type: 'string', required: true, description: 'Exact saved server name.' },
  host: { type: 'string', required: true, description: 'Exact saved server host.' },
  port: { type: 'integer', required: true, description: 'Exact saved server port.' },
} as const

const output = {
  schema: { type: 'string' as const },
  render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }],
}

function keyOf(target: ServerEndpoint): string {
  return JSON.stringify([target.title, target.host, target.port])
}

function requireMode(current: ConnectionMode, requested: ConnectionMode): void {
  if (current !== requested) {
    throw new XTerminalRemoteError(
      `This target already has a ${current}-mode connection or connection attempt. Use that mode or start a new task.`,
      'XTERMINAL_CONNECTION_MODE_CONFLICT',
    )
  }
}

async function approve(ctx: Context, agent: Agent, exec: ToolRunContext, reason: string, signal: AbortSignal): Promise<void> {
  const outcome = await ctx.approval.request({
    agent, callId: exec.callId, toolName: exec.name, reason, signal,
  })
  signal.throwIfAborted()
  if (outcome !== 'allowed-once') {
    throw new XTerminalRemoteError('The SSH operation was not approved.', 'XTERMINAL_APPROVAL_REQUIRED')
  }
}

function requireTask(ctx: Context, exec: ToolRunContext): { agent: Agent; turn: number } {
  const { agent } = exec
  if (agent === undefined || ctx.agents.get(agent.id) !== agent) {
    throw new ToolContextUnavailableError('XTerminal remote tools require a live agent.')
  }
  const turn = ctx.agents.turnBoundaryOf(agent.session)
  if (turn.openTurnStartSeq === null) {
    throw new ToolContextUnavailableError('XTerminal remote tools require an active task.')
  }
  return { agent, turn: turn.lastTurn }
}

/**
 * Register approval-gated SSH tools and their connection cleanup.
 * @param ctx - Plugin context and tool owner.
 * @param config - Trusted host keys and operation deadlines.
 * @param database - Profile database resolver.
 */
export function registerRemoteTools(
  ctx: Context,
  config: RemoteConfig,
  database: (signal: AbortSignal) => Promise<string>,
): void {
  const connectTimeout = config.connectTimeoutMs ?? 15_000
  const commandTimeout = config.commandTimeoutMs ?? 120_000
  const keys = new Map(Object.entries(config.hostKeys ?? {}))
  const trustFile = join(homedir(), 'Library', 'Application Support', 'xterminal', 'ssh', 'known_hosts.json')
  const connections = new Map<Agent, Map<string, Connection>>()
  const retired = new Map<Agent, Set<Connection>>()
  const connecting = new Map<Agent, Map<string, PendingConnection>>()
  const agentCleanups = new Map<Agent, () => Promise<void> | void>()
  const references = new ConnectionReferences()
  const shutdown = new AbortController()
  const outputRoot = join(ctx.profileContext.dir, 'tool-xterminal', 'output')
  const retentionDays = config.outputRetentionDays ?? 30
  const sweep = retentionDays === 0 ? undefined : pruneClosedOutputs(outputRoot, Date.now() - retentionDays * 86_400_000)
    .catch(() => { ctx.logger.warn('Could not clean up expired XTerminal output files.') })

  function retire(agent: Agent, connection: Connection, force: boolean): void {
    connection.retired = true
    if (force) connection.cancel.abort()
    if (connection.jobs.size === 0) connection.client.destroy()
    let owned = retired.get(agent)
    if (owned === undefined) {
      owned = new Set()
      retired.set(agent, owned)
    }
    owned.add(connection)
    void Promise.allSettled([connection.closed, ...connection.jobs]).then(() => {
      owned.delete(connection)
      if (owned.size === 0) retired.delete(agent)
    })
  }

  async function closeAgentConnections(agent: Agent): Promise<void> {
    const pending = [...connecting.get(agent)?.values() ?? []]
    for (const attempt of pending) attempt.cancel.abort()
    const active = connections.get(agent)
    connections.delete(agent)
    for (const connection of active?.values() ?? []) retire(agent, connection, true)
    const closing = [...retired.get(agent) ?? []]
    for (const connection of closing) connection.cancel.abort()
    await Promise.allSettled([
      ...pending.map(attempt => attempt.ready),
      ...closing.flatMap(connection => [connection.closed, ...connection.jobs]),
    ])
  }

  function trackAgent(agent: Agent): void {
    if (agentCleanups.has(agent)) return
    let closing: Promise<void> | undefined
    const detach = agent.ctx.effect(() => () => {
      closing ??= closeAgentConnections(agent).finally(() => { agentCleanups.delete(agent) })
      return closing
    }, 'tool-xterminal.closeAgentConnections()')
    agentCleanups.set(agent, () => {
      const detached = detach()
      return closing ?? detached
    })
  }

  ctx.on('session/event', (session, event) => {
    if (event.type !== 'turn/end') return
    for (const [agent, attempts] of connecting) {
      if (agent.session !== session) continue
      for (const attempt of attempts.values()) {
        if (attempt.turn === event.data.turn) attempt.cancel.abort()
      }
    }
    for (const [agent, byTarget] of connections) {
      if (agent.session !== session) continue
      for (const [key, connection] of byTarget) {
        if (connection.turn !== event.data.turn) continue
        byTarget.delete(key)
        retire(agent, connection, event.data.reason.kind !== 'completed')
      }
      if (byTarget.size === 0) connections.delete(agent)
    }
  })
  ctx.effect(() => async () => {
    shutdown.abort()
    await Promise.allSettled([sweep, ...[...agentCleanups.values()].map(close => close())])
  }, 'tool-xterminal.shutdown()')

  ctx.tools.register(defineTool({
    name: 'xterminal_connect',
    description: 'Request approval to connect to a saved XTerminal target for use with xterminal_run in the current task.',
    parameters: {
      ...targetParameters,
      mode: {
        type: 'string', enum: connectionModes,
        description: 'Defaults to plugin. Set harness when the task requires Harness to initiate the connection.',
      },
    },
    output,
    isConcurrencySafe: () => true,
    async execute({ title, host, port, mode = 'plugin' }, exec) {
      const { agent, turn } = requireTask(ctx, exec)
      const signal = AbortSignal.any([exec.signal, shutdown.signal])
      const endpoint = { title, host, port }
      const path = await database(signal)
      const file = await catalogIdentity(path)
      const target = resolveSavedServer(path, endpoint)
      const hostKey = keys.get(`${target.host}:${target.port}`) ?? (process.platform === 'darwin'
        ? await readXTerminalHostFingerprint(trustFile, target)
        : undefined)
      signal.throwIfAborted()
      if (hostKey === undefined) {
        throw new XTerminalRemoteError(
          'No trusted SSH host fingerprint found. Verify the host in XTerminal or configure a trusted fingerprint in Harness hostKeys.',
          'XTERMINAL_HOST_KEY_REQUIRED',
        )
      }
      await approve(ctx, agent, exec, `Connect to ${JSON.stringify(target.title)} (${target.host}:${target.port}).`, signal)
      if (requireTask(ctx, exec).turn !== turn) {
        throw new XTerminalRemoteError('The task is no longer active.', 'XTERMINAL_TASK_ENDED')
      }
      const key = keyOf(endpoint)
      const ready = connections.get(agent)?.get(key)
      if (ready?.turn === turn) {
        requireMode(ready.mode, mode)
        return 'SSH connection ready.'
      }
      const attemptKey = JSON.stringify([turn, key])
      trackAgent(agent)
      let pending = connecting.get(agent)
      if (pending === undefined) {
        pending = new Map()
        connecting.set(agent, pending)
      }
      const active = pending.get(attemptKey)
      if (active !== undefined) {
        requireMode(active.mode, mode)
        const connection = await active.ready
        signal.throwIfAborted()
        if (connections.get(agent)?.get(key) !== connection) {
          throw new XTerminalRemoteError('The SSH connection is unavailable.', 'XTERMINAL_CONNECTION_UNAVAILABLE')
        }
        return 'SSH connection ready.'
      }
      const cancelAttempt = new AbortController()
      const attemptSignal = AbortSignal.any([signal, cancelAttempt.signal])
      const selection = { path, file, target }
      const call = { agent, session: agent.session, turn, callId: exec.callId, token: exec.token }

      const connect = async (): Promise<Client> => {
        if (mode === 'harness') {
          const reference = references.issue(call, selection, hostKey, connectTimeout, attemptSignal)
          try {
            return await openHarnessConnection(references, reference, call, endpoint)
          } finally {
            references.revoke(reference)
          }
        }
        await verifyCatalogIdentity(selection)
        attemptSignal.throwIfAborted()
        return connectVerified(target, readServerAuthentication(path, target), hostKey, connectTimeout, attemptSignal)
      }

      const attempt = (async () => {
        const client = await connect()
        const cancel = new AbortController()
        let resolveClose: () => void = () => undefined
        const closed = new Promise<void>((resolve) => { resolveClose = resolve })
        const connection: Connection = { turn, mode, client, cancel, closed, jobs: new Set(), retired: false }
        client.on('error', () => client.destroy())
        client.once('close', () => {
          const byTarget = connections.get(agent)
          if (byTarget?.get(key) === connection) {
            byTarget.delete(key)
            if (byTarget.size === 0) connections.delete(agent)
            retire(agent, connection, false)
          }
          resolveClose()
        })
        try {
          attemptSignal.throwIfAborted()
          if (requireTask(ctx, exec).turn !== turn) throw new Error('Task ended')
        } catch (_error) {
          client.destroy()
          await closed
          throw new XTerminalRemoteError('The task is no longer active.', 'XTERMINAL_TASK_ENDED')
        }
        const byTarget = connections.get(agent) ?? new Map<string, Connection>()
        byTarget.set(key, connection)
        connections.set(agent, byTarget)
        return connection
      })()
      pending.set(attemptKey, { turn, mode, cancel: cancelAttempt, ready: attempt })
      try {
        await attempt
        return 'SSH connection ready.'
      } finally {
        pending.delete(attemptKey)
        if (pending.size === 0) connecting.delete(agent)
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'xterminal_run',
    description: 'Run a command on an explicit connected XTerminal target. Long output may continue writing after the preview.',
    parameters: {
      ...targetParameters,
      command: { type: 'string', required: true, description: 'Command to execute on this target.' },
    },
    output,
    isConcurrencySafe: () => true,
    async execute(input, exec) {
      if (input.command.length === 0 || input.command.includes('\0')) throw new ToolArgsError(['Provide a nonempty command.'])
      const { agent, turn } = requireTask(ctx, exec)
      const key = keyOf(input)
      const connection = connections.get(agent)?.get(key)
      if (connection?.turn !== turn) {
        throw new XTerminalRemoteError('Connect to this XTerminal target first.', 'XTERMINAL_CONNECTION_UNAVAILABLE')
      }
      const signal = AbortSignal.any([exec.signal, shutdown.signal])
      await approve(ctx, agent, exec, `Run on ${JSON.stringify(input.title)} (${input.host}:${input.port}): ${input.command}`, signal)
      const sessionFolder = createHash('sha256').update(agent.id).digest('hex')
      const root = join(outputRoot, sessionFolder)
      try {
        await mkdir(root, { recursive: true, mode: 0o700 })
      } catch (_error) {
        throw new XTerminalRemoteError('Could not create the private SSH output directory.', 'XTERMINAL_OUTPUT_UNAVAILABLE')
      }
      exec.signal.throwIfAborted()
      shutdown.signal.throwIfAborted()
      if (connections.get(agent)?.get(key) !== connection || connection.retired || requireTask(ctx, exec).turn !== turn) {
        throw new XTerminalRemoteError('The approved SSH connection is no longer available.', 'XTERMINAL_CONNECTION_UNAVAILABLE')
      }
      const path = join(root, `${randomUUID()}.txt`)
      const preview = Promise.withResolvers<CommandPreview>()
      let complete = false
      const start = ctx.jobs.start({
        kind: 'xterminal-ssh',
        owner: agent.id,
        label: `SSH command on ${input.title}`,
        toolCall: { callId: exec.callId, rootCallId: exec.rootCallId },
        output: [{ read: from => ({ text: '', nextOffset: from, lossy: false, ...(complete ? { spillPath: path } : {}) }) }],
        run(job) {
          const cancel = new AbortController()
          const signal = AbortSignal.any([cancel.signal, connection.cancel.signal, AbortSignal.timeout(commandTimeout)])
          const done = captureCommand(connection.client, input.command, path, signal, job.id, preview.resolve, () => { complete = true })
          connection.jobs.add(done)
          void done.finally(() => {
            connection.jobs.delete(done)
            if (connection.retired && connection.jobs.size === 0) connection.client.destroy()
          })
          return { cancel: () => cancel.abort(), done }
        },
      })
      const cancel = () => cancelJob(start)
      function cancelJob(job: JobId) {
        ctx.jobs.kill(job, agent.id, 'Tool call cancelled')
      }
      exec.signal.addEventListener('abort', cancel, { once: true })
      try {
        if (exec.signal.aborted) cancel()
        const result = await preview.promise
        exec.signal.throwIfAborted()
        if ('error' in result) throw result.error
        return result.text
      } finally {
        exec.signal.removeEventListener('abort', cancel)
      }
    },
  }))
}
