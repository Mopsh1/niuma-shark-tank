import { describe, expect, test } from 'claude-code/testing'

import { parseDelegations, parseTaskNotifications } from '../hooks/parse'

describe('parseDelegations', () => {
  test('codex exec behind cd, time and a pipe (the smoke test as run)', () => {
    const found = parseDelegations(
      'cd "$TMPDIR" && time codex exec -s read-only --skip-git-repo-check "Reply with exactly one line: codex ok, plus the model name you are running as." 2>&1 | tail -20',
    )
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({
      agent: 'codex',
      kind: 'exec',
      mode: 'read-only',
      isDangerous: false,
      cwd: '$TMPDIR',
      summary: 'Reply with exactly one line: codex ok, plus the model name you are running as.',
    })
  })

  test('codex review with top-level -s and -C', () => {
    const found = parseDelegations('codex -s read-only -C "$R" exec review --uncommitted -o /tmp/review.md 2>&1 | grep -vE "^hook:" | head -30')
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({
      agent: 'codex',
      kind: 'review',
      mode: 'read-only',
      cwd: '$R',
      summary: 'Review uncommitted changes',
      outputFile: '/tmp/review.md',
    })
  })

  test('agy print with --mode plan', () => {
    const found = parseDelegations(
      'cd "$SP/agy-plan-test" && agy -p "Create a file named probe.txt" --mode plan --print-timeout 120s 2>&1 | tail -15; echo "=== files after:"; ls -la "$SP/agy-plan-test"',
    )
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({ agent: 'agy', kind: 'print', mode: 'plan', cwd: '$SP/agy-plan-test', summary: 'Create a file named probe.txt' })
  })

  test('agy --mode=accept-edits and a stdout redirect', () => {
    const [one] = parseDelegations('agy --mode=accept-edits -p "rename the helpers" > /tmp/agy.txt')
    expect(one).toMatchObject({ mode: 'accept-edits', outputFile: '/tmp/agy.txt', summary: 'rename the helpers' })
  })

  test('a heredoc prompt is the summary', () => {
    const [one] = parseDelegations("codex exec -s workspace-write - <<'EOF'\nFix the failing test\nin calc.py\nEOF\necho done")
    expect(one).toMatchObject({ mode: 'workspace-write', summary: 'Fix the failing test in calc.py' })
  })

  test('a run inside bash -lc', () => {
    const [one] = parseDelegations(`bash -lc 'cd ~/proj && codex exec --full-auto "add tests"'`)
    expect(one).toMatchObject({ agent: 'codex', mode: 'workspace-write', cwd: '~/proj', summary: 'add tests' })
  })

  test('dangerous flags are flagged', () => {
    expect(parseDelegations('codex exec --dangerously-bypass-approvals-and-sandbox "x"')[0]).toMatchObject({ mode: 'bypass', isDangerous: true })
    expect(parseDelegations('codex exec -s danger-full-access "x"')[0]).toMatchObject({ isDangerous: true })
    expect(parseDelegations('agy --dangerously-skip-permissions -p "x"')[0]).toMatchObject({ mode: 'skip-permissions', isDangerous: true })
  })

  test('sandbox from -c, wrappers and assignments', () => {
    expect(parseDelegations(`codex exec -c 'sandbox_mode="read-only"' "x"`)[0]).toMatchObject({ mode: 'read-only' })
    expect(parseDelegations('FOO=1 timeout 300 codex exec "x"')[0]).toMatchObject({ mode: 'default', summary: 'x' })
  })

  test('two runs in one command', () => {
    const found = parseDelegations('codex exec "first" && agy -p "second"')
    expect(found.map(one => one.agent)).toEqual(['codex', 'agy'])
  })

  test('commands that only mention them are not runs', () => {
    for (const command of [
      'codex --version',
      'codex exec --help 2>&1 | head -60',
      'codex mcp list',
      'codex "fix it"',
      'agy --help',
      'agy models',
      'agy -i "chat"',
      'which brew herdr claude codex agy mise',
      'herdr integration install codex',
      'brew info codex',
      'grep -n "codex exec" notes.md',
      'echo "agy -p hi"',
      'cd /tmp && agy -p /usage --output-format json --log-file /dev/null --print-timeout 30s',
      'agy -p "/help" --mode plan',
      'agy -p /credits',
    ]) {
      expect(parseDelegations(command)).toEqual([])
    }
  })

  test('a prompt run on another model through /model is still a run', () => {
    expect(parseDelegations('agy -p "/model gemini-pro review chapter 3" --mode plan')).toHaveLength(1)
  })
})

describe('parseTaskNotifications', () => {
  const note = (status: string, summary: string) =>
    `<task-notification>\n<task-id>b1</task-id>\n<tool-use-id>toolu_1</tool-use-id>\n<status>${status}</status>\n<summary>${summary}</summary>\n</task-notification>`

  test('reads the task, the call and the outcome', () => {
    expect(parseTaskNotifications(note('completed', 'Background command "codex" completed (exit code 0)'))).toEqual([
      { taskId: 'b1', toolUseId: 'toolu_1', status: 'done', summary: 'Background command "codex" completed (exit code 0)' },
    ])
  })

  test('a non-zero exit code is a failure, a kill is a kill', () => {
    expect(parseTaskNotifications(note('completed', 'done (exit code 2)'))[0]?.status).toBe('failed')
    expect(parseTaskNotifications(note('failed', 'boom'))[0]?.status).toBe('failed')
    expect(parseTaskNotifications(note('killed', 'stopped'))[0]?.status).toBe('killed')
  })

  test('plain text carries none', () => {
    expect(parseTaskNotifications('nothing to see')).toEqual([])
  })
})
