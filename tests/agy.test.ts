import { describe, expect, test } from 'claude-code/testing'

import { agyOutcome, noReplyNote } from '../hooks/agy'

// The shape `agy -p … --output-format json` printed in the 2026-10-17 tests (trimmed).
const refusedWeb = JSON.stringify({
  conversation_id: 'b325084e',
  status: 'SUCCESS',
  response: '',
  duration_seconds: 30.5,
  num_turns: 1,
  denied_actions: [{ action: 'read_url', display_name: 'ReadUrlContent' }],
  usage: { total_tokens: 16652 },
})
const answered = JSON.stringify({ status: 'SUCCESS', response: 'agy ok', usage: { total_tokens: 7025 } })

describe('agy outcome', () => {
  test('an empty reply with refused actions is a run with no reply', () => {
    expect(agyOutcome(refusedWeb)).toEqual({ hasReply: false, denied: ['read web pages'] })
  })

  test('a warning line ahead of the JSON is skipped', () => {
    const output = `warning: --mode auto is not available for this account; continuing in the default mode.\n${refusedWeb}\n`
    expect(agyOutcome(output)).toEqual({ hasReply: false, denied: ['read web pages'] })
  })

  test('refusals are named in words, each once', () => {
    const output = JSON.stringify({
      response: '  ',
      denied_actions: [
        { action: 'write_file', display_name: 'ReplaceFileContent' },
        { action: 'command', display_name: 'RunCommand' },
        { action: 'write_file', display_name: 'ReplaceFileContent' },
        { action: 'mystery', display_name: 'SomethingNew' },
      ],
    })
    expect(agyOutcome(output)).toEqual({ hasReply: false, denied: ['edit files', 'run commands', 'SomethingNew'] })
  })

  test('a reply is a reply, and text output is not judged', () => {
    expect(agyOutcome(answered)).toEqual({ hasReply: true, denied: [] })
    expect(agyOutcome('agy ok\n')).toBeUndefined()
    expect(agyOutcome('')).toBeUndefined()
  })

  test('the note says what was refused', () => {
    expect(noReplyNote({ hasReply: false, denied: ['read web pages', 'run commands'] })).toBe(
      'No reply from agy (refused: read web pages, run commands)',
    )
    expect(noReplyNote({ hasReply: false, denied: [] })).toBe('No reply from agy')
  })
})
