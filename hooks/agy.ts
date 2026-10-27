type Json = Record<string, unknown>

export type AgyOutcome = {
  hasReply: boolean
  denied: string[]
}

// agy's names for the actions it was refused, in words the pane shows.
const DENIED_LABEL: Record<string, string> = {
  ReadUrlContent: 'read web pages',
  read_url: 'read web pages',
  ReplaceFileContent: 'edit files',
  write_file: 'edit files',
  RunCommand: 'run commands',
  command: 'run commands',
}

const isRecord = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value)

function parsedReply(output: string): Json | undefined {
  const candidates = output
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.startsWith('{'))
  const start = output.indexOf('{')
  const end = output.lastIndexOf('}')
  if (start !== -1 && end > start) candidates.push(output.slice(start, end + 1))
  for (const text of candidates) {
    try {
      const parsed: unknown = JSON.parse(text)
      if (isRecord(parsed) && 'response' in parsed) return parsed
    } catch {
      // Not this line; try the next candidate.
    }
  }

  return undefined
}

/**
 * What one `agy -p … --output-format json` run gave back: whether it replied at all,
 * and which actions it was refused. In the background, agy answers nothing once an
 * action needing approval is refused, so an empty reply is a failed run.
 * Undefined when the output holds no such JSON (text mode, or stdout sent elsewhere).
 */
export function agyOutcome(output: string): AgyOutcome | undefined {
  const reply = parsedReply(output)
  if (reply === undefined) return undefined
  const response = typeof reply.response === 'string' ? reply.response.trim() : ''
  const denied = Array.isArray(reply.denied_actions)
    ? reply.denied_actions.flatMap(one => {
        if (!isRecord(one)) return []
        const name = typeof one.display_name === 'string' ? one.display_name : typeof one.action === 'string' ? one.action : ''
        const action = typeof one.action === 'string' ? one.action : ''

        return [DENIED_LABEL[name] ?? DENIED_LABEL[action] ?? (name || action)].filter(label => label !== '')
      })
    : []

  return { hasReply: response !== '', denied: [...new Set(denied)] }
}

/** The note a failed agy run carries: no reply, and what was refused. */
export function noReplyNote(outcome: AgyOutcome): string {
  return outcome.denied.length === 0 ? 'No reply from agy' : `No reply from agy (refused: ${outcome.denied.join(', ')})`
}
