import type { Hooks, Plugin, PluginInput } from '@opencode-ai/plugin'
import type { Event } from '@opencode-ai/sdk'
import { promises as fs } from 'fs'
import { exec } from 'child_process'

export const DEFAULT_MAX_RETRIES = 10

export function parseCodeBlock(input: string): string | null {
  const codeBlockRegex = /(?:```|~~~)([a-zA-Z0-9_-]*)\n([\s\S]*?)(?:```|~~~)/
  const match = input.match(codeBlockRegex)
  if (match && match[2]) {
    return match[2].trim()
  }
  return null
}

interface SessionEntry {
  command: string
  directory: string
  retries: number
}

export class CompletionCheckStore {
  private entries = new Map<string, SessionEntry>()
  private maxRetries: number

  constructor(maxRetries = DEFAULT_MAX_RETRIES) {
    this.maxRetries = maxRetries
  }

  set(sessionID: string, command: string, directory: string = ''): void {
    this.entries.set(sessionID, { command, directory, retries: 0 })
  }

  get(sessionID: string): string | undefined {
    return this.entries.get(sessionID)?.command
  }

  getDirectory(sessionID: string): string | undefined {
    return this.entries.get(sessionID)?.directory
  }

  getEntry(sessionID: string): SessionEntry | undefined {
    return this.entries.get(sessionID)
  }

  incrementRetries(sessionID: string): number {
    const entry = this.entries.get(sessionID)
    if (!entry) {
      return -1
    }
    entry.retries++
    return entry.retries
  }

  retriesExhausted(sessionID: string): boolean {
    const entry = this.entries.get(sessionID)
    if (!entry) {
      return false
    }
    return entry.retries >= this.maxRetries
  }

  delete(sessionID: string): void {
    this.entries.delete(sessionID)
  }

  has(sessionID: string): boolean {
    return this.entries.has(sessionID)
  }

  clear(): void {
    this.entries.clear()
  }

  getMaxRetries(): number {
    return this.maxRetries
  }
}

export interface CommandResult {
  exitCode: number
  stdout: string
  stderr: string
}

/**
 * Runs the completion check command in a real system shell (`/bin/sh -c`).
 *
 * The previous implementation used opencode's built-in Bun shell via
 * `` $`${command}` ``. Bun interpolates the whole command string as a single
 * quoted argument and resolves binaries against its own restricted PATH, which
 * breaks commands such as `docker compose run ...` with errors like
 * "Bun: command not found: docker" even though `docker` is on the user's PATH.
 *
 * Using `child_process.exec` runs the command through the real `/bin/sh`, so
 * the command line is parsed normally and binaries are resolved against the
 * inherited PATH exactly like in a normal terminal (including `/sbin`,
 * `/usr/sbin`, etc.).
 */
export async function executeCommand(command: string, cwd: string): Promise<CommandResult> {
  return new Promise((resolve) => {
    exec(command, { cwd, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
      let exitCode = 0
      if (error) {
        exitCode = typeof error.code === 'number' ? error.code : 1
      }
      resolve({
        exitCode,
        stdout: stdout.toString(),
        stderr: stderr.toString(),
      })
    })
  })
}

export function buildFailureMessage(result: CommandResult): string {
  let message = 'you are not yet finished:\n'
  if (result.stdout) {
    message += `\nstdout:\n${result.stdout}`
  }
  if (result.stderr) {
    message += `\nstderr:\n${result.stderr}`
  }
  if (!result.stdout && !result.stderr) {
    message += `\nCommand exited with code ${result.exitCode}`
  }
  return message
}

/**
 * Detects whether an error attached to an assistant message means the provider's
 * usage limit was used up (rate limit, quota or credits exhausted). When that
 * happens the agent did not actually finish its task — it was cut off — so the
 * completion check must not run and the agent must not be re-prompted (which
 * would immediately hit the same limit again and burn the retry budget).
 */
export function isUsageLimitError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false
  }
  const { name, data } = error as { name?: string; data?: Record<string, unknown> }
  const statusCode = typeof data?.statusCode === 'number' ? data.statusCode : undefined

  // HTTP 429 from the provider always means rate / usage limit reached.
  if (name === 'APIError' && statusCode === 429) {
    return true
  }

  // Otherwise fall back to matching the human-readable message / response body,
  // which is how quota/credit exhaustion surfaces across providers.
  const message = typeof data?.message === 'string' ? data.message : ''
  const responseBody = typeof data?.responseBody === 'string' ? data.responseBody : ''
  const haystack = `${message} ${responseBody}`.toLowerCase()

  return /usage limit|rate limit|quota|too many requests|credit balance|out of credits|insufficient (?:credit|balance|funds|quota)/.test(
    haystack,
  )
}

/**
 * Returns true when the session's most recent assistant message ended with a
 * usage-limit error, i.e. the model ran out of usage rather than finishing.
 */
export async function sessionHitUsageLimit(client: PluginInput['client'], sessionID: string): Promise<boolean> {
  try {
    const response = await client.session.messages({ path: { id: sessionID } })
    const messages = response?.data
    if (!Array.isArray(messages)) {
      return false
    }
    for (let i = messages.length - 1; i >= 0; i--) {
      const info = messages[i]?.info
      if (info?.role === 'assistant') {
        return isUsageLimitError(info.error)
      }
    }
    return false
  } catch {
    // If we cannot determine the state, fall back to the normal behaviour.
    return false
  }
}

export async function readDefaultCommandFromAgentsMd(directory: string): Promise<string | null> {
  try {
    const content = await fs.readFile(`${directory}/AGENTS.md`, 'utf-8')
    const commandIndex = content.indexOf('/completion-check-command')
    if (commandIndex === -1) {
      return null
    }
    return parseCodeBlock(content.slice(commandIndex))
  } catch {
    return null
  }
}

async function readFileIfExists(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, 'utf-8')
  } catch {
    return null
  }
}

async function readDefaultCommandFromDotfile(filePath: string): Promise<string | null> {
  const content = await readFileIfExists(filePath)
  if (!content) {
    return null
  }
  const trimmed = content.trim()
  return trimmed || null
}

async function readDefaultCommandFromClaudeHooks(): Promise<string | null> {
  const homeDir = process.env.HOME || process.env.USERPROFILE || ''
  if (!homeDir) {
    return null
  }
  const settingsPath = `${homeDir}/.claude/settings.json`
  const content = await readFileIfExists(settingsPath)
  if (!content) {
    return null
  }
  try {
    const settings = JSON.parse(content)
    const hooksObj = settings.hooks || null
    if (!hooksObj || typeof hooksObj !== 'object') {
      return null
    }
    // Support both modern `hooks.Stop` and legacy `hooks.stop`
    const stopHooks = hooksObj.Stop || hooksObj.stop || []
    if (!Array.isArray(stopHooks) || stopHooks.length === 0) {
      return null
    }
    for (const entry of stopHooks) {
      if (entry && typeof entry === 'object' && Array.isArray(entry.hooks)) {
        for (const hook of entry.hooks) {
          if (hook && hook.type === 'command' && typeof hook.command === 'string') {
            const trimmed = hook.command.trim()
            if (trimmed) {
              return trimmed
            }
          }
        }
      }
    }
  } catch {
    // Malformed JSON — ignore
  }
  return null
}

export async function readDefaultCommand(
  directory: string,
): Promise<{ command: string | null; source: string | null }> {
  const agentsDotfile = `${directory}/.agents/.completion-check-command`
  const opencodeDotfile = `${directory}/.opencode/.completion-check-command`
  const agentsMd = `${directory}/AGENTS.md`

  let command = await readDefaultCommandFromDotfile(agentsDotfile)
  if (command) {
    return { command, source: '.agents/.completion-check-command' }
  }

  command = await readDefaultCommandFromDotfile(opencodeDotfile)
  if (command) {
    return { command, source: '.opencode/.completion-check-command' }
  }

  command = await readDefaultCommandFromAgentsMd(directory)
  if (command) {
    return { command, source: 'AGENTS.md' }
  }

  command = await readDefaultCommandFromClaudeHooks()
  if (command) {
    return { command, source: '~/.claude/settings.json' }
  }

  return { command: null, source: null }
}

export const CompletionCheckCommandPlugin: Plugin = async (input, options) => {
  const { client } = input
  const maxRetries = typeof options?.maxRetries === 'number' ? options.maxRetries : DEFAULT_MAX_RETRIES
  const store = new CompletionCheckStore(maxRetries)

  const processing = new Set<string>()

  const hooks: Hooks = {
    config: async (config) => {
      if (!config.command) {
        config.command = {}
      }
      if (!config.command['completion-check-command']) {
        config.command['completion-check-command'] = {
          template:
            'The user wants to verify task completion after you finish. Run your task, and when you are done, a completion check will automatically run to verify your work.\n\nThe completion check command is:\n{{arguments}}',
          description:
            'Register a shell command that will be executed after the agent finishes to verify task completion. Include a markdown code block with the shell command to run.',
        }
      }
    },

    'command.execute.before': async (input, output) => {
      if (input.command !== 'completion-check-command') {
        return
      }

      const command = parseCodeBlock(input.arguments)
      if (!command) {
        try {
          await client.tui.showToast({
            body: {
              title: 'Completion Check',
              message:
                "I couldn't find a code block in your message. Please include a markdown code block with the shell command to run. For example:\n\n```bash\n./check.sh\n```",
              variant: 'warning',
              duration: 10000,
            },
          })
        } catch {
          // Ignore feedback errors
        }
        return
      }

      store.set(input.sessionID, command, store.getDirectory(input.sessionID))

      try {
        await client.tui.showToast({
          body: {
            title: 'Completion Check',
            message: `Registered! When the agent finishes, this command will be run to verify completion:\n\n\`\`\`bash\n${command}\n\`\`\``,
            variant: 'success',
            duration: 10000,
          },
        })
      } catch {
        // Ignore feedback errors
      }
    },

    event: async ({ event }) => {
      // Note: the SDK exposes `parentID?: string` on `Session` (types.gen.d.ts:469),
      // but we deliberately do NOT inherit the parent's completion-check command.
      // Each session resolves its own command from its own directory via
      // readDefaultCommand(directory). This ensures a child repository checked out
      // by a subagent uses the AGENTS.md/dotfile command from its own working
      // directory, not the parent's.
      if (event.type === 'session.created') {
        const sessionID = (event as Extract<Event, { type: 'session.created' }>).properties.info.id
        const directory = (event as Extract<Event, { type: 'session.created' }>).properties.info.directory
        const { command: defaultCommand, source } = await readDefaultCommand(directory)

        if (defaultCommand && source) {
          store.set(sessionID, defaultCommand, directory)

          try {
            await client.tui.showToast({
              body: {
                title: 'Completion Check',
                message: `Found default completion check command in ${source}. It will be run automatically when the agent finishes:\n\n\`\`\`bash\n${defaultCommand}\n\`\`\``,
                variant: 'info',
                duration: 10000,
              },
            })
          } catch {
            // Ignore feedback errors
          }
        }

        return
      }

      if (event.type !== 'session.idle') {
        return
      }

      const sessionID = (event as Extract<Event, { type: 'session.idle' }>).properties.sessionID
      const command = store.get(sessionID)
      if (!command) {
        return
      }

      if (processing.has(sessionID)) {
        return
      }
      processing.add(sessionID)

      try {
        if (await sessionHitUsageLimit(client, sessionID)) {
          // The agent was cut off by the provider's usage limit rather than
          // finishing. Skip the completion check (and the re-prompt) so we don't
          // immediately hit the limit again. The command stays registered, so the
          // check still runs once the session is able to continue.
          try {
            await client.tui.showToast({
              body: {
                title: 'Completion Check',
                message: 'Skipped the completion check because the usage limit was reached.',
                variant: 'warning',
                duration: 10000,
              },
            })
          } catch {
            // Ignore feedback errors
          }
          return
        }

        const sessionDirectory = store.getDirectory(sessionID) || input.directory
        const result = await executeCommand(command, sessionDirectory)

        if (result.exitCode === 0) {
          store.delete(sessionID)

          console.log(`[Completion Check] Command succeeded. Task is complete.\nCommand: ${command}`)

          try {
            await client.tui.showToast({
              body: {
                title: 'Completion Check',
                message: `Command succeeded! Task is complete.\n\n\`\`\`bash\n${command}\n\`\`\``,
                variant: 'success',
                duration: 10000,
              },
            })
          } catch {
            // Ignore feedback errors
          }

          return
        }

        if (store.retriesExhausted(sessionID)) {
          store.delete(sessionID)
          return
        }

        store.incrementRetries(sessionID)

        const failureMessage = buildFailureMessage(result)

        await client.session.promptAsync({
          path: { id: sessionID },
          body: {
            parts: [
              {
                type: 'text',
                text: failureMessage,
              },
            ],
          },
        })
      } finally {
        processing.delete(sessionID)
      }
    },
  }

  return hooks
}

export default CompletionCheckCommandPlugin
