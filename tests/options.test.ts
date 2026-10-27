import { expect, mock, test } from 'claude-code/testing'

const PANE = {
  component: 'Pane',
  requestId: 'delegations',
  props: { title: 'Agents', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 60 }, view: {} },
} as const

const NOW = 1_700_000_000_000
const BACKGROUND = { stdout: 'ok', stderr: '', interrupted: false }

type Caller = { tool: { call: (input: Record<string, unknown>) => Promise<unknown> } }
type Drawn = {
  find: (query: { type?: string; key?: string }) => Promise<{ props: Record<string, unknown> } | undefined>
  findAll: (query: { type: 'Button' }) => Promise<readonly { key?: string; text?: string }[]>
}

// Loosely typed on purpose: the checker gives up resolving every built-in tool's overload.
const run = ($: unknown, command: string, description: string) =>
  ($ as Caller).tool.call({ tool: 'Bash', command, description, run_in_background: true })
const titles = async (ui: Drawn) => (await ui.findAll({ type: 'Button' })).filter(one => one.key?.startsWith('row-')).map(one => one.text)

const answered = (text: string) =>
  ({
    value: { isAnswered: true, text, usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
  }) as never

test('English by default: an English description is the title as given, a Chinese one Haiku puts into English', async ($, on) => {
  mock.store(on)
  const clock = mock.clock(on, { now: NOW })
  let n = 0
  on('tool.call', { tool: 'Bash' }, () => ({ result: { ...BACKGROUND, backgroundTaskId: `bg${(n += 1)}` } }))
  const asked: string[] = []
  on('model.complete', ($, e) => {
    asked.push(`${e.system ?? ''}|${e.prompt}`)

    return answered('"Summarize chapter three."')
  })

  await run($, 'codex exec -s read-only "Review chapter 3"', 'Review chapter three for gaps')
  await run($, 'agy -p "Summarize chapter 3" --mode plan', '整理第三章的重點')
  await clock.advance(10)

  expect(asked).toHaveLength(1)
  expect(asked[0]).toMatch(/one English line/)
  expect(asked[0]).toMatch(/整理第三章的重點/)
  const ui = await $.ui.mount({ plugin: 'niuma', surface: 'desktop', ...PANE })
  expect(await titles(ui)).toEqual(['Review chapter three for gaps', 'Summarize chapter three'])
  await ui.unmount()
})

test('summaries off: no model is called, and each description is its title as given', { options: { summaryLanguage: 'off' } }, async ($, on) => {
  mock.store(on)
  const clock = mock.clock(on, { now: NOW })
  let n = 0
  on('tool.call', { tool: 'Bash' }, () => ({ result: { ...BACKGROUND, backgroundTaskId: `bg${(n += 1)}` } }))
  let asked = 0
  on('model.complete', () => {
    asked += 1

    return answered('unused')
  })

  await run($, 'codex exec -s read-only "Review chapter 3"', 'Review chapter three for gaps')
  await run($, 'agy -p "Summarize chapter 3" --mode plan', '整理第三章的重點')
  await clock.advance(10)

  expect(asked).toBe(0)
  const ui = await $.ui.mount({ plugin: 'niuma', surface: 'desktop', ...PANE })
  expect(await titles(ui)).toEqual(['Review chapter three for gaps', '整理第三章的重點'])
  await ui.unmount()
})

test('a summary language that is no option falls back to English', { options: { summaryLanguage: 'klingon' } }, async ($, on) => {
  mock.store(on)
  const clock = mock.clock(on, { now: NOW })
  on('tool.call', { tool: 'Bash' }, () => ({ result: { ...BACKGROUND, backgroundTaskId: 'bg1' } }))
  let asked = 0
  on('model.complete', () => {
    asked += 1

    return answered('unused')
  })

  await run($, 'codex exec -s read-only "Review chapter 3"', 'Review chapter three for gaps')
  await clock.advance(10)

  expect(asked).toBe(0)
  const ui = await $.ui.mount({ plugin: 'niuma', surface: 'desktop', ...PANE })
  expect(await titles(ui)).toEqual(['Review chapter three for gaps'])
  await ui.unmount()
})

test('the tank density option reaches the desktop tank; the terminal keeps its one size', { options: { tankDensity: 1.4 } }, async ($, on) => {
  mock.store(on)
  mock.clock(on, { now: NOW })

  const desktop = await $.ui.mount({ plugin: 'niuma', surface: 'desktop', ...PANE })
  expect(await desktop.find({ type: 'Client', key: 'tank' })).toMatchObject({ props: { props: { density: 1.4, aspect: 2.5 } } })
  await desktop.unmount()
  const terminal = await $.ui.mount({ plugin: 'niuma', surface: 'terminal', ...PANE })
  expect(await terminal.find({ type: 'Client', key: 'tank' })).toMatchObject({ props: { props: { density: 1, aspect: 2.1 } } })
  await terminal.unmount()
})

test('a tank density out of range keeps the measured one', { options: { tankDensity: 9 } }, async ($, on) => {
  mock.store(on)
  mock.clock(on, { now: NOW })

  const desktop = await $.ui.mount({ plugin: 'niuma', surface: 'desktop', ...PANE })
  expect(await desktop.find({ type: 'Client', key: 'tank' })).toMatchObject({ props: { props: { density: 1.15 } } })
  await desktop.unmount()
})
