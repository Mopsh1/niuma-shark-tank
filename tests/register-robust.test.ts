import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const PANE = {
  component: 'Pane',
  requestId: 'delegations',
  props: { title: 'Agents', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 60 }, view: {} },
} as const
const BAND = {
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 80, scroll: { offset: 0, bodyRows: 10 }, view: {} },
} as const

const NOW = 1_700_000_000_000
const SURFACES = ['terminal', 'desktop', 'vscode', 'mobile'] as const
const BASH_OK = { stdout: 'ok', stderr: '', interrupted: false }

type Caller = { tool: { call: (input: Record<string, unknown>) => Promise<unknown> } }
type Shark = { id: string; isActive: boolean }
type Drawn = {
  find: (query: { type?: string; key?: string; text?: string | RegExp }) => Promise<{ props: Record<string, unknown> } | undefined>
  findAll: (query: { type: 'Button' }) => Promise<readonly { key?: string; text?: string }[]>
  press: (target: { key: string }) => Promise<void>
  unmount: () => Promise<void>
}

// Loosely typed on purpose: the checker gives up resolving every built-in tool's overload.
const call = ($: unknown, input: Record<string, unknown>) => ($ as Caller).tool.call(input)
const rowButtons = async (ui: Drawn) => (await ui.findAll({ type: 'Button' })).filter(one => one.key?.startsWith('row-'))
const sharksIn = async (ui: Drawn): Promise<Shark[]> =>
  (((await ui.find({ type: 'Client', key: 'tank' }))?.props.props as { sharks?: Shark[] } | undefined)?.sharks ?? []) as Shark[]
const mount = ($: unknown, surface: (typeof SURFACES)[number], target: typeof PANE | typeof BAND = PANE) =>
  ($ as { ui: { mount: (t: object) => Promise<Drawn> } }).ui.mount({ plugin: 'niuma', surface, ...target })

const answered = (text: string) =>
  ({
    value: { isAnswered: true, text, usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
  }) as never

const notice = (taskId: string, content?: string) => ({
  door: 'delivery' as const,
  origin: { kind: 'task-notification' as const },
  uuid: `row-${taskId}-${Math.random()}`,
  message: {
    type: 'user' as const,
    role: 'user' as const,
    isMeta: true as const,
    content:
      content ??
      [{ type: 'text' as const, text: `<task-notification>\n<task-id>${taskId}</task-id>\n<status>completed</status>\n<summary>done</summary>\n</task-notification>` }],
  },
})

// Beneath the plugin, the engine's own ends of the events it hooks.
function engineBeneath(on: On): void {
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'S1' }) as never)
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  on('command.register', () => ({ value: { command: 'delegations' } }) as never)
  on('classic.SubagentStop', () => ({}))
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('model.complete', () => answered('測試摘要'))
  on('fs.read', () => ({ value: '' }) as never)
}

const GOOD = {
  id: 'good',
  agent: 'codex',
  kind: 'exec',
  mode: 'read-only',
  isDangerous: false,
  cwd: '/tmp',
  summary: 'x',
  command: 'codex exec -s read-only "x"',
  startedAt: NOW - 2_000,
  status: 'running',
  isBackground: true,
  brief: '好的紀錄',
  briefLanguage: 'zh',
}

test('a store with torn records still starts and draws everywhere, and keeps the good ones', async ($, on) => {
  mock.store(on, {
    items: [
      null,
      5,
      'x',
      {},
      { id: 'a' },
      { id: 'b', agent: 'gemini', status: 'running', startedAt: NOW },
      { id: 'c', agent: 'codex', status: 'running', startedAt: 'yesterday' },
      { id: 'd', agent: 'codex', status: 'sleeping', startedAt: NOW },
      { id: 'torn', agent: 'claude', status: 'running', startedAt: NOW - 1_000, mode: 7, summary: null, cwd: [] },
      GOOD,
    ],
  })
  mock.clock(on, { now: NOW })
  engineBeneath(on)

  await $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: true })
  for (const surface of SURFACES) {
    const ui = await mount($, surface)
    expect(await rowButtons(ui)).toHaveLength(2)
    await ui.unmount()
    const band = await mount($, surface, BAND)
    await band.unmount()
  }
})

test('thirty runs at once: the tank keeps to a few sharks, the list and the band show them all', async ($, on) => {
  mock.store(on)
  mock.clock(on, { now: NOW })
  engineBeneath(on)
  let n = 0
  on('tool.call', { tool: 'Bash' }, () => ({ result: { ...BASH_OK, backgroundTaskId: `bg${(n += 1)}` } }))

  for (let k = 0; k < 30; k++) {
    await call($, { tool: 'Bash', command: `codex exec -s read-only "job ${k}"`, description: `第 ${k} 件事`, run_in_background: true })
  }
  const ui = await mount($, 'desktop')
  const sharks = await sharksIn(ui)
  expect(sharks.length).toBeLessThanOrEqual(8)
  expect(sharks.filter(one => one.isActive).length).toBeGreaterThan(1)
  expect(await rowButtons(ui)).toHaveLength(30)
  await ui.unmount()
  const band = await mount($, 'desktop', BAND)
  expect(await band.find({ type: 'Text', text: '+28 more' })).toBeDefined()
  await band.unmount()
})

test('odd tool calls are logged, and the call comes back as the tool answered it', async ($, on) => {
  mock.store(on)
  mock.clock(on, { now: NOW })
  engineBeneath(on)
  on('tool.call', { tool: 'Agent' }, ($, e) =>
    e.description === 'boom'
      ? ({ isError: true, result: undefined, text: 'Agent failed' } as never)
      : ({ result: { status: 'async_launched', agentId: `agent-${e.description}`, description: '', prompt: '', outputFile: '/tmp/o' } } as never),
  )
  on('tool.call', { tool: 'Bash' }, () => ({ result: { ...BASH_OK, backgroundTaskId: 'bgU' } }))

  await call($, { tool: 'Agent', description: '', prompt: '', subagent_type: '🦈探索小隊', mode: 'bypassPermissions', run_in_background: true })
  const failed = await call($, { tool: 'Agent', description: 'boom', prompt: 'x' })
  expect(failed).toMatchObject({ isError: true })
  await call($, {
    tool: 'Bash',
    command: "codex exec - <<'EOF'\n中文 🦈 指令\nEOF",
    description: '含表情符號的交辦 🦈',
    run_in_background: true,
  })

  for (const surface of SURFACES) {
    const ui = await mount($, surface)
    expect(await rowButtons(ui)).toHaveLength(2)
    if (surface !== 'mobile') expect(await ui.find({ type: 'Text', text: '⚠' })).toBeDefined()
    await ui.unmount()
  }
})

test('notices and stops that match nothing change nothing', async ($, on) => {
  mock.store(on, { items: [GOOD] })
  mock.clock(on, { now: NOW })
  engineBeneath(on)
  await $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: true })

  await $.session.append(notice('nobody') as never)
  await $.session.append(notice('plain', 'just a message, not blocks') as never)
  await $.classic.SubagentStop({ agent_id: 'nobody', agent_type: 'Explore', stop_hook_active: false, agent_transcript_path: '/tmp/x' } as never)
  await $.session.end({ reason: 'clear', sessionId: 'S1', resume: { id: 'S1' } } as never)

  const ui = await mount($, 'desktop')
  expect(await rowButtons(ui)).toHaveLength(1)
  await ui.unmount()
})

// A small seeded generator, so a run that fails can be run again as it was.
function generator(seed: number): () => number {
  let a = seed >>> 0

  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)

    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

test('a random run of events never throws, and the pane draws after it', async ($, on) => {
  mock.store(on)
  const clock = mock.clock(on, { now: NOW })
  engineBeneath(on)
  let next = 0
  const tasks: string[] = []
  const agents: string[] = []
  on('tool.call', { tool: 'Bash' }, ($, e) => {
    if (e.run_in_background === true) {
      const id = `bg${(next += 1)}`
      tasks.push(id)

      return { result: { ...BASH_OK, backgroundTaskId: id } }
    }

    return { result: { ...BASH_OK, stdout: JSON.stringify({ status: 'SUCCESS', response: next % 2 === 0 ? 'ok' : '' }) } }
  })
  on('tool.call', { tool: 'Agent' }, ($, e) => {
    const agentId = `agent${(next += 1)}`
    if (e.run_in_background === true) {
      agents.push(agentId)

      return { result: { status: 'async_launched', agentId, description: '', prompt: '', outputFile: '/tmp/o' } } as never
    }

    return { result: { status: 'completed', agentId, content: [], totalToolUseCount: 0, totalDurationMs: 1, totalTokens: 1 } } as never
  })

  const random = generator(20261027)
  const pick = <T>(list: readonly T[]): T | undefined => list[Math.floor(random() * list.length)]
  const surfaces = [...SURFACES]
  for (let k = 0; k < 150; k++) {
    const roll = Math.floor(random() * 11)
    if (roll === 0) await call($, { tool: 'Bash', command: `codex exec -s read-only "job ${k}"`, description: `背景工作 ${k}`, run_in_background: true })
    else if (roll === 1) await call($, { tool: 'Bash', command: `agy -p "job ${k}" --mode plan --output-format json`, description: `Foreground job ${k}` })
    else if (roll === 2) await call($, { tool: 'Agent', description: `Explore ${k}`, prompt: `look at ${k}`, subagent_type: 'Explore', run_in_background: true })
    else if (roll === 3) await call($, { tool: 'Agent', description: `子代理 ${k}`, prompt: `look at ${k}` })
    else if (roll === 4) await $.session.append(notice(pick(tasks) ?? 'none') as never)
    else if (roll === 5) {
      await $.classic.SubagentStop({ agent_id: pick(agents) ?? 'none', agent_type: 'Explore', stop_hook_active: false, agent_transcript_path: '/tmp/x' } as never)
    } else if (roll === 6) {
      const ui = await mount($, pick(surfaces) ?? 'desktop')
      const [row] = await rowButtons(ui)
      if (row?.key !== undefined) {
        // A press opens the row, or closes one left open: its button is there only while it is open.
        await ui.press({ key: row.key })
        const dismiss = `dismiss-${row.key.slice('row-'.length)}`
        if (random() < 0.5 && (await ui.find({ type: 'Button', key: dismiss })) !== undefined) await ui.press({ key: dismiss })
      }
      await ui.unmount()
    } else if (roll === 7) {
      const band = await mount($, pick(surfaces) ?? 'desktop', BAND)
      await band.unmount()
    } else if (roll === 8) await $.session.end({ reason: random() < 0.5 ? 'clear' : 'other', sessionId: 'S1', resume: { id: 'S1' } } as never)
    else if (roll === 9) await $.session.append(notice('plain', `a plain message ${k}`) as never)
    else await clock.advance(Math.floor(random() * 300_000))
  }

  for (const surface of SURFACES) {
    const ui = await mount($, surface)
    if (surface === 'desktop' || surface === 'terminal') expect((await sharksIn(ui)).length).toBeLessThanOrEqual(8)
    await ui.unmount()
  }
})
