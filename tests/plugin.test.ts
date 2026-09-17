import { beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'fs'
import {
  CompletionCheckCommandPlugin,
  CompletionCheckStore,
  DEFAULT_MAX_RETRIES,
  executeCommand,
  isUsageLimitError,
  parseCodeBlock,
  readDefaultCommandFromAgentsMd,
  readDefaultCommand,
} from '../src/completion-check-command.js'

describe('parseCodeBlock', () => {
  it.each([
    ['bash code block', '```bash\necho "hello"\n```', 'echo "hello"'],
    ['code block without language tag', '```\necho hello\n```', 'echo hello'],
    ['shell language tag', '```shell\n./check.sh\n```', './check.sh'],
    ['sh language tag', '```sh\n./run.sh --flag\n```', './run.sh --flag'],
    ['tilde-delimited code block', '~~~bash\necho hello\n~~~', 'echo hello'],
    ['multi-line command', '```bash\n./check.sh &&\necho done\n```', './check.sh &&\necho done'],
    [
      'code block with surrounding text',
      'Here is the check:\n```bash\n./check.sh\n```\nRun this please.',
      './check.sh',
    ],
    ['trimmed whitespace', '```bash\n  ./check.sh  \n```', './check.sh'],
    ['command with pipes', "```bash\ncat output.txt | grep -c 'PASS'\n```", "cat output.txt | grep -c 'PASS'"],
    ['plain text with no code block', 'just some plain text', null],
    ['empty string', '', null],
  ])('should parse %s', (_name, input, expected) => {
    expect(parseCodeBlock(input)).toBe(expected)
  })
})

describe('readDefaultCommandFromAgentsMd', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  it('should return null if AGENTS.md does not exist', async () => {
    mockFsFiles([['/test/dir/AGENTS.md', new Error('ENOENT')]])
    const result = await readDefaultCommandFromAgentsMd('/test/dir')
    expect(result).toBeNull()
    expect(fs.readFile).toHaveBeenCalledWith('/test/dir/AGENTS.md', 'utf-8')
  })

  it('should return null if AGENTS.md has no /completion-check-command', async () => {
    mockFsFiles([['/test/dir/AGENTS.md', '# Some instructions\n\nDo something.']])
    const result = await readDefaultCommandFromAgentsMd('/test/dir')
    expect(result).toBeNull()
  })

  it('should extract command from AGENTS.md with /completion-check-command', async () => {
    mockFsFiles([
      [
        '/test/dir/AGENTS.md',
        '# Instructions\n\nRun this after completion:\n/completion-check-command\n```bash\nnpm test\n```',
      ],
    ])
    const result = await readDefaultCommandFromAgentsMd('/test/dir')
    expect(result).toBe('npm test')
  })

  it('should return null if /completion-check-command exists but no code block', async () => {
    mockFsFiles([['/test/dir/AGENTS.md', 'Some text\n/completion-check-command\nMore text']])
    const result = await readDefaultCommandFromAgentsMd('/test/dir')
    expect(result).toBeNull()
  })
})

describe('readDefaultCommand', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  it('returns command from .agents/.completion-check-command when it exists', async () => {
    mockFsFiles([
      ['/test/dir/.agents/.completion-check-command', 'npm test\n'],
      ['/test/dir/.opencode/.completion-check-command', 'echo opencode'],
      ['/test/dir/AGENTS.md', '# AGENTS.md\n\n/completion-check-command\n```bash\nnpm run test\n```'],
    ])
    const result = await readDefaultCommand('/test/dir')
    expect(result.command).toBe('npm test')
    expect(result.source).toBe('.agents/.completion-check-command')
  })

  it('falls back to .opencode/.completion-check-command when .agents/ is missing', async () => {
    mockFsFiles([
      ['/test/dir/.agents/.completion-check-command', new Error('ENOENT')],
      ['/test/dir/.opencode/.completion-check-command', 'echo opencode'],
      ['/test/dir/AGENTS.md', new Error('ENOENT')],
    ])
    const result = await readDefaultCommand('/test/dir')
    expect(result.command).toBe('echo opencode')
    expect(result.source).toBe('.opencode/.completion-check-command')
  })

  it('falls back to AGENTS.md when both dotfiles are missing', async () => {
    mockFsFiles([
      ['/test/dir/.agents/.completion-check-command', new Error('ENOENT')],
      ['/test/dir/.opencode/.completion-check-command', new Error('ENOENT')],
      ['/test/dir/AGENTS.md', '# AGENTS.md\n\n/completion-check-command\n```bash\nnpm test\n```'],
    ])
    const result = await readDefaultCommand('/test/dir')
    expect(result.command).toBe('npm test')
    expect(result.source).toBe('AGENTS.md')
  })

  it('returns null when all three are missing', async () => {
    mockFsFiles([
      ['/test/dir/.agents/.completion-check-command', new Error('ENOENT')],
      ['/test/dir/.opencode/.completion-check-command', new Error('ENOENT')],
      ['/test/dir/AGENTS.md', new Error('ENOENT')],
    ])
    const result = await readDefaultCommand('/test/dir')
    expect(result.command).toBeNull()
    expect(result.source).toBeNull()
  })

  it('returns null when file exists but is empty/whitespace-only', async () => {
    mockFsFiles([
      ['/test/dir/.agents/.completion-check-command', '   \n\n  '],
      ['/test/dir/.opencode/.completion-check-command', new Error('ENOENT')],
      ['/test/dir/AGENTS.md', new Error('ENOENT')],
    ])
    const result = await readDefaultCommand('/test/dir')
    expect(result.command).toBeNull()
    expect(result.source).toBeNull()
  })

  it('gives .agents priority when all three exist', async () => {
    mockFsFiles([
      ['/test/dir/.agents/.completion-check-command', './agents-check.sh'],
      ['/test/dir/.opencode/.completion-check-command', './opencode-check.sh'],
      ['/test/dir/AGENTS.md', '# AGENTS.md\n\n/completion-check-command\n```bash\n./md-check.sh\n```'],
    ])
    const result = await readDefaultCommand('/test/dir')
    expect(result.command).toBe('./agents-check.sh')
    expect(result.source).toBe('.agents/.completion-check-command')
  })

  it('falls back to Claude hooks when all other sources are missing', async () => {
    const originalHome = process.env.HOME
    process.env.HOME = '/test/home'
    mockFsFiles([
      ['/test/dir/.agents/.completion-check-command', new Error('ENOENT')],
      ['/test/dir/.opencode/.completion-check-command', new Error('ENOENT')],
      ['/test/dir/AGENTS.md', new Error('ENOENT')],
      [
        '/test/home/.claude/settings.json',
        JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: './claude-check.sh' }] }] } }),
      ],
    ])
    const result = await readDefaultCommand('/test/dir')
    expect(result.command).toBe('./claude-check.sh')
    expect(result.source).toBe('~/.claude/settings.json')
    process.env.HOME = originalHome
  })

  it('supports legacy hooks.stop lowercase', async () => {
    const originalHome = process.env.HOME
    process.env.HOME = '/test/home'
    mockFsFiles([
      [
        '/test/home/.claude/settings.json',
        JSON.stringify({ hooks: { stop: [{ hooks: [{ type: 'command', command: 'test -f DONE.txt' }] }] } }),
      ],
    ])
    const result = await readDefaultCommand('/test/dir')
    expect(result.command).toBe('test -f DONE.txt')
    expect(result.source).toBe('~/.claude/settings.json')
    process.env.HOME = originalHome
  })

  it('ignores Claude hooks with empty Stop array', async () => {
    const originalHome = process.env.HOME
    process.env.HOME = '/test/home'
    mockFsFiles([['/test/home/.claude/settings.json', JSON.stringify({ hooks: { Stop: [] } })]])
    const result = await readDefaultCommand('/test/dir')
    expect(result.command).toBeNull()
    expect(result.source).toBeNull()
    process.env.HOME = originalHome
  })

  it('ignores Claude hooks with malformed JSON', async () => {
    const originalHome = process.env.HOME
    process.env.HOME = '/test/home'
    mockFsFiles([['/test/home/.claude/settings.json', '{ invalid json']])
    const result = await readDefaultCommand('/test/dir')
    expect(result.command).toBeNull()
    expect(result.source).toBeNull()
    process.env.HOME = originalHome
  })
})

describe('CompletionCheckStore', () => {
  let store: CompletionCheckStore

  beforeEach(() => {
    store = new CompletionCheckStore()
  })

  it('should store and retrieve commands', () => {
    store.set('session-1', './check.sh')
    expect(store.get('session-1')).toBe('./check.sh')
  })

  it('should store and retrieve directory', () => {
    store.set('session-1', './check.sh', '/some/dir')
    expect(store.getDirectory('session-1')).toBe('/some/dir')
  })

  it('should return undefined directory for unknown session', () => {
    expect(store.getDirectory('unknown')).toBeUndefined()
  })

  it('should return undefined for unknown session', () => {
    expect(store.get('unknown')).toBeUndefined()
  })

  it('should delete a stored command', () => {
    store.set('session-1', './check.sh')
    store.delete('session-1')
    expect(store.get('session-1')).toBeUndefined()
  })

  it('should report has() correctly', () => {
    expect(store.has('session-1')).toBe(false)
    store.set('session-1', './check.sh')
    expect(store.has('session-1')).toBe(true)
    store.delete('session-1')
    expect(store.has('session-1')).toBe(false)
  })

  it('should clear all commands', () => {
    store.set('session-1', './check1.sh')
    store.set('session-2', './check2.sh')
    store.clear()
    expect(store.has('session-1')).toBe(false)
    expect(store.has('session-2')).toBe(false)
  })

  it('should overwrite existing command for same session', () => {
    store.set('session-1', './old-check.sh')
    store.set('session-1', './new-check.sh')
    expect(store.get('session-1')).toBe('./new-check.sh')
  })

  it('should track retries starting at 0', () => {
    store.set('session-1', './check.sh')
    expect(store.getEntry('session-1')?.retries).toBe(0)
  })

  it('should increment retries', () => {
    store.set('session-1', './check.sh')
    expect(store.incrementRetries('session-1')).toBe(1)
    expect(store.incrementRetries('session-1')).toBe(2)
    expect(store.getEntry('session-1')?.retries).toBe(2)
  })

  it('should return -1 when incrementing retries for unknown session', () => {
    expect(store.incrementRetries('unknown')).toBe(-1)
  })

  it('should default maxRetries to DEFAULT_MAX_RETRIES', () => {
    expect(store.getMaxRetries()).toBe(DEFAULT_MAX_RETRIES)
  })

  it('should accept custom maxRetries', () => {
    const customStore = new CompletionCheckStore(5)
    expect(customStore.getMaxRetries()).toBe(5)
  })

  describe('retriesExhausted', () => {
    it('should not be exhausted at 0 retries', () => {
      store.set('session-1', './check.sh')
      expect(store.retriesExhausted('session-1')).toBe(false)
    })

    it('should be exhausted when retries reach maxRetries', () => {
      store.set('session-1', './check.sh')
      for (let i = 0; i < DEFAULT_MAX_RETRIES; i++) {
        store.incrementRetries('session-1')
      }
      expect(store.retriesExhausted('session-1')).toBe(true)
    })

    it('should not be exhausted just below maxRetries', () => {
      store.set('session-1', './check.sh')
      for (let i = 0; i < DEFAULT_MAX_RETRIES - 1; i++) {
        store.incrementRetries('session-1')
      }
      expect(store.retriesExhausted('session-1')).toBe(false)
    })

    it('should return false for unknown session', () => {
      expect(store.retriesExhausted('unknown')).toBe(false)
    })

    it('should respect custom maxRetries', () => {
      const customStore = new CompletionCheckStore(1)
      customStore.set('session-1', './check.sh')
      expect(customStore.retriesExhausted('session-1')).toBe(false)
      customStore.incrementRetries('session-1')
      expect(customStore.retriesExhausted('session-1')).toBe(true)
    })
  })
})

// A few real shell commands used by the integration-style plugin tests below.
// They run through the real `/bin/sh`, exactly like the plugin does in
// production, so no shell mocking is needed.
const SUCCESS_COMMAND = 'true'
const FAIL_COMMAND = 'echo some error output; echo some stderr 1>&2; exit 1'

function codeBlock(command: string): string {
  return '```bash\n' + command + '\n```'
}

function mockFsFiles(entries: Array<[string, string | Error]>) {
  const files = new Map<string, string | Error>(entries)
  return vi.spyOn(fs, 'readFile').mockImplementation(async (path) => {
    const key = String(path)
    const value = files.get(key)
    if (value instanceof Error) {
      throw value
    }
    if (value !== undefined) {
      return value
    }
    throw new Error(`ENOENT: ${key}`)
  })
}

function createMockInput(options?: Record<string, unknown>) {
  return {
    client: {
      session: {
        promptAsync: vi.fn().mockResolvedValue({ data: {} }),
        // By default there are no messages, so no usage-limit error is detected
        // and the plugin behaves normally. Individual tests override this.
        messages: vi.fn().mockResolvedValue({ data: [] }),
      },
      tui: {
        showToast: vi.fn().mockResolvedValue({ data: {} }),
      },
    },
    project: {
      id: 'test-project',
      worktree: '/test',
      vcsDir: '/test',
      time: { created: Date.now() },
    },
    // A real, existing working directory so the spawned shell can chdir into it.
    directory: process.cwd(),
    worktree: process.cwd(),
    serverUrl: new URL('http://localhost:12345'),
    experimental_workspace: { register: vi.fn() },
    ...(options || {}),
  }
}

describe('executeCommand (real execution)', () => {
  it('should run a command available in /sbin via the real PATH', async () => {
    // `sysctl` lives in /sbin (resp. /usr/sbin) and is available in every
    // terminal. This proves the command is resolved against the real PATH the
    // way a normal shell does, which is exactly what broke for `docker` before.
    const result = await executeCommand('sysctl -n kernel.ostype', process.cwd())
    expect(result.exitCode).toBe(0)
    expect(result.stdout.trim()).toBe('Linux')
    expect(result.stderr).toBe('')
  })

  it('should run a multi-word command and capture stdout', async () => {
    const result = await executeCommand('echo hello world', process.cwd())
    expect(result.exitCode).toBe(0)
    expect(result.stdout.trim()).toBe('hello world')
  })

  it('should capture a non-zero exit code together with stdout and stderr', async () => {
    const result = await executeCommand('echo out; echo err 1>&2; exit 3', process.cwd())
    expect(result.exitCode).toBe(3)
    expect(result.stdout).toContain('out')
    expect(result.stderr).toContain('err')
  })

  it('should report a non-zero exit code for an unknown command', async () => {
    const result = await executeCommand('this-command-definitely-does-not-exist-xyz', process.cwd())
    expect(result.exitCode).not.toBe(0)
  })
})

describe('isUsageLimitError', () => {
  it.each([
    ['APIError with HTTP 429', { name: 'APIError', data: { statusCode: 429, message: 'Too Many Requests' } }, true],
    [
      'APIError mentioning usage limit',
      { name: 'APIError', data: { statusCode: 400, message: 'Usage limit reached' } },
      true,
    ],
    ['error mentioning rate limit', { name: 'UnknownError', data: { message: 'You have hit the rate limit' } }, true],
    [
      'provider auth error about credit balance',
      { name: 'ProviderAuthError', data: { providerID: 'anthropic', message: 'Your credit balance is too low' } },
      true,
    ],
    [
      'error mentioning quota in the response body',
      { name: 'APIError', data: { statusCode: 403, message: 'Forbidden', responseBody: '{"error":"quota exceeded"}' } },
      true,
    ],
    [
      'error mentioning out of credits',
      { name: 'APIError', data: { statusCode: 402, message: 'Payment required: out of credits' } },
      true,
    ],
    ['unrelated API error', { name: 'APIError', data: { statusCode: 500, message: 'Internal Server Error' } }, false],
    ['aborted message', { name: 'MessageAbortedError', data: { message: 'aborted' } }, false],
    ['undefined error', undefined, false],
    ['null error', null, false],
    ['empty object', {}, false],
  ])('should detect %s', (_name, error, expected) => {
    expect(isUsageLimitError(error)).toBe(expected)
  })
})

// Builds a messages response as returned by client.session.messages, ending in
// an assistant message carrying the given error (or none).
function messagesWithAssistantError(error?: unknown) {
  return {
    data: [
      { info: { role: 'user', id: 'msg-user' }, parts: [] },
      { info: { role: 'assistant', id: 'msg-assistant', error }, parts: [] },
    ],
  }
}

describe('CompletionCheckCommandPlugin', () => {
  describe('hook registration', () => {
    it('should return hooks with command.execute.before, config, and event handlers', async () => {
      const mockInput = createMockInput()
      const hooks = await CompletionCheckCommandPlugin(mockInput as any)
      expect(hooks['command.execute.before']).toBeDefined()
      expect(hooks['event']).toBeDefined()
      expect(hooks['config']).toBeDefined()
    })
  })

  describe('config hook', () => {
    it('should register the completion-check-command in config', async () => {
      const mockInput = createMockInput()
      const hooks = await CompletionCheckCommandPlugin(mockInput as any)
      const config: any = {}
      await hooks.config!(config)
      expect(config.command).toBeDefined()
      expect(config.command['completion-check-command']).toBeDefined()
      expect(config.command['completion-check-command'].template).toContain('{{arguments}}')
      expect(config.command['completion-check-command'].description).toBeDefined()
    })

    it('should not overwrite existing command config', async () => {
      const mockInput = createMockInput()
      const hooks = await CompletionCheckCommandPlugin(mockInput as any)
      const customTemplate = 'Custom template {{arguments}}'
      const config: any = {
        command: {
          'completion-check-command': {
            template: customTemplate,
            description: 'My custom description',
          },
        },
      }
      await hooks.config!(config)
      expect(config.command['completion-check-command'].template).toBe(customTemplate)
    })
  })

  describe('command recording', () => {
    it('should record and run the command when /completion-check-command is invoked with a code block', async () => {
      const mockInput = createMockInput()
      const hooks = await CompletionCheckCommandPlugin(mockInput as any)

      const parts: any[] = []
      await hooks['command.execute.before']!(
        {
          command: 'completion-check-command',
          sessionID: 'session-123',
          arguments: codeBlock(FAIL_COMMAND),
        },
        { parts },
      )

      await hooks['event']!({
        event: {
          type: 'session.idle',
          properties: { sessionID: 'session-123' },
        },
      })

      // The recorded (failing) command ran, so the agent was re-prompted.
      expect(mockInput.client.session.promptAsync).toHaveBeenCalledTimes(1)
    })

    it('should not record command for other commands', async () => {
      const mockInput = createMockInput()
      const hooks = await CompletionCheckCommandPlugin(mockInput as any)

      const parts: any[] = []
      await hooks['command.execute.before']!(
        {
          command: 'other-command',
          sessionID: 'session-123',
          arguments: codeBlock(FAIL_COMMAND),
        },
        { parts },
      )

      await hooks['event']!({
        event: {
          type: 'session.idle',
          properties: { sessionID: 'session-123' },
        },
      })

      expect(mockInput.client.session.promptAsync).not.toHaveBeenCalled()
    })

    it('should send warning feedback when no code block is found in arguments', async () => {
      const mockInput = createMockInput()
      const hooks = await CompletionCheckCommandPlugin(mockInput as any)

      const parts: any[] = []
      await hooks['command.execute.before']!(
        {
          command: 'completion-check-command',
          sessionID: 'session-nocode',
          arguments: 'just plain text',
        },
        { parts },
      )

      expect(mockInput.client.session.promptAsync).not.toHaveBeenCalled()
      expect(mockInput.client.tui.showToast).toHaveBeenCalledTimes(1)
      const callArgs = mockInput.client.tui.showToast.mock.calls[0][0]
      expect(callArgs.body.title).toBe('Completion Check')
      expect(callArgs.body.message).toContain("couldn't find")
      expect(callArgs.body.variant).toBe('warning')
    })

    it('should send confirmation feedback when command is registered', async () => {
      const mockInput = createMockInput()
      const hooks = await CompletionCheckCommandPlugin(mockInput as any)

      const parts: any[] = []
      await hooks['command.execute.before']!(
        {
          command: 'completion-check-command',
          sessionID: 'session-123',
          arguments: codeBlock('./check.sh'),
        },
        { parts },
      )

      expect(mockInput.client.tui.showToast).toHaveBeenCalledTimes(1)
      const callArgs = mockInput.client.tui.showToast.mock.calls[0][0]
      expect(callArgs.body.title).toBe('Completion Check')
      expect(callArgs.body.message).toContain('Registered!')
      expect(callArgs.body.message).toContain('./check.sh')
      expect(callArgs.body.variant).toBe('success')
    })
  })

  describe('event handling', () => {
    it('should ignore non-idle events', async () => {
      const mockInput = createMockInput()
      const hooks = await CompletionCheckCommandPlugin(mockInput as any)

      const parts: any[] = []
      await hooks['command.execute.before']!(
        {
          command: 'completion-check-command',
          sessionID: 'session-abc',
          arguments: codeBlock(FAIL_COMMAND),
        },
        { parts },
      )

      await hooks['event']!({
        event: {
          type: 'session.status',
          properties: { sessionID: 'session-abc', status: { type: 'busy' } },
        },
      })

      expect(mockInput.client.session.promptAsync).not.toHaveBeenCalled()
    })
  })

  describe('command execution on idle', () => {
    it('should not prompt again when command succeeds', async () => {
      const mockInput = createMockInput()
      const hooks = await CompletionCheckCommandPlugin(mockInput as any)

      const parts: any[] = []
      await hooks['command.execute.before']!(
        {
          command: 'completion-check-command',
          sessionID: 'session-ok',
          arguments: codeBlock(SUCCESS_COMMAND),
        },
        { parts },
      )

      await hooks['event']!({
        event: {
          type: 'session.idle',
          properties: { sessionID: 'session-ok' },
        },
      })

      expect(mockInput.client.session.promptAsync).not.toHaveBeenCalled()
      expect(mockInput.client.tui.showToast).toHaveBeenCalledTimes(2)
    })

    it('should show success toast and log when command succeeds', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
      const mockInput = createMockInput()
      const hooks = await CompletionCheckCommandPlugin(mockInput as any)

      const parts: any[] = []
      await hooks['command.execute.before']!(
        {
          command: 'completion-check-command',
          sessionID: 'session-success',
          arguments: codeBlock(SUCCESS_COMMAND),
        },
        { parts },
      )

      await hooks['event']!({
        event: {
          type: 'session.idle',
          properties: { sessionID: 'session-success' },
        },
      })

      expect(mockInput.client.session.promptAsync).not.toHaveBeenCalled()
      expect(mockInput.client.tui.showToast).toHaveBeenCalledTimes(2)

      const successToastCall = mockInput.client.tui.showToast.mock.calls[1][0]
      expect(successToastCall.body.title).toBe('Completion Check')
      expect(successToastCall.body.message).toContain('succeeded')
      expect(successToastCall.body.variant).toBe('success')

      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('[Completion Check] Command succeeded'))

      consoleSpy.mockRestore()
    })

    it('should prompt the agent again with stdout and stderr when command fails', async () => {
      const mockInput = createMockInput()
      const hooks = await CompletionCheckCommandPlugin(mockInput as any)

      const parts: any[] = []
      await hooks['command.execute.before']!(
        {
          command: 'completion-check-command',
          sessionID: 'session-fail',
          arguments: codeBlock(FAIL_COMMAND),
        },
        { parts },
      )

      await hooks['event']!({
        event: {
          type: 'session.idle',
          properties: { sessionID: 'session-fail' },
        },
      })

      expect(mockInput.client.session.promptAsync).toHaveBeenCalledTimes(1)
      expect(mockInput.client.tui.showToast).toHaveBeenCalledTimes(1)
      const failureCall = mockInput.client.session.promptAsync.mock.calls[0][0]
      expect(failureCall.path.id).toBe('session-fail')
      expect(failureCall.body.parts[0].text).toContain('you are not yet finished:')
      expect(failureCall.body.parts[0].text).toContain('some error output')
      expect(failureCall.body.parts[0].text).toContain('some stderr')
    })

    it('should use default command from AGENTS.md when no session command is set', async () => {
      const mockInput = createMockInput()

      mockFsFiles([
        [`${process.cwd()}/AGENTS.md`, '# AGENTS.md\n\n/completion-check-command\n' + codeBlock(FAIL_COMMAND)],
      ])

      const hooks = await CompletionCheckCommandPlugin(mockInput as any)

      await hooks['event']!({
        event: {
          type: 'session.created',
          properties: {
            info: {
              id: 'session-default',
              directory: process.cwd(),
              projectID: 'test-project',
              title: 'Test Session',
              version: '1',
              time: { created: Date.now(), updated: Date.now() },
            },
          },
        },
      })

      await hooks['event']!({
        event: {
          type: 'session.idle',
          properties: { sessionID: 'session-default' },
        },
      })

      // The failing default command from AGENTS.md ran and re-prompted the agent.
      expect(mockInput.client.session.promptAsync).toHaveBeenCalledTimes(1)
      expect(fs.readFile).toHaveBeenCalledWith(process.cwd() + '/AGENTS.md', 'utf-8')

      vi.restoreAllMocks()
    })

    it('should notify user when default command is found in AGENTS.md', async () => {
      const mockInput = createMockInput()

      mockFsFiles([
        ['/test/dir/AGENTS.md', '# AGENTS.md\n\n/completion-check-command\n```bash\n./default-check.sh\n```'],
      ])

      const hooks = await CompletionCheckCommandPlugin(mockInput as any)

      await hooks['event']!({
        event: {
          type: 'session.created',
          properties: {
            info: {
              id: 'session-notify',
              directory: '/test/dir',
              projectID: 'test-project',
              title: 'Test Session',
              version: '1',
              time: { created: Date.now(), updated: Date.now() },
            },
          },
        },
      })

      expect(mockInput.client.tui.showToast).toHaveBeenCalledTimes(1)
      const callArgs = mockInput.client.tui.showToast.mock.calls[0][0]
      expect(callArgs.body.title).toBe('Completion Check')
      expect(callArgs.body.message).toContain('Found default completion check command in AGENTS.md')
      expect(callArgs.body.message).toContain('./default-check.sh')
      expect(callArgs.body.variant).toBe('info')
      expect(fs.readFile).toHaveBeenCalledWith('/test/dir/AGENTS.md', 'utf-8')

      vi.restoreAllMocks()
    })

    it('should use default command from .opencode/.completion-check-command on session.created', async () => {
      const mockInput = createMockInput()

      mockFsFiles([
        [`${process.cwd()}/.opencode/.completion-check-command`, FAIL_COMMAND],
        [`${process.cwd()}/AGENTS.md`, new Error('ENOENT')],
      ])

      const hooks = await CompletionCheckCommandPlugin(mockInput as any)

      await hooks['event']!({
        event: {
          type: 'session.created',
          properties: {
            info: {
              id: 'session-opencode-dotfile',
              directory: process.cwd(),
              projectID: 'test-project',
              title: 'Test Session',
              version: '1',
              time: { created: Date.now(), updated: Date.now() },
            },
          },
        },
      })

      await hooks['event']!({
        event: {
          type: 'session.idle',
          properties: { sessionID: 'session-opencode-dotfile' },
        },
      })

      expect(mockInput.client.session.promptAsync).toHaveBeenCalledTimes(1)
      expect(fs.readFile).toHaveBeenCalledWith(process.cwd() + '/.opencode/.completion-check-command', 'utf-8')

      vi.restoreAllMocks()
    })

    it('should use default command from .agents/.completion-check-command on session.created', async () => {
      const mockInput = createMockInput()

      mockFsFiles([
        [`${process.cwd()}/.agents/.completion-check-command`, FAIL_COMMAND],
        [`${process.cwd()}/.opencode/.completion-check-command`, new Error('ENOENT')],
        [`${process.cwd()}/AGENTS.md`, new Error('ENOENT')],
      ])

      const hooks = await CompletionCheckCommandPlugin(mockInput as any)

      await hooks['event']!({
        event: {
          type: 'session.created',
          properties: {
            info: {
              id: 'session-agents-dotfile',
              directory: process.cwd(),
              projectID: 'test-project',
              title: 'Test Session',
              version: '1',
              time: { created: Date.now(), updated: Date.now() },
            },
          },
        },
      })

      await hooks['event']!({
        event: {
          type: 'session.idle',
          properties: { sessionID: 'session-agents-dotfile' },
        },
      })

      expect(mockInput.client.session.promptAsync).toHaveBeenCalledTimes(1)
      expect(fs.readFile).toHaveBeenCalledWith(process.cwd() + '/.agents/.completion-check-command', 'utf-8')

      vi.restoreAllMocks()
    })

    it('should notify user with correct source when default command is found in .opencode/.completion-check-command', async () => {
      const mockInput = createMockInput()

      mockFsFiles([
        ['/test/dir/.opencode/.completion-check-command', './default-check.sh'],
        ['/test/dir/AGENTS.md', new Error('ENOENT')],
      ])

      const hooks = await CompletionCheckCommandPlugin(mockInput as any)

      await hooks['event']!({
        event: {
          type: 'session.created',
          properties: {
            info: {
              id: 'session-notify-opencode',
              directory: '/test/dir',
              projectID: 'test-project',
              title: 'Test Session',
              version: '1',
              time: { created: Date.now(), updated: Date.now() },
            },
          },
        },
      })

      expect(mockInput.client.tui.showToast).toHaveBeenCalledTimes(1)
      const callArgs = mockInput.client.tui.showToast.mock.calls[0][0]
      expect(callArgs.body.title).toBe('Completion Check')
      expect(callArgs.body.message).toContain(
        'Found default completion check command in .opencode/.completion-check-command',
      )
      expect(callArgs.body.message).toContain('./default-check.sh')
      expect(callArgs.body.variant).toBe('info')

      vi.restoreAllMocks()
    })

    it('should prefer session-specific command over AGENTS.md default', async () => {
      const mockInput = createMockInput()

      // AGENTS.md default would fail (and re-prompt) ...
      vi.spyOn(fs, 'readFile').mockResolvedValue('# AGENTS.md\n\n/completion-check-command\n' + codeBlock(FAIL_COMMAND))

      const hooks = await CompletionCheckCommandPlugin(mockInput as any)

      await hooks['event']!({
        event: {
          type: 'session.created',
          properties: {
            info: {
              id: 'session-override',
              directory: process.cwd(),
              projectID: 'test-project',
              title: 'Test Session',
              version: '1',
              time: { created: Date.now(), updated: Date.now() },
            },
          },
        },
      })

      // ... but the session-specific command succeeds, overriding the default.
      const parts: any[] = []
      await hooks['command.execute.before']!(
        {
          command: 'completion-check-command',
          sessionID: 'session-override',
          arguments: codeBlock(SUCCESS_COMMAND),
        },
        { parts },
      )

      await hooks['event']!({
        event: {
          type: 'session.idle',
          properties: { sessionID: 'session-override' },
        },
      })

      // Session-specific (succeeding) command was used, so no re-prompt.
      expect(mockInput.client.session.promptAsync).not.toHaveBeenCalled()

      vi.restoreAllMocks()
    })
  })

  describe('usage limit handling', () => {
    it('should skip the completion check and not re-prompt when the usage limit was reached', async () => {
      const mockInput = createMockInput()
      mockInput.client.session.messages.mockResolvedValue(
        messagesWithAssistantError({ name: 'APIError', data: { statusCode: 429, message: 'Too Many Requests' } }),
      )
      const hooks = await CompletionCheckCommandPlugin(mockInput as any)

      const parts: any[] = []
      await hooks['command.execute.before']!(
        {
          command: 'completion-check-command',
          sessionID: 'session-usage',
          arguments: codeBlock(FAIL_COMMAND),
        },
        { parts },
      )

      await hooks['event']!({
        event: {
          type: 'session.idle',
          properties: { sessionID: 'session-usage' },
        },
      })

      // The check did not run, so the agent was not re-prompted.
      expect(mockInput.client.session.promptAsync).not.toHaveBeenCalled()
      // A warning toast explains why the check was skipped.
      const toastMessages = mockInput.client.tui.showToast.mock.calls.map((c: any[]) => c[0].body.message)
      expect(toastMessages.some((m: string) => m.toLowerCase().includes('usage limit'))).toBe(true)
    })

    it('should keep the command registered and run it once the usage limit clears', async () => {
      const mockInput = createMockInput()
      mockInput.client.session.messages.mockResolvedValue(
        messagesWithAssistantError({ name: 'APIError', data: { statusCode: 429 } }),
      )
      const hooks = await CompletionCheckCommandPlugin(mockInput as any)

      const parts: any[] = []
      await hooks['command.execute.before']!(
        {
          command: 'completion-check-command',
          sessionID: 'session-usage-clear',
          arguments: codeBlock(FAIL_COMMAND),
        },
        { parts },
      )

      // First idle: usage limit reached -> skipped, no re-prompt.
      await hooks['event']!({
        event: { type: 'session.idle', properties: { sessionID: 'session-usage-clear' } },
      })
      expect(mockInput.client.session.promptAsync).not.toHaveBeenCalled()

      // Usage limit clears (no error on the last assistant message).
      mockInput.client.session.messages.mockResolvedValue(messagesWithAssistantError(undefined))

      // Second idle: the still-registered command runs and (failing) re-prompts.
      await hooks['event']!({
        event: { type: 'session.idle', properties: { sessionID: 'session-usage-clear' } },
      })
      expect(mockInput.client.session.promptAsync).toHaveBeenCalledTimes(1)
    })

    it('should still run the check when the last assistant error is unrelated to usage limits', async () => {
      const mockInput = createMockInput()
      mockInput.client.session.messages.mockResolvedValue(
        messagesWithAssistantError({ name: 'APIError', data: { statusCode: 500, message: 'Internal Server Error' } }),
      )
      const hooks = await CompletionCheckCommandPlugin(mockInput as any)

      const parts: any[] = []
      await hooks['command.execute.before']!(
        {
          command: 'completion-check-command',
          sessionID: 'session-other-error',
          arguments: codeBlock(FAIL_COMMAND),
        },
        { parts },
      )

      await hooks['event']!({
        event: { type: 'session.idle', properties: { sessionID: 'session-other-error' } },
      })

      // Unrelated error -> normal behaviour: failing command re-prompts the agent.
      expect(mockInput.client.session.promptAsync).toHaveBeenCalledTimes(1)
    })
  })

  describe('max retries', () => {
    it('should use the default max retries when no option is provided', async () => {
      const mockInput = createMockInput()
      const hooks = await CompletionCheckCommandPlugin(mockInput as any)

      const parts: any[] = []
      await hooks['command.execute.before']!(
        {
          command: 'completion-check-command',
          sessionID: 'session-retry',
          arguments: codeBlock(FAIL_COMMAND),
        },
        { parts },
      )

      for (let i = 0; i < DEFAULT_MAX_RETRIES; i++) {
        await hooks['event']!({
          event: {
            type: 'session.idle',
            properties: { sessionID: 'session-retry' },
          },
        })
      }

      expect(mockInput.client.session.promptAsync).toHaveBeenCalledTimes(DEFAULT_MAX_RETRIES)
      expect(mockInput.client.tui.showToast).toHaveBeenCalledTimes(1)
    })

    it('should stop prompting after max retries are exhausted', async () => {
      const customMaxRetries = 2
      const mockInput = createMockInput()
      const hooks = await CompletionCheckCommandPlugin(mockInput as any, {
        maxRetries: customMaxRetries,
      })

      const parts: any[] = []
      await hooks['command.execute.before']!(
        {
          command: 'completion-check-command',
          sessionID: 'session-retry2',
          arguments: codeBlock(FAIL_COMMAND),
        },
        { parts },
      )

      for (let i = 0; i < customMaxRetries + 1; i++) {
        await hooks['event']!({
          event: {
            type: 'session.idle',
            properties: { sessionID: 'session-retry2' },
          },
        })
      }

      expect(mockInput.client.session.promptAsync).toHaveBeenCalledTimes(customMaxRetries)
      expect(mockInput.client.tui.showToast).toHaveBeenCalledTimes(1)
    })

    it('should allow setting maxRetries to 0 to disable re-prompting entirely', async () => {
      const mockInput = createMockInput()
      const hooks = await CompletionCheckCommandPlugin(mockInput as any, {
        maxRetries: 0,
      })

      const parts: any[] = []
      await hooks['command.execute.before']!(
        {
          command: 'completion-check-command',
          sessionID: 'session-no-retry',
          arguments: codeBlock(FAIL_COMMAND),
        },
        { parts },
      )

      await hooks['event']!({
        event: {
          type: 'session.idle',
          properties: { sessionID: 'session-no-retry' },
        },
      })

      expect(mockInput.client.session.promptAsync).not.toHaveBeenCalled()
      expect(mockInput.client.tui.showToast).toHaveBeenCalledTimes(1)
    })

    it('should respect maxRetries=1 by allowing exactly one re-prompt', async () => {
      const mockInput = createMockInput()
      const hooks = await CompletionCheckCommandPlugin(mockInput as any, {
        maxRetries: 1,
      })

      const parts: any[] = []
      await hooks['command.execute.before']!(
        {
          command: 'completion-check-command',
          sessionID: 'session-one-retry',
          arguments: codeBlock(FAIL_COMMAND),
        },
        { parts },
      )

      await hooks['event']!({
        event: {
          type: 'session.idle',
          properties: { sessionID: 'session-one-retry' },
        },
      })

      expect(mockInput.client.session.promptAsync).toHaveBeenCalledTimes(1)
      expect(mockInput.client.tui.showToast).toHaveBeenCalledTimes(1)

      await hooks['event']!({
        event: {
          type: 'session.idle',
          properties: { sessionID: 'session-one-retry' },
        },
      })

      expect(mockInput.client.session.promptAsync).toHaveBeenCalledTimes(1)
      expect(mockInput.client.tui.showToast).toHaveBeenCalledTimes(1)
    })
  })

  describe('per-session directory isolation', () => {
    it('should load different commands for two concurrent sessions in different directories', async () => {
      const parentDir = await fs.mkdtemp('/tmp/ccc-parent-')
      const childDir = await fs.mkdtemp('/tmp/ccc-child-')
      const mockInput = createMockInput()
      mockFsFiles([
        [parentDir + '/AGENTS.md', '# AGENTS.md\n\n/completion-check-command\n' + codeBlock('echo parent-check')],
        [childDir + '/AGENTS.md', '# AGENTS.md\n\n/completion-check-command\n' + codeBlock('echo child-check')],
      ])

      const hooks = await CompletionCheckCommandPlugin(mockInput as any)

      await hooks['event']!({
        event: {
          type: 'session.created',
          properties: {
            info: {
              id: 'session-parent',
              directory: parentDir,
              projectID: 'test-project',
              title: 'Parent',
              version: '1',
              time: { created: Date.now(), updated: Date.now() },
            },
          },
        },
      })

      await hooks['event']!({
        event: {
          type: 'session.created',
          properties: {
            info: {
              id: 'session-child',
              directory: childDir,
              projectID: 'test-project',
              title: 'Child',
              version: '1',
              time: { created: Date.now(), updated: Date.now() },
            },
          },
        },
      })

      // Both sessions loaded their own command from their own AGENTS.md.
      expect(fs.readFile).toHaveBeenCalledWith(parentDir + '/AGENTS.md', 'utf-8')
      expect(fs.readFile).toHaveBeenCalledWith(childDir + '/AGENTS.md', 'utf-8')

      // Both sessions idle and run their own (succeeding) command, so no re-prompt.
      await hooks['event']!({
        event: { type: 'session.idle', properties: { sessionID: 'session-parent' } },
      })
      await hooks['event']!({
        event: { type: 'session.idle', properties: { sessionID: 'session-child' } },
      })

      expect(mockInput.client.session.promptAsync).not.toHaveBeenCalled()

      vi.restoreAllMocks()
      await fs.rm(parentDir, { recursive: true, force: true })
      await fs.rm(childDir, { recursive: true, force: true })
    })

    it('should keep parent and child sessions isolated with their own commands', async () => {
      const parentDir = await fs.mkdtemp('/tmp/ccc-parent-')
      const childDir = await fs.mkdtemp('/tmp/ccc-child-')
      const mockInput = createMockInput()
      mockFsFiles([
        [parentDir + '/AGENTS.md', '# AGENTS.md\n\n/completion-check-command\n' + codeBlock('echo parent-check')],
        [childDir + '/AGENTS.md', '# AGENTS.md\n\n/completion-check-command\n' + codeBlock('echo child-check')],
      ])

      const hooks = await CompletionCheckCommandPlugin(mockInput as any)

      await hooks['event']!({
        event: {
          type: 'session.created',
          properties: {
            info: {
              id: 'session-parent',
              directory: parentDir,
              projectID: 'test-project',
              title: 'Parent',
              version: '1',
              time: { created: Date.now(), updated: Date.now() },
            },
          },
        },
      })

      await hooks['event']!({
        event: {
          type: 'session.created',
          properties: {
            info: {
              id: 'session-child',
              directory: childDir,
              projectID: 'test-project',
              title: 'Child',
              version: '1',
              time: { created: Date.now(), updated: Date.now() },
            },
          },
        },
      })

      // Parent idles and runs its own (succeeding) command.
      await hooks['event']!({
        event: { type: 'session.idle', properties: { sessionID: 'session-parent' } },
      })

      // Child idles and runs its own (succeeding) command.
      await hooks['event']!({
        event: { type: 'session.idle', properties: { sessionID: 'session-child' } },
      })

      expect(mockInput.client.session.promptAsync).not.toHaveBeenCalled()

      vi.restoreAllMocks()
      await fs.rm(parentDir, { recursive: true, force: true })
      await fs.rm(childDir, { recursive: true, force: true })
    })

    it('should run the command in the session directory, not the global input.directory', async () => {
      const sessionDir = await fs.mkdtemp('/tmp/ccc-session-')
      // Create a marker file only in the session directory.
      await fs.writeFile(sessionDir + '/.marker', 'ok')
      const mockInput = createMockInput({ directory: '/global' })
      mockFsFiles([
        [sessionDir + '/AGENTS.md', '# AGENTS.md\n\n/completion-check-command\n' + codeBlock('test -f .marker')],
      ])

      const hooks = await CompletionCheckCommandPlugin(mockInput as any)

      await hooks['event']!({
        event: {
          type: 'session.created',
          properties: {
            info: {
              id: 'session-dir',
              directory: sessionDir,
              projectID: 'test-project',
              title: 'Test',
              version: '1',
              time: { created: Date.now(), updated: Date.now() },
            },
          },
        },
      })

      await hooks['event']!({
        event: { type: 'session.idle', properties: { sessionID: 'session-dir' } },
      })

      // `test -f .marker` succeeds only in sessionDir (where .marker exists).
      // If it ran in the global directory (/global), it would fail and
      // promptAsync would be called.
      expect(mockInput.client.session.promptAsync).not.toHaveBeenCalled()

      vi.restoreAllMocks()
      await fs.rm(sessionDir, { recursive: true, force: true })
    })

    it('should preserve the stored directory when command.execute.before overrides the command', async () => {
      const sessionDir = await fs.mkdtemp('/tmp/ccc-preserve-')
      // Create a marker file only in the session directory.
      await fs.writeFile(sessionDir + '/.marker', 'ok')
      const mockInput = createMockInput()
      mockFsFiles([
        [sessionDir + '/AGENTS.md', '# AGENTS.md\n\n/completion-check-command\n' + codeBlock('echo original-check')],
      ])

      const hooks = await CompletionCheckCommandPlugin(mockInput as any)

      // Session created: stores command from AGENTS.md + the session directory.
      await hooks['event']!({
        event: {
          type: 'session.created',
          properties: {
            info: {
              id: 'session-preserve',
              directory: sessionDir,
              projectID: 'test-project',
              title: 'Test',
              version: '1',
              time: { created: Date.now(), updated: Date.now() },
            },
          },
        },
      })

      // Override the command via command.execute.before — this must update the
      // command but preserve the stored directory (not reset it to undefined).
      const parts: any[] = []
      await hooks['command.execute.before']!(
        {
          command: 'completion-check-command',
          sessionID: 'session-preserve',
          arguments: codeBlock('test -f .marker'),
        },
        { parts },
      )

      await hooks['event']!({
        event: { type: 'session.idle', properties: { sessionID: 'session-preserve' } },
      })

      // `test -f .marker` succeeds only in sessionDir (where .marker exists).
      // If the directory were lost, the command would run in the global
      // directory (process.cwd()), fail, and promptAsync would be called.
      expect(mockInput.client.session.promptAsync).not.toHaveBeenCalled()

      vi.restoreAllMocks()
      await fs.rm(sessionDir, { recursive: true, force: true })
    })

    it('should isolate retries and promptAsync per sessionID', async () => {
      const mockInput = createMockInput()
      const hooks = await CompletionCheckCommandPlugin(mockInput as any, { maxRetries: 1 })

      const parts: any[] = []
      await hooks['command.execute.before']!(
        {
          command: 'completion-check-command',
          sessionID: 'session-a',
          arguments: codeBlock(FAIL_COMMAND),
        },
        { parts },
      )
      await hooks['command.execute.before']!(
        {
          command: 'completion-check-command',
          sessionID: 'session-b',
          arguments: codeBlock(FAIL_COMMAND),
        },
        { parts },
      )

      // Exhaust retries on session-a.
      await hooks['event']!({
        event: { type: 'session.idle', properties: { sessionID: 'session-a' } },
      })
      await hooks['event']!({
        event: { type: 'session.idle', properties: { sessionID: 'session-a' } },
      })

      // session-b is unaffected and still re-prompts.
      await hooks['event']!({
        event: { type: 'session.idle', properties: { sessionID: 'session-b' } },
      })

      expect(mockInput.client.session.promptAsync).toHaveBeenCalledTimes(2)
      const sessionACalls = mockInput.client.session.promptAsync.mock.calls.filter(
        (c: any[]) => c[0].path.id === 'session-a',
      )
      const sessionBCalls = mockInput.client.session.promptAsync.mock.calls.filter(
        (c: any[]) => c[0].path.id === 'session-b',
      )
      expect(sessionACalls).toHaveLength(1)
      expect(sessionBCalls).toHaveLength(1)
    })
  })
})
