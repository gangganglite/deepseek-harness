/** Structured failures reported by the XTerminal remote tools. */

import { HarnessError } from '@deepseek-ai/dsh-error'

/** Failure to authorize, locate, or select a usable SSH connection. */
export class XTerminalRemoteError extends HarnessError {}
