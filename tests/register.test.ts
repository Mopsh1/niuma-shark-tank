import { expect, mock, test } from 'claude-code/testing'

// These tests were written for summaries in Traditional Chinese, as their author uses the pane.
const ZH = { options: { summaryLanguage: 'zh-TW' } }

const PANE = {
  component: 'Pane',
  requestId: 'delegations',
  props: {
    title: 'Agents',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 60 },
    view: {},
  },
} as const

const BASH_OK = { stdout: 'ok', stderr: '', interrupted: false }
const SURFACES = ['terminal', 'desktop'] as const
const NOW = 1_700_000_000_000
const CLOCK = /\d\d:\d\d/.source

type Caller = { tool: { call: (input: Record<string, unknown>) => Promise<unknown> } }

// Loosely typed on purpose: the checker gives up resolving every built-in tool's overload.
function runBash($: unknown, command: string, extra: Record<string, unknown> = {}) {
  return ($ as Caller).tool.call({ tool: 'Bash', command, description: 'test', ...extra })
}

function runAgent($: unknown, extra: Record<string, unknown> = {}) {
  return ($ as Caller).tool.call({ tool: 'Agent', description: 'Find the auth handlers', prompt: 'Find where auth is handled', ...extra })
}

const answered = (text: string) =>
  ({
    value: {
      isAnswered: true,
      text,
      usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    },
  }) as never

type Found = { key?: string; text?: string } | undefined
type Shark = { id: string; kind: string; color: string; tag: string; isActive: boolean }
type Drawn = {
  find: (query: { type?: string; key?: string; text?: string | RegExp }) => Promise<{ props: Record<string, unknown> } | undefined>
  findAll: (query: { type: 'Button' }) => Promise<readonly { key?: string; text?: string }[]>
}

const rowButtons = async (ui: Drawn) => (await ui.findAll({ type: 'Button' })).filter(one => one.key?.startsWith('row-'))

const sharksIn = async (ui: Drawn): Promise<Shark[]> => {
  const tank = await ui.find({ type: 'Client', key: 'tank' })

  return ((tank?.props.props as { sharks?: Shark[] } | undefined)?.sharks ?? []) as Shark[]
}

const IDLE = [
  { id: 'codex', kind: 'hammer', color: '#4C9AF5', tag: 'Codex idle', isActive: false },
  { id: 'agy', kind: 'tiger', color: '#34A877', tag: 'Antigravity idle', isActive: false },
  { id: 'claude', kind: 'mako', color: '#CC7B5C', tag: 'Claude idle', isActive: false },
]

const notice = (taskId: string, extra = '') => ({
  door: 'delivery' as const,
  origin: { kind: 'task-notification' as const },
  uuid: `row-${taskId}`,
  message: {
    type: 'user' as const,
    role: 'user' as const,
    isMeta: true as const,
    content: [
      {
        type: 'text' as const,
        text: `<task-notification>\n<task-id>${taskId}</task-id>\n${extra}<status>completed</status>\n<summary>Background command completed (exit code 0)</summary>\n</task-notification>`,
      },
    ],
  },
})

test('idle: the tank fills the pane, one dim shark for each agent, and no words', ZH, async ($, on) => {
  mock.store(on)
  mock.clock(on, { now: NOW })

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: 'niuma', surface, ...PANE })
    expect(await ui.find({ type: 'Client', key: 'tank' })).toMatchObject({ props: { module: 'hooks/tank.ts', height: 60 } })
    expect(await sharksIn(ui)).toEqual(IDLE)
    expect(await ui.find({ type: 'Text', text: /No agents at work|All idle/ })).toBeUndefined()
    expect(await rowButtons(ui)).toHaveLength(0)
    await ui.unmount()
  }
})

test('a run with a Chinese description: its shark comes alive, numbered as its row', ZH, async ($, on) => {
  mock.store(on)
  const clock = mock.clock(on, { now: NOW })
  on('tool.call', { tool: 'Bash' }, () => ({ result: { ...BASH_OK, backgroundTaskId: 'bg1' } }))
  let asked = 0
  on('model.complete', () => {
    asked += 1

    return answered('unused')
  })

  await runBash($, 'cd ~/thesis && codex exec -s read-only -o /tmp/review.md "Review chapter 3 for gaps in the argument"', {
    description: '請 Codex 檢查第三章的論證漏洞',
    run_in_background: true,
  })
  await clock.advance(10)
  expect(asked).toBe(0)

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: 'niuma', surface, ...PANE })
    // The tank gives the list below it its rows: a line before it, three for the run.
    expect(await ui.find({ type: 'Client', key: 'tank' })).toMatchObject({ props: { height: 56 } })
    const sharks = await sharksIn(ui)
    expect(sharks[0]).toEqual({ id: 'codex', kind: 'hammer', color: '#4C9AF5', tag: '1 Codex', isActive: true })
    expect(sharks.slice(1)).toEqual(IDLE.slice(1))
    expect(await ui.find({ type: 'Text', text: '1' })).toMatchObject({ props: { color: '#4C9AF5' } })
    expect(await ui.find({ type: 'Text', text: 'Codex' })).toMatchObject({ props: { color: '#4C9AF5' } })
    expect(await ui.find({ type: 'Text', text: '<1m' })).toBeDefined()
    const [row]: Found[] = await rowButtons(ui)
    expect(row?.text).toBe('請 Codex 檢查第三章的論證漏洞')

    await ui.press({ key: row?.key ?? '' })
    expect(await ui.find({ type: 'Text', text: new RegExp(`^Read-only · Background · since ${CLOCK}$`) })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '~/thesis' })).toBeDefined()
    expect(await ui.find({ text: /codex exec|review\.md/ })).toBeUndefined()
    await ui.press({ key: `chevron-${(row?.key ?? '').slice('row-'.length)}` })
    expect(await ui.find({ type: 'Text', text: '~/thesis' })).toBeUndefined()
    await ui.unmount()
  }

  await clock.advance(5 * 60_000)
  const later = await $.ui.mount({ plugin: 'niuma', surface: 'desktop', ...PANE })
  expect(await later.find({ type: 'Text', text: '5m' })).toBeDefined()
  await later.unmount()
})

test('a run with an English description gets a short Chinese title from Haiku', ZH, async ($, on) => {
  mock.store(on)
  const clock = mock.clock(on, { now: NOW })
  on('tool.call', { tool: 'Bash' }, () => ({ result: { ...BASH_OK, backgroundTaskId: 'bg2' } }))
  let asked = ''
  on('model.complete', ($, e) => {
    asked = `${e.model}|${e.system ?? ''}|${e.prompt}`

    return answered('「整理第三章的實驗結果」。\n')
  })

  await runBash($, 'agy -p "Summarize the results section of chapter 3" --mode plan', {
    description: 'Ask Antigravity for a summary',
    run_in_background: true,
  })
  await clock.advance(10)

  expect(asked).toMatch(/^haiku\|/)
  expect(asked).toMatch(/繁體中文摘要/)
  expect(asked).toMatch(/Summarize the results section of chapter 3/)
  expect(asked).toMatch(/Ask Antigravity for a summary/)
  const ui = await $.ui.mount({ plugin: 'niuma', surface: 'desktop', ...PANE })
  const [row]: Found[] = await rowButtons(ui)
  expect(row?.text).toBe('整理第三章的實驗結果')
  expect((await sharksIn(ui))[1]).toMatchObject({ id: 'agy', tag: '1 Antigravity', isActive: true })
  await ui.unmount()
})

test('a long title is cut to one line, and shown whole when the row is open', ZH, async ($, on) => {
  mock.store(on)
  const clock = mock.clock(on, { now: NOW })
  on('tool.call', { tool: 'Bash' }, () => ({ result: { ...BASH_OK, backgroundTaskId: 'bg3' } }))
  const long = '讀完 Unity 專案裡所有的 C# 腳本，整理觸覺回饋從輸入事件一路到馬達輸出的完整流程'

  await runBash($, 'codex exec -s read-only "Explain the haptics flow"', { description: long, run_in_background: true })
  await clock.advance(10)

  const ui = await $.ui.mount({ plugin: 'niuma', surface: 'desktop', ...PANE })
  const [row]: Found[] = await rowButtons(ui)
  const shown = row?.text ?? ''
  expect(shown.endsWith('…')).toBe(true)
  expect(long.startsWith(shown.slice(0, -1))).toBe(true)
  expect(await ui.find({ type: 'Text', text: long })).toBeUndefined()
  await ui.press({ key: row?.key ?? '' })
  expect(await ui.find({ type: 'Text', text: long })).toBeDefined()
  await ui.unmount()
})

test('a background run works until its notice, then its shark goes back to idle', ZH, async ($, on) => {
  mock.store(on)
  mock.clock(on, { now: NOW })
  on('tool.call', { tool: 'Bash' }, () => ({ result: { ...BASH_OK, backgroundTaskId: 'bg42' } }))

  await runBash($, 'agy -p "long job" --mode plan', { run_in_background: true, description: '長時間的整理工作' })
  const ui = await $.ui.mount({ plugin: 'niuma', surface: 'desktop', ...PANE })
  expect(await rowButtons(ui)).toHaveLength(1)
  expect((await sharksIn(ui))[1]).toMatchObject({ id: 'agy', isActive: true })

  await $.session.append(notice('bg42'))
  expect(await rowButtons(ui)).toHaveLength(0)
  expect(await sharksIn(ui)).toEqual(IDLE)
  await ui.unmount()
})

test('a finished foreground run never shows; nor does a record that is no run', ZH, async ($, on) => {
  mock.store(on, {
    items: [
      {
        id: 'old-usage',
        agent: 'agy',
        kind: 'print',
        mode: 'default',
        isDangerous: false,
        cwd: '/tmp',
        summary: '/usage',
        command: 'cd /tmp && agy -p /usage --output-format json --log-file /dev/null --print-timeout 30s',
        startedAt: NOW - 60_000,
        status: 'running',
        isBackground: false,
      },
    ],
  })
  mock.clock(on, { now: NOW })
  on('tool.call', { tool: 'Bash' }, () => ({ result: BASH_OK }))

  await runBash($, 'codex exec -s read-only "say hi"', { description: '打招呼測試' })
  await runBash($, 'ls && codex --version')

  const ui = await $.ui.mount({ plugin: 'niuma', surface: 'terminal', ...PANE })
  expect(await rowButtons(ui)).toHaveLength(0)
  expect(await sharksIn(ui)).toEqual(IDLE)
  await ui.unmount()
})

test('a subagent in the background is a mako until SubagentStop', ZH, async ($, on) => {
  mock.store(on)
  const clock = mock.clock(on, { now: NOW })
  on('tool.call', { tool: 'Agent' }, () => ({
    result: { status: 'async_launched', agentId: 'agent-7', description: 'Find the auth handlers', prompt: 'p', outputFile: '/tmp/a7' },
  }))
  on('model.complete', () => answered('找出處理登入驗證的程式'))

  // Beneath the plugin, the engine's own end of the event.
  on('classic.SubagentStop', () => ({}))

  await runAgent($, { subagent_type: 'Explore', run_in_background: true })
  await clock.advance(10)
  const ui = await $.ui.mount({ plugin: 'niuma', surface: 'desktop', ...PANE })
  expect((await sharksIn(ui))[2]).toEqual({ id: 'claude', kind: 'mako', color: '#CC7B5C', tag: '1 Explore', isActive: true })
  expect(await ui.find({ type: 'Text', text: 'Explore' })).toMatchObject({ props: { color: '#CC7B5C' } })
  const [row]: Found[] = await rowButtons(ui)
  expect(row?.text).toBe('找出處理登入驗證的程式')

  await $.classic.SubagentStop({
    agent_id: 'agent-7',
    agent_type: 'Explore',
    stop_hook_active: false,
    agent_transcript_path: '/tmp/agent-7.jsonl',
  } as never)
  expect(await rowButtons(ui)).toHaveLength(0)
  expect((await sharksIn(ui))[2]).toEqual(IDLE[2])
  await ui.unmount()
})

test('a subagent in the foreground ends with its call; a general one is just Claude', ZH, async ($, on) => {
  mock.store(on)
  mock.clock(on, { now: NOW })
  let midway: Shark[] = []
  on('tool.call', { tool: 'Agent' }, async () => {
    const ui = await $.ui.mount({ plugin: 'niuma', surface: 'desktop', ...PANE })
    midway = await sharksIn(ui)
    await ui.unmount()

    return { result: { status: 'completed', agentId: 'agent-8', content: [], totalToolUseCount: 0, totalDurationMs: 1, totalTokens: 1 } } as never
  })
  on('model.complete', () => answered('找出處理登入驗證的程式'))

  await runAgent($)
  expect(midway[2]).toMatchObject({ id: 'claude', tag: '1 Claude', isActive: true })
  const ui = await $.ui.mount({ plugin: 'niuma', surface: 'desktop', ...PANE })
  expect(await sharksIn(ui)).toEqual(IDLE)
  await ui.unmount()
})

test('two runs of one agent: two sharks, the second a shade apart, numbered by start', ZH, async ($, on) => {
  mock.store(on)
  const clock = mock.clock(on, { now: NOW })
  let n = 0
  on('tool.call', { tool: 'Bash' }, () => ({ result: { ...BASH_OK, backgroundTaskId: `bg-${(n += 1)}` } }))

  await runBash($, 'codex exec -s read-only "first"', { description: '第一件事', run_in_background: true })
  await clock.advance(1_000)
  await runBash($, 'agy -p "middle" --mode plan', { description: '中間那件事', run_in_background: true })
  await clock.advance(1_000)
  await runBash($, 'codex exec -s read-only "second"', { description: '第二件事', run_in_background: true })
  await clock.advance(10)

  const ui = await $.ui.mount({ plugin: 'niuma', surface: 'desktop', ...PANE })
  const sharks = await sharksIn(ui)
  expect(sharks.map(one => one.tag)).toEqual(['1 Codex', '3 Codex', '2 Antigravity', 'Claude idle'])
  expect(sharks[0]?.id).toBe('codex')
  expect(sharks[1]?.id).not.toBe('codex')
  expect(sharks[1]?.color).not.toBe('#4C9AF5')
  expect((await rowButtons(ui)).map(one => one.text)).toEqual(['第一件事', '中間那件事', '第二件事'])
  await ui.unmount()
})

test('a run whose end never came can be marked as ended by hand', ZH, async ($, on) => {
  mock.store(on)
  mock.clock(on, { now: NOW })
  on('tool.call', { tool: 'Bash' }, () => ({ result: { ...BASH_OK, backgroundTaskId: 'bg9' } }))

  await runBash($, 'codex exec -s read-only "stuck"', { description: '卡住的工作', run_in_background: true })
  const ui = await $.ui.mount({ plugin: 'niuma', surface: 'desktop', ...PANE })
  const [row]: Found[] = await rowButtons(ui)
  await ui.press({ key: row?.key ?? '' })
  await ui.press({ key: `dismiss-${(row?.key ?? '').slice('row-'.length)}` })
  expect(await rowButtons(ui)).toHaveLength(0)
  expect(await sharksIn(ui)).toEqual(IDLE)
  await ui.unmount()
})

test("when the session ends, its runs stop working; a /clear leaves them", ZH, async ($, on) => {
  mock.store(on)
  mock.clock(on, { now: NOW })
  on('session.id', () => ({ value: 'S1' }) as never)
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  on('tool.call', { tool: 'Bash' }, () => ({ result: { ...BASH_OK, backgroundTaskId: 'bg10' } }))

  await runBash($, 'codex exec -s read-only "long"', { description: '很久的工作', run_in_background: true })
  const id = 'S1'
  await $.session.end({ reason: 'clear', sessionId: id, resume: { id } } as never)
  const before = await $.ui.mount({ plugin: 'niuma', surface: 'desktop', ...PANE })
  expect(await rowButtons(before)).toHaveLength(1)
  await before.unmount()

  await $.session.end({ reason: 'other', sessionId: id, resume: { id } } as never)
  const after = await $.ui.mount({ plugin: 'niuma', surface: 'desktop', ...PANE })
  expect(await rowButtons(after)).toHaveLength(0)
  await after.unmount()
})

const BAND = {
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 80, scroll: { offset: 0, bodyRows: 10 }, view: {} },
} as const

test('the band says all idle, and opens the pane', ZH, async ($, on) => {
  mock.store(on)
  mock.clock(on, { now: NOW })
  let opened = ''
  on('ui.open', ($, e) => {
    opened = e.id

    return { value: { isPlaced: true } } as never
  })

  for (const surface of SURFACES) {
    const band = await $.ui.mount({ plugin: 'niuma', surface, ...BAND })
    expect(await band.find({ type: 'Text', text: /^Agents$/ })).toMatchObject({ props: { weight: 'medium' } })
    expect(await band.find({ type: 'Text', text: 'All idle' })).toBeDefined()
    await band.press({ key: 'open-pane' })
    expect(opened).toBe('delegations')
    await band.unmount()
  }
})

test('the band says who is at what, and yields to a survey', ZH, async ($, on) => {
  mock.store(on)
  const clock = mock.clock(on, { now: NOW })
  on('tool.call', { tool: 'Bash' }, () => ({ result: { ...BASH_OK, backgroundTaskId: 'bg7' } }))
  // Beneath the plugin, the engine's own band: here, the survey it draws.
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => $.ui.resolve(e).Text({ children: 'A survey' }))

  await runBash($, 'agy -p "long job" --mode plan', { run_in_background: true, description: '長時間的整理工作' })
  await clock.advance(10)

  const band = await $.ui.mount({ plugin: 'niuma', surface: 'desktop', ...BAND })
  expect(await band.find({ type: 'Text', text: /^●$/ })).toMatchObject({ props: { color: 'warning' } })
  expect(await band.find({ type: 'Text', text: /^Antigravity：$/ })).toMatchObject({ props: { color: '#34A877' } })
  expect(await band.find({ type: 'Text', text: /長時間的整理工作/ })).toBeDefined()
  await band.unmount()

  const survey = await $.ui.mount({ plugin: 'niuma', surface: 'desktop', ...BAND, props: { ...BAND.props, hasSurvey: true } })
  expect(await survey.find({ type: 'Text', text: /^Agents$/ })).toBeUndefined()
  expect(await survey.find({ type: 'Text', text: 'A survey' })).toBeDefined()
  await survey.unmount()
})
