import type { DelegationAgent, DelegationKind, DelegationStatus } from '../types'

export type ParsedDelegation = {
  agent: DelegationAgent
  kind: DelegationKind
  mode: string
  isDangerous: boolean
  summary: string
  cwd?: string
  outputFile?: string
}

export type TaskNotification = {
  taskId?: string
  toolUseId?: string
  status: DelegationStatus
  summary?: string
  outputFile?: string
}

type Token =
  | { kind: 'word'; text: string }
  | { kind: 'op'; text: string }
  | { kind: 'redirect'; op: string; target: string }
  | { kind: 'stdin'; text: string }

const CONTROL_OPS = ['&&', '||', '|&', ';;', '|', ';', '&', '\n']
const SUMMARY_LIMIT = 1200

// Inside double quotes a backslash escapes only $ ` " \ and a newline.
function isQuotedEscape(command: string, i: number): boolean {
  const next = command.charAt(i + 1)

  return command.charAt(i) === '\\' && next !== '' && '$`"\\\n'.includes(next)
}

/**
 * Splits a shell command into words, control operators, redirections and
 * stdin text (heredoc bodies, here-strings). Good enough for the commands
 * Claude writes; not a full shell grammar.
 */
export function tokenize(command: string): Token[] {
  const tokens: Token[] = []
  const pendingHeredocs: { delimiter: string; token: { kind: 'stdin'; text: string } }[] = []
  let word = ''
  let inWord = false
  let i = 0

  const pushWord = () => {
    if (inWord) {
      tokens.push({ kind: 'word', text: word })
    }
    word = ''
    inWord = false
  }

  const readWord = (): string => {
    while (command[i] === ' ' || command[i] === '\t') i++
    let out = ''
    while (i < command.length && !' \t\n;&|<>'.includes(command.charAt(i))) {
      const c = command.charAt(i)
      if (c === "'") {
        const end = command.indexOf("'", i + 1)
        const stop = end === -1 ? command.length : end
        out += command.slice(i + 1, stop)
        i = stop + 1
      } else if (c === '"') {
        i++
        while (i < command.length && command.charAt(i) !== '"') {
          if (isQuotedEscape(command, i)) i++
          out += command.charAt(i)
          i++
        }
        i++
      } else {
        out += c
        i++
      }
    }
    return out
  }

  while (i < command.length) {
    const c = command[i]

    if (c === "'") {
      const end = command.indexOf("'", i + 1)
      const stop = end === -1 ? command.length : end
      word += command.slice(i + 1, stop)
      inWord = true
      i = stop + 1
      continue
    }
    if (c === '"') {
      i++
      while (i < command.length && command.charAt(i) !== '"') {
        if (isQuotedEscape(command, i)) i++
        word += command.charAt(i)
        i++
      }
      inWord = true
      i++
      continue
    }
    if (c === '\\') {
      if (command[i + 1] !== '\n' && i + 1 < command.length) word += command[i + 1]
      inWord = true
      i += 2
      continue
    }
    if (c === '$' && command[i + 1] === '(') {
      let depth = 0
      const start = i
      while (i < command.length) {
        if (command[i] === '(') depth++
        if (command[i] === ')') {
          depth--
          if (depth === 0) {
            i++
            break
          }
        }
        i++
      }
      word += command.slice(start, i)
      inWord = true
      continue
    }
    if (c === '#' && !inWord) {
      const newline = command.indexOf('\n', i)
      i = newline === -1 ? command.length : newline
      continue
    }
    if (c === ' ' || c === '\t') {
      pushWord()
      i++
      continue
    }
    if (c === '<' || c === '>') {
      if (inWord && /^\d+$/.test(word)) {
        word = ''
        inWord = false
      }
      pushWord()
      let op = ''
      while (i < command.length && '<>&-'.includes(command.charAt(i)) && op.length < 4) {
        if (command.charAt(i) === '-' && !op.startsWith('<<')) break
        op += command.charAt(i)
        i++
      }
      if (op === '<<<') {
        tokens.push({ kind: 'stdin', text: readWord() })
      } else if (op === '<<' || op === '<<-') {
        const delimiter = readWord()
        const token = { kind: 'stdin' as const, text: '' }
        tokens.push(token)
        pendingHeredocs.push({ delimiter, token })
      } else if (op.endsWith('&') && /[\d-]/.test(command[i] ?? '')) {
        while (/[\d-]/.test(command[i] ?? '')) i++
      } else {
        tokens.push({ kind: 'redirect', op, target: readWord() })
      }
      continue
    }
    const control = CONTROL_OPS.find(one => command.startsWith(one, i))
    if (control !== undefined) {
      pushWord()
      tokens.push({ kind: 'op', text: control })
      i += control.length
      if (control === '\n') {
        for (const heredoc of pendingHeredocs.splice(0)) {
          const lines: string[] = []
          while (i < command.length) {
            const newline = command.indexOf('\n', i)
            const end = newline === -1 ? command.length : newline
            const line = command.slice(i, end)
            i = end + 1
            if (line.replace(/^\t+/, '') === heredoc.delimiter) break
            lines.push(line)
          }
          heredoc.token.text = lines.join('\n')
        }
      }
      continue
    }
    word += c
    inWord = true
    i++
  }
  pushWord()

  return tokens
}

type Segment = { words: string[]; stdin?: string; stdoutFile?: string }

function segmentsOf(tokens: Token[]): Segment[] {
  const segments: Segment[] = []
  let current: Segment = { words: [] }
  for (const token of tokens) {
    if (token.kind === 'op') {
      segments.push(current)
      current = { words: [] }
    } else if (token.kind === 'word') {
      current.words.push(token.text)
    } else if (token.kind === 'stdin') {
      current.stdin = token.text
    } else if (['>', '>>', '1>', '&>', '>|'].includes(token.op)) {
      current.stdoutFile = token.target
    }
  }
  segments.push(current)

  return segments.filter(one => one.words.length > 0)
}

const WRAPPERS = new Set(['time', 'nohup', 'command', 'builtin', 'exec', 'caffeinate', 'env', 'timeout', 'gtimeout'])
const SHELLS = new Set(['bash', 'sh', 'zsh'])

function isWrapperArgument(word: string | undefined): boolean {
  return word !== undefined && (word.startsWith('-') || word.includes('=') || /^\d+[smhd]?$/.test(word))
}

function programOf(words: readonly string[]): { program: string; args: string[] } | undefined {
  for (let i = 0; i < words.length; i++) {
    const word = words[i] ?? ''
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) continue
    const base = word.split('/').pop() ?? word
    if (WRAPPERS.has(base)) {
      while (isWrapperArgument(words[i + 1])) i++
      continue
    }

    return { program: base, args: words.slice(i + 1) }
  }

  return undefined
}

function clip(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()

  return flat.length > SUMMARY_LIMIT ? `${flat.slice(0, SUMMARY_LIMIT)}…` : flat
}

function splitOption(token: string): { name: string; value?: string } {
  const equals = token.indexOf('=')

  return equals > 0 ? { name: token.slice(0, equals), value: token.slice(equals + 1) } : { name: token }
}

const CODEX_VALUE_OPTIONS = new Set([
  '-c', '--config', '--enable', '--disable', '-i', '--image', '-m', '--model', '--local-provider',
  '-p', '--profile', '-s', '--sandbox', '-C', '--cd', '--add-dir', '-o', '--output-last-message',
  '--output-schema', '--color', '-a', '--ask-for-approval', '--base', '--commit', '--title',
  '--thread-source', '--cyber-access-program',
])

function parseCodex(args: string[], segment: Segment, cwd: string | undefined): ParsedDelegation | undefined {
  const options = new Map<string, string>()
  const configs: string[] = []
  const flags = new Set<string>()
  const positionals: string[] = []
  let sub: 'exec' | 'review' | undefined
  let subsub: string | undefined

  for (let i = 0; i < args.length; i++) {
    const token = args[i]
    if (token === undefined) continue
    if (token === '--help' || token === '-h' || token === '--version' || token === '-V') return undefined
    if (token.startsWith('-') && token.length > 1) {
      const { name, value } = splitOption(token)
      if (CODEX_VALUE_OPTIONS.has(name)) {
        const given = value ?? args[++i] ?? ''
        if (name === '-c' || name === '--config') configs.push(given)
        else options.set(name, given)
      } else {
        flags.add(name)
      }
      continue
    }
    if (sub === undefined) {
      if (token === 'exec' || token === 'e') sub = 'exec'
      else if (token === 'review') sub = 'review'
      else return undefined
    } else if (sub === 'exec' && subsub === undefined && positionals.length === 0 && ['review', 'resume', 'fork', 'help'].includes(token)) {
      if (token === 'help') return undefined
      subsub = token
    } else {
      positionals.push(token)
    }
  }
  if (sub === undefined) return undefined

  const kind: DelegationKind = sub === 'review' || subsub === 'review' ? 'review' : subsub === 'resume' || subsub === 'fork' ? 'resume' : 'exec'
  const sandboxFromConfig = configs.map(one => /^sandbox_mode\s*=\s*"?([\w-]+)"?/.exec(one)?.[1]).find(Boolean)
  const sandbox = options.get('-s') ?? options.get('--sandbox') ?? sandboxFromConfig
  const isBypass = flags.has('--dangerously-bypass-approvals-and-sandbox') || flags.has('--yolo')
  const mode = isBypass ? 'bypass' : sandbox ?? (flags.has('--full-auto') ? 'workspace-write' : 'default')

  const prompt = positionals[0] === '-' || positionals[0] === undefined ? segment.stdin : positionals[0]
  let summary: string
  if (kind === 'review') {
    const base = options.get('--base')
    const commit = options.get('--commit')
    const target = base !== undefined ? `the diff against ${base}` : commit !== undefined ? `commit ${commit}` : flags.has('--uncommitted') ? 'uncommitted changes' : 'current changes'
    summary = prompt ? `Review ${target}: ${prompt}` : `Review ${target}`
  } else if (kind === 'resume') {
    summary = prompt ? `Resume an earlier session: ${prompt}` : 'Resume an earlier session'
  } else {
    summary = prompt ?? '(instruction passed on stdin)'
  }

  return {
    agent: 'codex',
    kind,
    mode,
    isDangerous: isBypass || mode === 'danger-full-access',
    summary: clip(summary),
    cwd: options.get('-C') ?? options.get('--cd') ?? cwd,
    outputFile: options.get('-o') ?? options.get('--output-last-message') ?? segment.stdoutFile,
  }
}

const AGY_VALUE_OPTIONS = new Set([
  'add-dir', 'agent', 'conversation', 'effort', 'input-format', 'json-schema', 'log-file', 'mode',
  'model', 'output-format', 'print-timeout', 'project',
])
const AGY_PRINT = new Set(['p', 'print', 'prompt'])
const AGY_SUBCOMMANDS = new Set([
  'agent', 'agents', 'changelog', 'help', 'install', 'mcp', 'mic-serve', 'models', 'plugin', 'plugins',
  'remote-control', 'update',
])
// Slash commands agy answers itself, with no model turn (agy 1.4.0's /help list). `/model` is
// left out: it can carry a prompt to run on another model.
const AGY_LOCAL_COMMANDS = new Set([
  '/usage', '/quota', '/credits', '/help', '/changelog', '/agents', '/skills', '/config', '/settings',
  '/permissions', '/hooks', '/plugin', '/effort',
])

function parseAgy(args: string[], segment: Segment, cwd: string | undefined): ParsedDelegation | undefined {
  const options = new Map<string, string>()
  const flags = new Set<string>()
  const positionals: string[] = []
  let isPrint = false
  let prompt: string | undefined

  for (let i = 0; i < args.length; i++) {
    const token = args[i]
    if (token === undefined) continue
    if (token.startsWith('-') && token.length > 1) {
      const { name, value } = splitOption(token.replace(/^--?/, ''))
      if (['h', 'help', 'v', 'version'].includes(name)) return undefined
      if (name === 'i' || name === 'prompt-interactive') return undefined
      if (AGY_PRINT.has(name)) {
        isPrint = true
        const following = args[i + 1]
        if (value !== undefined) {
          prompt = value
        } else if (following !== undefined && !following.startsWith('-')) {
          prompt = following
          i++
        }
      } else if (AGY_VALUE_OPTIONS.has(name)) {
        options.set(name, value ?? args[++i] ?? '')
      } else {
        flags.add(name)
      }
      continue
    }
    if (positionals.length === 0 && !isPrint && AGY_SUBCOMMANDS.has(token)) return undefined
    positionals.push(token)
  }
  if (!isPrint) return undefined

  const isSkip = flags.has('dangerously-skip-permissions')
  const base = isSkip ? 'skip-permissions' : options.get('mode') ?? 'default'
  const mode = flags.has('sandbox') ? `${base} +sandbox` : base
  const text = prompt ?? positionals[0]
  if (text !== undefined && AGY_LOCAL_COMMANDS.has(text.trim().split(/\s+/)[0] ?? '')) return undefined
  const summary = text === undefined || text === '-' ? segment.stdin ?? '(instruction passed on stdin)' : text

  return {
    agent: 'agy',
    kind: 'print',
    mode,
    isDangerous: isSkip,
    summary: clip(summary),
    cwd,
    outputFile: segment.stdoutFile,
  }
}

/**
 * Every codex or agy run a shell command starts non-interactively, in order.
 * A `cd <dir>` earlier in the command is taken as the run's directory.
 */
export function parseDelegations(command: string, depth = 0): ParsedDelegation[] {
  if (depth > 2 || !/\b(codex|agy)\b/.test(command)) return []

  const found: ParsedDelegation[] = []
  let cwd: string | undefined
  for (const segment of segmentsOf(tokenize(command))) {
    const head = programOf(segment.words)
    if (head === undefined) continue
    const { program, args } = head
    if ((program === 'cd' || program === 'pushd') && args[0] !== undefined) {
      cwd = args[0]
      continue
    }
    if (SHELLS.has(program)) {
      const flag = args.findIndex(one => /^-[a-z]*c[a-z]*$/.test(one))
      const script = flag === -1 ? undefined : args[flag + 1]
      if (script !== undefined) found.push(...parseDelegations(script, depth + 1))
      continue
    }
    const parsed = program === 'codex' ? parseCodex(args, segment, cwd) : program === 'agy' ? parseAgy(args, segment, cwd) : undefined
    if (parsed !== undefined) found.push(parsed)
  }

  return found
}

function tagOf(body: string, name: string): string | undefined {
  const match = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(body)
  const value = match?.[1]?.trim()

  return value === undefined || value === '' ? undefined : value
}

/**
 * The background-task notifications a conversation row carries.
 */
export function parseTaskNotifications(text: string): TaskNotification[] {
  if (!text.includes('<task-notification>')) return []

  const found: TaskNotification[] = []
  for (const match of text.matchAll(/<task-notification>([\s\S]*?)<\/task-notification>/g)) {
    const body = match[1] ?? ''
    const raw = tagOf(body, 'status')?.toLowerCase()
    const summary = tagOf(body, 'summary')
    const exitCode = summary === undefined ? undefined : /exit code (\d+)/i.exec(summary)?.[1]
    const status: DelegationStatus =
      raw === 'completed' ? (exitCode !== undefined && exitCode !== '0' ? 'failed' : 'done')
        : raw === 'failed' ? 'failed'
          : raw === 'killed' || raw === 'stopped' ? 'killed'
            : 'unknown'
    found.push({
      taskId: tagOf(body, 'task-id'),
      toolUseId: tagOf(body, 'tool-use-id'),
      status,
      summary,
      outputFile: tagOf(body, 'output-file'),
    })
  }

  return found
}
