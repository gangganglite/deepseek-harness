/** Model-facing search for locally saved XTerminal server endpoints. */

import { isAbsolute } from 'node:path'
import type {} from '@deepseek-ai/dsh-app-boot'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool, ToolArgsError } from '@deepseek-ai/dsh-tools'
import Schema from '@deepseek-ai/schemastery'
import { searchServers } from './catalog.ts'
import { createDatabasePaths } from './database-path.ts'
import { registerRemoteTools, type RemoteConfig } from './remote-tools.ts'

/** Cordis plugin name. */
export const name = 'tool-xterminal'

/** The tool registry owns tool execution and results. */
export const inject = ['tools', 'profileContext', 'agents', 'approval', 'jobs']

/** Host settings for the local XTerminal catalog. */
export interface Config extends RemoteConfig {
  /** Extra local directories trusted to contain the XTerminal catalog. */
  allowedRoots?: string[]
}

/** Configuration accepted by Cordis Loader. */
export const Config: Schema<Config> = Schema.object({
  hostKeys: Schema.dict(Schema.string().pattern(/^SHA256:[A-Za-z0-9+/]{43}$/)),
  connectTimeoutMs: Schema.number().step(1).min(1).max(2147483647).default(15000),
  commandTimeoutMs: Schema.number().step(1).min(1).max(2147483647).default(120000),
  outputRetentionDays: Schema.number().step(1).min(0).default(30),
  allowedRoots: Schema.array(Schema.string()).description('Additional trusted XTerminal database directories.'),
})

const MAX_PAGE_SIZE = 50
const MAX_OFFSET = Number.MAX_SAFE_INTEGER - MAX_PAGE_SIZE

/**
 * Register the XTerminal catalog and remote tools.
 * @param ctx - Plugin context that owns the tool registration.
 * @param config - Host settings for the local database.
 */
export function apply(ctx: Context, config: Config): void {
  const roots = config.allowedRoots ?? []
  if (roots.some(root => !isAbsolute(root) || root.includes('\0'))) {
    throw new TypeError('tool-xterminal: allowedRoots must be absolute directory paths')
  }
  const paths = createDatabasePaths(ctx.profileContext.dir, roots)
  registerRemoteTools(ctx, config, signal => paths.resolve(signal))
  ctx.tools.register(defineTool({
    name: 'xterminal_set_database_path',
    description: 'Configure the local XTerminal database when automatic discovery could not find it.',
    parameters: {
      path: { type: 'string', required: true, description: 'Absolute path to the XTerminal SQLite database.' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute({ path }, exec) {
      await paths.resolve(exec.signal, path)
      return 'XTerminal database configured.'
    },
  }))
  ctx.tools.register(defineTool({
    name: 'xterminal_search_servers',
    description: 'Find saved XTerminal servers and return their names, hosts, and ports.',
    parameters: {
      query: {
        type: 'string',
        description: 'Literal substring of the server name or host, up to 256 characters. Omit to list servers.',
      },
      limit: {
        type: 'integer',
        description: 'Number of servers per page, from 1 to 50. Defaults to 20.',
      },
      offset: {
        type: 'integer',
        description: 'Use nextOffset from the previous result with the same query. Defaults to 0.',
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          servers: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              properties: {
                title: { type: 'string', required: true },
                host: { type: 'string', required: true },
                port: { type: 'integer', required: true },
              },
              additionalProperties: false,
            },
          },
          nextOffset: { oneOf: [{ type: 'integer' }, { type: 'null' }], required: true },
        },
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    execute: async (args, exec) => {
      exec.signal.throwIfAborted()
      const { query = '', offset = 0, limit = 20 } = args
      if (query.length > 256 || query.includes('\0')) {
        throw new ToolArgsError(['query must contain at most 256 characters and no NUL characters'])
      }
      if (limit < 1 || limit > MAX_PAGE_SIZE || offset < 0 || offset > MAX_OFFSET) {
        throw new ToolArgsError(['limit or offset is outside the supported range'])
      }
      const path = await paths.resolve(exec.signal)
      return searchServers(path, query.trim(), offset, limit)
    },
  }))
}
