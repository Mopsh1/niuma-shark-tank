import { expect, mock, test } from 'claude-code/testing'

const PANE = {
  component: 'Pane',
  requestId: 'delegations',
  props: { title: 'Agents', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 60 }, view: {} },
} as const

type Caller = { tool: { call: (input: Record<string, unknown>) => Promise<unknown> } }

test('the tank swims: dark water, shaded sharks, and a tag on each', async ($, on) => {
  mock.store(on)
  mock.clock(on, { now: 1_700_000_000_000 })
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: 'ok', stderr: '', interrupted: false, backgroundTaskId: 'bg1' } }))

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'niuma', surface, ...PANE })
    // The desktop reports a Client's rows as what it has drawn so far: the tank goes by the pane's.
    await ui.resize({ columns: 52, rows: 2, in: 'tank' })
    await ui.advance(300)
    const rows = await ui.findAll({ in: 'tank', type: 'Text' })
    expect(rows.filter(one => one.props.mono === true)).toHaveLength(60)
    const text = rows.map(one => one.text).join('\n')
    for (const tag of ['Codex idle', 'Antigravity idle', 'Claude idle']) expect(text).toContain(tag)
    // Skin is drawn as blocks: a run with a background of its own.
    expect(rows.some(one => typeof one.props.backgroundColor === 'string')).toBe(true)
    expect(rows.some(one => one.props.mono === true)).toBe(true)
    await ui.unmount()
  }

  await ($ as unknown as Caller).tool.call({
    tool: 'Bash',
    command: 'codex exec -s read-only "long job"',
    description: '長時間的工作',
    run_in_background: true,
  })
  const ui = await $.ui.mount({ plugin: 'niuma', surface: 'desktop', ...PANE })
  await ui.resize({ columns: 52, rows: 15, in: 'tank' })
  await ui.advance(300)
  const text = (await ui.findAll({ in: 'tank', type: 'Text' })).map(one => one.text).join('\n')
  expect(text).toContain('1 Codex')
  expect(text).not.toContain('Codex idle')
  await ui.unmount()
})
