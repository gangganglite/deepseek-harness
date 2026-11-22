/** Record SSH command output and return a bounded preview. */

import { createWriteStream } from 'node:fs'
import { once } from 'node:events'
import { unlink } from 'node:fs/promises'
import { finished } from 'node:stream/promises'
import { StringDecoder } from 'node:string_decoder'
import { HarnessError } from '@deepseek-ai/dsh-error'
import type { JobOutcome } from '@deepseek-ai/dsh-jobs'
import type { Client, ClientChannel } from 'ssh2'
import { recordClosedOutput } from './output-files.ts'

const LIMIT = 3000

type Preview = (suffix: string) => string

class XTerminalCommandError extends HarnessError {}

/** Initial tool response from the SSH command producer. */
export type CommandPreview = { text: string } | { error: HarnessError }

/**
 * Start an approved command and own its channel through file completion.
 * @param client - Authenticated connection selected before approval.
 * @param command - Approved command text.
 * @param path - Private output file path reserved for this invocation.
 * @param signal - Job cancellation and deadline.
 * @param jobId - Job identifier for requesting final status.
 * @param publish - Offers the initial preview or a structured failure to the caller.
 * @param complete - Advertises a successfully closed output file to the job.
 * @returns Job outcome after the command and writer have settled.
 */
export async function captureCommand(
  client: Client,
  command: string,
  path: string,
  signal: AbortSignal,
  jobId: string,
  publish: (result: CommandPreview) => void,
  complete: () => void,
): Promise<JobOutcome> {
  const writer = createWriteStream(path, { flags: 'wx', mode: 0o600 })
  const drained = finished(writer).then(() => true, () => false)
  const prefix: string[] = []
  let overflow = false
  let earlyScheduled = false
  let publishedPath = false
  let stopTimer: ReturnType<typeof setTimeout> | undefined
  let channel: ClientChannel | undefined
  let exitCode: number | undefined
  const preview: Preview = (suffix) => {
    const tail = Array.from(suffix).slice(0, LIMIT)
    return prefix.slice(0, LIMIT - tail.length).join('') + tail.join('')
  }
  const fail = (message: string, code: string, status: 'failed' | 'killed' = 'failed'): JobOutcome => {
    publish({ error: new XTerminalCommandError(message, code) })
    return { status, detail: message }
  }

  const abort = () => {
    channel?.destroy()
    clearTimeout(stopTimer)
    stopTimer = setTimeout(() => client.destroy(), 1000)
    stopTimer.unref()
  }
  signal.addEventListener('abort', abort, { once: true })
  try {
    try {
      await once(writer, 'open', { signal })
    } catch (_error) {
      signal.throwIfAborted()
      throw new XTerminalCommandError('Could not open the SSH output file.', 'XTERMINAL_OUTPUT_UNAVAILABLE')
    }
    signal.throwIfAborted()
    await new Promise<void>((resolve, reject) => {
      client.exec(command, (error, stream) => {
        if (error) {
          reject(new XTerminalCommandError(
            'Could not start the SSH command. Check the connection and remote command permissions.',
            'XTERMINAL_COMMAND_START_FAILED',
          ))
        }
        else resolve(collect(stream))
      })
    })
    writer.end()
    if (!await drained) {
      return fail('Could not finish writing SSH output. The file may be incomplete.', 'XTERMINAL_OUTPUT_WRITE_FAILED')
    }
    if (signal.aborted || exitCode === undefined) {
      return fail('Command result unknown. Output may be partial.', 'XTERMINAL_COMMAND_RESULT_UNKNOWN', signal.aborted ? 'killed' : 'failed')
    }
    const exit = exitCode === 0 ? '' : `\n[Command exited with code ${exitCode}.]`
    const omitted = overflow || prefix.length + Array.from(exit).length > LIMIT
    if (omitted) {
      publishedPath = true
      complete()
    }
    publish({ text: preview(exit + (omitted ? `\n[Some output was omitted. Complete output is at ${path}.]` : '')) })
    return { status: 'completed', exitCode }
  } catch (error) {
    channel?.destroy()
    writer.end()
    await drained
    if (!signal.aborted && error instanceof XTerminalCommandError) {
      publish({ error })
      return { status: 'failed', detail: error.message }
    }
    return fail('Command result unknown. Output may be partial.', 'XTERMINAL_COMMAND_RESULT_UNKNOWN', signal.aborted ? 'killed' : 'failed')
  } finally {
    clearTimeout(stopTimer)
    signal.removeEventListener('abort', abort)
    if (publishedPath) {
      await recordClosedOutput(path).catch(() => undefined)
    } else {
      await unlink(path).catch(() => undefined)
    }
  }

  async function collect(opened: ClientChannel): Promise<void> {
    channel = opened
    if (signal.aborted) {
      opened.destroy()
      signal.throwIfAborted()
    }
    const ended = Promise.all([once(opened, 'close'), once(opened.stderr, 'end')])
    const stdout = new StringDecoder('utf8')
    const stderr = new StringDecoder('utf8')
    const send = (text: string) => {
      if (text.length === 0 || writer.writableEnded || writer.destroyed) return
      for (const point of text) {
        if (prefix.length === LIMIT) {
          overflow = true
          break
        }
        prefix.push(point)
      }
      if (!writer.write(text)) {
        opened.pause()
        opened.stderr.pause()
      }
      if (overflow && !earlyScheduled) {
        earlyScheduled = true
        writer.write('', (error) => {
          if (error || signal.aborted) return
          publishedPath = true
          publish({ text: preview(`\n[Output is still being written to ${path}. Check job ${jobId} before treating it as complete.]`) })
        })
      }
    }
    writer.on('drain', () => {
      opened.resume()
      opened.stderr.resume()
    })
    writer.once('error', () => {
      opened.resume()
      opened.stderr.resume()
      abort()
    })
    opened.on('data', (chunk: Buffer) => send(stdout.write(chunk)))
    opened.stderr.on('data', (chunk: Buffer) => send(stderr.write(chunk)))
    // The SSH parser can deliver the exit status in the same read that acknowledges exec.
    opened.once('exit', (code: unknown) => {
      if (typeof code === 'number') exitCode = code
    })
    await ended
    send(stdout.end())
    send(stderr.end())
  }
}
