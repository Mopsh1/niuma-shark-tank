import { atom, read, update } from 'claude-code'
import type { ElementTable, EngineInterface, Register } from 'claude-code'

import type { Delegation, DelegationAgent, SharkKind, TankShark } from '../types'
import { agyOutcome, noReplyNote } from './agy'
import { parseDelegations, parseTaskNotifications } from './parse'
import { LOOK } from './tank'

const PANE = 'delegations'
const TITLE = 'Agents'
const STORE_KEY = 'items'
const MAX_ITEMS = 200
const STALE_MS = 24 * 60 * 60 * 1000
// A subagent outlives its session only in the store: one this old never reported back.
const SUBAGENT_STALE_MS = 3 * 60 * 60 * 1000
const TICK_MS = 15_000
const BACKFILL_MAX = 20
// The tank fills the pane: every row the list of runs below it leaves, and never fewer than these.
const TANK_MIN_ROWS = 10
// Rows a run takes in the list (its name, its title, the gap after it), and more while it is open.
const RUN_ROWS = 3
const OPEN_RUN_ROWS = 4
// The tank draws in small type. Measured on the desktop (2026-10-27): a row is about 2.5 of its
// cells tall and its line is the pane's own, so the rows are the same; across, 1.25 of them per
// column of the pane's wrapped the rows, about 1.17 fit, so 1.15 (the `tankDensity` option, for
// another font size). The terminal has one size of type.
const TANK_TYPE = {
  desktop: { density: 1.15, aspect: 2.5 },
  terminal: { density: 1, aspect: 2.1 },
} as const

const CJK = /[㐀-鿿]/
// Characters that take two cells: CJK, Hangul, fullwidth forms.
const WIDE = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/

// A run's one-line summary, in the language the `summaryLanguage` option names: its description
// when that is already in it, else one short Haiku call; `off` shows the description and calls nothing.
type SummaryLanguage = 'en' | 'zh-TW' | 'off'
const SUMMARY: Record<Exclude<SummaryLanguage, 'off'>, { code: 'en' | 'zh'; system: string; isIn: (text: string) => boolean }> = {
  en: {
    code: 'en',
    system:
      'You condense the instruction handed to an AI coding agent (Codex, Antigravity or a Claude subagent) into one English line that says at a glance what the task is. Output that line alone: no quotes, prefix or full stop, at most 12 words.',
    isIn: text => !CJK.test(text),
  },
  'zh-TW': {
    code: 'zh',
    system:
      '你負責把交辦給 AI agent（Codex、Antigravity 或 Claude 子代理）的任務指令，濃縮成一句繁體中文摘要，讓人一眼看懂這項任務在做什麼。只輸出那一句，不加引號、前綴或句號，最多 25 個字。',
    isIn: text => CJK.test(text),
  },
}
const SUMMARY_LANGUAGES: readonly string[] = ['en', 'zh-TW', 'off']

// Set from the plugin's options each time the module loads.
let summaryLanguage: SummaryLanguage = 'en'
let desktopDensity: number = TANK_TYPE.desktop.density
// A background run's notice quotes its Bash description: `Background command "…" completed (exit code 0)`.
const QUOTED_DESCRIPTION = /^Background command "(.+?)" (?:completed|failed|was|exited)/

const items = atom({ plugin: 'niuma', key: 'items' } as const, [])
const expanded = atom({ plugin: 'niuma', key: 'expanded' } as const, null)

// Each agent is a shark of its own kind and colour.
const AGENT: Record<DelegationAgent, { name: string; color: string; shark: SharkKind }> = {
  codex: { name: 'Codex', color: '#4C9AF5', shark: 'hammer' },
  agy: { name: 'Antigravity', color: '#34A877', shark: 'tiger' },
  claude: { name: 'Claude', color: '#CC7B5C', shark: 'mako' },
}
const AGENT_ORDER: DelegationAgent[] = ['codex', 'agy', 'claude']
// Said after the agent's name; a plain task needs no word.
const KIND_LABEL: Record<Delegation['kind'], string> = { exec: '', review: 'review', resume: 'resume', print: '', agent: '' }
const MODE_LABEL: Record<string, string> = {
  'read-only': 'Read-only',
  'workspace-write': 'Workspace write',
  'danger-full-access': 'Full access',
  bypass: 'No sandbox, no approvals',
  plan: 'Plan',
  'accept-edits': 'Accept edits',
  auto: 'Auto',
  'skip-permissions': 'Skips approvals',
  default: 'Default mode',
}
const MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

// Writes are chained so two runs finishing together never drop each other's row.
let queue: Promise<unknown> = Promise.resolve()
function serially<T>(work: () => Promise<T>): Promise<T> {
  const run = queue.then(work, work)
  queue = run.catch(() => undefined)

  return run
}

const AGENTS = new Set<string>(['codex', 'agy', 'claude'])
const STATUSES = new Set<string>(['running', 'done', 'failed', 'killed', 'unknown'])
const KINDS = new Set<string>(['exec', 'review', 'resume', 'print', 'agent'])

// A record as the pane can draw it, or nothing: the store is shared by every session and every
// version of the mod, so a record may be torn, old or another's. One left out is dropped at the next write.
function recordOf(raw: unknown): Delegation | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const one = raw as Partial<Record<keyof Delegation, unknown>>
  if (typeof one.id !== 'string' || typeof one.agent !== 'string' || !AGENTS.has(one.agent)) return undefined
  if (typeof one.status !== 'string' || !STATUSES.has(one.status)) return undefined
  if (typeof one.startedAt !== 'number' || !Number.isFinite(one.startedAt)) return undefined
  const text = (v: unknown) => (typeof v === 'string' ? v : '')

  return {
    ...(raw as Delegation),
    kind: typeof one.kind === 'string' && KINDS.has(one.kind) ? (one.kind as Delegation['kind']) : 'exec',
    mode: text(one.mode),
    cwd: text(one.cwd),
    summary: text(one.summary),
    command: text(one.command),
    isDangerous: one.isDangerous === true,
    isBackground: one.isBackground === true,
    endedAt: typeof one.endedAt === 'number' && Number.isFinite(one.endedAt) ? one.endedAt : undefined,
    brief: typeof one.brief === 'string' ? one.brief : undefined,
    note: typeof one.note === 'string' ? one.note : undefined,
  }
}

async function loadStored($: EngineInterface): Promise<Delegation[]> {
  const raw = await $.store.get(STORE_KEY)

  return Array.isArray(raw) ? raw.flatMap(one => recordOf(one) ?? []) : []
}

// What the pane knows of: a subagent, or a record whose command still reads as a run (an agy
// /usage check logged before the parser knew better stays in the store and is left out here).
function visible(list: readonly Delegation[]): Delegation[] {
  return list.filter(one => one.agent === 'claude' || parseDelegations(one.command).length > 0)
}

// The runs under way, oldest first: the order they are numbered in, in the tank and the list.
function runningOf(list: readonly Delegation[]): Delegation[] {
  return list.filter(one => one.status === 'running').sort((a, b) => a.startedAt - b.startedAt)
}

async function publish($: EngineInterface, stored: readonly Delegation[]): Promise<void> {
  const shown = visible(stored)
  await update($, items, () => shown)
  const running = runningOf(shown).length
  $.ui.status(running > 0 ? `Agents: ${running} working` : undefined)
}

// The store is shared by every session, so each write merges into what is there now,
// and changes only the fields it names: a finish, a notice and a summary never undo each other.
function patch($: EngineInterface, id: string, changes: Partial<Delegation>, initial?: Delegation): Promise<void> {
  return serially(async () => {
    const stored = await loadStored($)
    const current = stored.find(one => one.id === id) ?? initial
    if (current === undefined) return
    const merged = [...stored.filter(one => one.id !== id), { ...current, ...changes }]
      .sort((a, b) => a.startedAt - b.startedAt)
      .slice(-MAX_ITEMS)
    await $.store.set(STORE_KEY, merged)
    await publish($, merged)
  })
}

async function reload($: EngineInterface): Promise<void> {
  await publish($, await loadStored($))
}

function cleanBrief(text: string | undefined): string | undefined {
  const line = text
    ?.split('\n')
    .map(one => one.trim())
    .find(one => one !== '')
    ?.replace(/^["'「『“]+|["'」』”。．.]+$/g, '')
    .trim()

  return line === undefined || line === '' ? undefined : line.slice(0, 60)
}

function briefPrompt(record: Delegation, hint: string | undefined): string {
  const tool = record.agent === 'claude' ? `Claude subagent (${record.mode})` : `${AGENT[record.agent].name} (${record.kind})`

  return [`Tool: ${tool}`, `Description: ${hint ?? '(none)'}`, 'Instruction:', record.summary.slice(0, 1500)].join('\n')
}

// A summary in the language chosen now; one in another (written before a change of option) is written again, once.
// With summaries off, any summary stands, the description kept as given.
const hasCurrentBrief = (one: Delegation) =>
  one.brief !== undefined && (summaryLanguage === 'off' || one.briefLanguage === SUMMARY[summaryLanguage].code)

const summarizing = new Set<string>()
async function summarize($: EngineInterface, record: Delegation, description?: string): Promise<void> {
  if (hasCurrentBrief(record) || summarizing.has(record.id)) return
  summarizing.add(record.id)
  try {
    // Written again later, the description is gone, but a background run's notice still quotes it.
    const given = (description ?? QUOTED_DESCRIPTION.exec(record.note ?? '')?.[1])?.trim()
    if (summaryLanguage === 'off') {
      const brief = cleanBrief(given)
      if (brief !== undefined) await patch($, record.id, { brief })

      return
    }
    const target = SUMMARY[summaryLanguage]
    let brief = given !== undefined && target.isIn(given) ? cleanBrief(given) : undefined
    if (brief === undefined) {
      const answer = await $.model.complete({
        model: 'haiku',
        system: target.system,
        prompt: briefPrompt(record, given || record.brief),
        maxTokens: 120,
        timeoutMs: 30_000,
      })
      if (answer.isAnswered) brief = cleanBrief(answer.text)
    }
    if (brief !== undefined) await patch($, record.id, { brief, briefLanguage: target.code })
  } catch {
    // No summary this time: the row shows the instruction itself, and the next session tries again.
  } finally {
    summarizing.delete(record.id)
  }
}

async function backfill($: EngineInterface): Promise<void> {
  // With summaries off there is nothing to write: no description comes back later.
  if (summaryLanguage === 'off') return
  const missing = visible(await loadStored($))
    .filter(one => !hasCurrentBrief(one))
    .slice(-BACKFILL_MAX)
  for (const one of missing) await summarize($, one)
}

function later($: EngineInterface, ms: number, work: () => Promise<unknown>): void {
  try {
    $.clock.after(ms, () => {
      void work().catch(() => undefined)
    })
  } catch {
    // No clock to schedule on: skip the work rather than fail the hook.
  }
}

// One agy run whose stdout is ours to read (not sent to a file): only then can its reply be judged.
function isLoneAgy(found: readonly { agent: DelegationAgent; outputFile?: string }[]): boolean {
  const [only] = found

  return found.length === 1 && only !== undefined && only.agent === 'agy' && only.outputFile === undefined
}

function firstLine(text: string | undefined): string | undefined {
  const line = text?.split('\n').find(one => one.trim() !== '')?.trim()

  return line === undefined ? undefined : line.slice(0, 200)
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

// 14:05 today, Oct 16 14:05 another day.
function clockOf(ms: number, now: number): string {
  const at = new Date(ms)
  const today = new Date(now)
  const time = `${pad(at.getHours())}:${pad(at.getMinutes())}`
  const isToday = at.getFullYear() === today.getFullYear() && at.getMonth() === today.getMonth() && at.getDate() === today.getDate()

  return isToday ? time : `${MONTH[at.getMonth()] ?? ''} ${at.getDate()} ${time}`
}

// How long a run has gone on, to the minute: the pane redraws every 15 seconds, not every one.
function runningFor(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000)
  if (minutes < 1) return '<1m'
  if (minutes < 60) return `${minutes}m`

  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

function modeOf(one: Delegation): string {
  const [base = one.mode, extra] = one.mode.split(' ')
  const label = MODE_LABEL[base] ?? base

  return extra === undefined ? label : `${label} ${extra}`
}

function shortPath(path: string): string {
  return path.replace(/^\/Users\/[^/]+/, '~')
}

// One line of at most `cells` columns, cut with an ellipsis; a wide character takes two.
function clip(text: string, cells: number): string {
  const line = text.replace(/\s+/g, ' ').trim()
  const widthOf = (ch: string) => (WIDE.test(ch) ? 2 : 1)
  if ([...line].reduce((sum, ch) => sum + widthOf(ch), 0) <= cells) return line
  let used = 0
  let kept = ''
  for (const ch of line) {
    if (used + widthOf(ch) > cells - 1) break
    kept += ch
    used += widthOf(ch)
  }

  return `${kept.trimEnd()}…`
}

// Who is at it: the CLI's name, or a subagent's type (a general one is just Claude).
function nameOf(one: Delegation): string {
  if (one.agent === 'claude') return one.mode === '' || one.mode === 'general-purpose' ? 'Claude' : clip(one.mode, 16)
  const kind = KIND_LABEL[one.kind]

  return kind === '' ? AGENT[one.agent].name : `${AGENT[one.agent].name} ${kind}`
}

// A second or third shark of one agent is drawn a shade lighter or darker, so each can be told apart.
function shadeOf(hex: string, k: number): string {
  if (k === 0) return hex
  const toward = k % 2 === 1 ? 255 : 0
  const amount = Math.min(0.5, 0.22 * Math.ceil(k / 2))
  const channel = (at: number) => {
    const v = parseInt(hex.slice(at, at + 2), 16)

    return Math.round(v + (toward - v) * amount)
      .toString(16)
      .padStart(2, '0')
  }

  return `#${channel(1)}${channel(3)}${channel(5)}`
}

type Worker = { one: Delegation; number: number; color: string }

// Each run under way with its number and its shark's colour.
function workersOf(running: readonly Delegation[]): Worker[] {
  const seen: Partial<Record<DelegationAgent, number>> = {}

  return running.map((one, index) => {
    const k = seen[one.agent] ?? 0
    seen[one.agent] = k + 1

    return { one, number: index + 1, color: shadeOf(AGENT[one.agent].color, k) }
  })
}

// Sharks past each agent's own, for runs side by side: past these, a run is in the list alone.
const MAX_EXTRA_SHARKS = 5

// Every agent keeps a shark in the tank: idle, its own; at work, one per run, the first in its own.
function sharksOf(workers: readonly Worker[]): TankShark[] {
  let extras = 0

  return AGENT_ORDER.flatMap((agent): TankShark[] => {
    const { name, color, shark } = AGENT[agent]
    const mine = workers.filter(worker => worker.one.agent === agent)
    if (mine.length === 0) return [{ id: agent, kind: shark, color, tag: `${name} idle`, isActive: false }]

    return mine.flatMap((worker, k) => {
      if (k > 0 && extras >= MAX_EXTRA_SHARKS) return []
      if (k > 0) extras += 1

      return [{ id: k === 0 ? agent : worker.one.id, kind: shark, color: worker.color, tag: `${worker.number} ${nameOf(worker.one)}`, isActive: true }]
    })
  })
}

async function openPane($: EngineInterface): Promise<void> {
  await reload($)
  await $.ui.open({ id: PANE, title: TITLE })
}

export const register: Register = (on, options) => {
  const language = options.summaryLanguage
  summaryLanguage = typeof language === 'string' && SUMMARY_LANGUAGES.includes(language) ? (language as SummaryLanguage) : 'en'
  const density = options.tankDensity
  desktopDensity = typeof density === 'number' && density >= 1 && density <= 2 ? density : TANK_TYPE.desktop.density

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'delegations',
      description: 'Show the agents at work (Claude subagents, codex, agy) as a shark tank',
    })

    const now = await $.clock.now()
    const stored = await loadStored($)
    const isStale = (one: Delegation) =>
      one.status === 'running' && now - one.startedAt > (one.agent === 'claude' ? SUBAGENT_STALE_MS : STALE_MS)
    if (stored.some(isStale)) {
      const list = stored.map(one =>
        isStale(one) ? { ...one, status: 'unknown' as const, note: 'No completion notice in time' } : one,
      )
      await $.store.set(STORE_KEY, list)
    }
    await reload($)

    later($, 2_000, () => backfill($))
    $.clock.every(TICK_MS, () => {
      void read($, items).then(list => {
        if (list.some(one => one.status === 'running')) $.ui.invalidate('ui.render')
      })
    })

    return next(e)
  })

  // A session that ends leaves nothing to report the end of what it started; a /clear goes on.
  on('session.end', async ($, e, next) => {
    if (e.reason !== 'clear') {
      const endedAt = await $.clock.now()
      const mine = (await loadStored($)).filter(one => one.status === 'running' && one.sessionId === e.sessionId)
      for (const one of mine) await patch($, one.id, { status: 'unknown', endedAt, note: 'The session ended first' })
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'delegations' }, async $ => {
    await openPane($)

    return { text: 'Opened the Agents pane.' }
  })

  // One line above the prompt: who is at what, and a button that opens the pane, so no command
  // is needed. A survey has the band first.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const workers = workersOf(runningOf(await read($, items)))
    const now = await $.clock.now()
    const shown = workers.slice(0, 2)
    const parts = shown.map(({ one, color }) => (
      <Text key={`band-${one.id}`} size="footnote">
        <Text color={color} weight="medium">{`${nameOf(one)}：`}</Text>
        {`${clip(one.brief ?? firstLine(one.summary) ?? '', 22)} `}
        <Text dimColor tabular>
          {runningFor(now - one.startedAt)}
        </Text>
      </Text>
    ))

    return (
      <Box flexDirection="row" alignItems="center" gap="sm">
        <Text color={workers.length > 0 ? 'warning' : 'subtle'}>{workers.length > 0 ? '●' : '○'}</Text>
        <Text weight="medium">Agents</Text>
        {workers.length === 0 ? (
          <Text key="band-idle" size="footnote" dimColor>
            All idle
          </Text>
        ) : (
          parts.flatMap((part, index) =>
            index === 0
              ? [part]
              : [
                  <Text key={`band-dot-${index}`} size="footnote" dimColor>
                    ·
                  </Text>,
                  part,
                ],
          )
        )}
        {workers.length > shown.length && (
          <Text key="band-more" size="footnote" dimColor>
            {`+${workers.length - shown.length} more`}
          </Text>
        )}
        <Box flexGrow={1} />
        <Button key="open-pane" label="Open" onPress={() => void openPane($)} />
      </Box>
    )
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const found = parseDelegations(e.command)
    if (found.length === 0) return next(e)

    const startedAt = await $.clock.now()
    const sessionCwd = await $.session.cwd().catch(() => '(unknown)')
    const sessionId = await $.session.id().catch(() => undefined)
    const records: Delegation[] = found.map((one, index) => ({
      id: found.length === 1 ? e.tool_use_id : `${e.tool_use_id}:${index}`,
      agent: one.agent,
      kind: one.kind,
      mode: one.mode,
      isDangerous: one.isDangerous,
      cwd: one.cwd ?? sessionCwd,
      summary: one.summary,
      outputFile: one.outputFile,
      command: e.command.slice(0, 2000),
      startedAt,
      status: 'running',
      isBackground: e.run_in_background === true,
      sessionId,
    }))
    for (const record of records) {
      await patch($, record.id, record, record)
      later($, 0, () => summarize($, record, found.length === 1 ? e.description : undefined))
    }
    // Opening the pane is a courtesy: a surface that has none must not fail the run.
    $.ui.open({ id: PANE, title: TITLE }).catch(() => undefined)

    const ran = await next(e)

    const endedAt = await $.clock.now()
    let outcome: Partial<Delegation>
    if (ran.deny !== undefined) {
      outcome = { status: 'failed', endedAt, note: `Blocked: ${ran.deny}` }
    } else if (ran.isError === true) {
      outcome = { status: 'failed', endedAt, note: firstLine(ran.text) }
    } else if (ran.result.backgroundTaskId !== undefined) {
      outcome = { isBackground: true, backgroundTaskId: ran.result.backgroundTaskId }
    } else if (ran.result.interrupted) {
      outcome = { status: 'killed', endedAt, note: 'Interrupted' }
    } else {
      const reply = isLoneAgy(found) ? agyOutcome(ran.result.stdout) : undefined
      outcome =
        reply !== undefined && !reply.hasReply ? { status: 'failed', endedAt, note: noReplyNote(reply) } : { status: 'done', endedAt }
    }
    for (const record of records) await patch($, record.id, outcome)

    return ran
  }).catch(($, e, next) => next(e))

  // A subagent Claude starts: in the foreground it ends with the call; in the background its
  // SubagentStop or task notification ends it.
  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    const record: Delegation = {
      id: e.tool_use_id,
      agent: 'claude',
      kind: 'agent',
      mode: e.subagent_type ?? 'general-purpose',
      isDangerous: e.mode === 'bypassPermissions',
      cwd: await $.session.cwd().catch(() => '(unknown)'),
      summary: String(e.prompt ?? '').slice(0, 2000),
      command: '',
      startedAt: await $.clock.now(),
      status: 'running',
      isBackground: e.run_in_background === true,
      sessionId: await $.session.id().catch(() => undefined),
    }
    await patch($, record.id, record, record)
    later($, 0, () => summarize($, record, e.description))
    $.ui.open({ id: PANE, title: TITLE }).catch(() => undefined)

    const ran = await next(e)

    const endedAt = await $.clock.now()
    let outcome: Partial<Delegation>
    if (ran.deny !== undefined) {
      outcome = { status: 'failed', endedAt, note: `Blocked: ${ran.deny}` }
    } else if (ran.isError === true) {
      outcome = { status: 'failed', endedAt, note: firstLine(ran.text) }
    } else {
      const result = ran.result
      const status = 'status' in result ? result.status : undefined
      if (status === 'async_launched' && 'agentId' in result && result.agentId !== undefined) {
        outcome = { isBackground: true, agentId: result.agentId, backgroundTaskId: result.agentId }
      } else if (status === 'remote_launched' || status === 'teammate_spawned') {
        // A cloud session or a teammate goes on by itself: the tank shows work that reports back here.
        outcome = { status: 'done', endedAt, note: status === 'remote_launched' ? 'Handed to a cloud session' : 'Joined the team' }
      } else {
        outcome = { status: 'done', endedAt }
      }
    }
    await patch($, record.id, outcome)

    return ran
  }).catch(($, e, next) => next(e))

  on('classic.SubagentStop', async ($, e, next) => {
    const done = await next(e)
    const match = (await loadStored($)).find(one => one.status === 'running' && one.agentId === e.agent_id)
    if (match !== undefined) await patch($, match.id, { status: 'done', endedAt: await $.clock.now() })

    return done
  }).catch(($, e, next) => next(e))

  // A background run ends with a task notification row; match it to its record.
  on('session.append', async ($, e, next) => {
    const stored = await next(e)

    if (e.message.type === 'user' || e.message.role === 'user' || e.message.type === 'attachment') {
      // A message's content may be one string rather than blocks: no notice is in that.
      const blocks = Array.isArray(e.message.content) ? e.message.content : []
      const notices = blocks.flatMap(block =>
        block.type === 'text' && 'text' in block && typeof block.text === 'string' ? parseTaskNotifications(block.text) : [],
      )
      if (notices.length > 0) {
        const list = await read($, items)
        const endedAt = await $.clock.now()
        for (const notice of notices) {
          const matches = list.filter(
            one =>
              one.status === 'running' &&
              ((notice.taskId !== undefined && one.backgroundTaskId === notice.taskId) ||
                (notice.toolUseId !== undefined && (one.id === notice.toolUseId || one.id.startsWith(`${notice.toolUseId}:`)))),
          )
          if (matches.length === 0) continue
          const [only] = matches
          // agy exits 0 even when it was refused and wrote no reply: that run failed.
          const isLoneAgyRun = matches.length === 1 && only?.agent === 'agy' && only.outputFile === undefined && notice.status === 'done'
          const output =
            isLoneAgyRun && notice.outputFile !== undefined ? await $.fs.read(notice.outputFile).catch(() => undefined) : undefined
          const reply = typeof output === 'string' ? agyOutcome(output) : undefined
          const isSilent = reply !== undefined && !reply.hasReply
          for (const match of matches) {
            await patch($, match.id, {
              status: isSilent ? 'failed' : notice.status,
              endedAt,
              note: isSilent ? noReplyNote(reply) : notice.summary?.slice(0, 200),
            })
          }
        }
      }
    }

    return stored
  }).catch(($, e, next) => next(e))

  // The tank on top, where each agent is a shark; below it, who is doing what, numbered as the tags are.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const table = $.ui.resolve(e)
    const { Box, Text, Button } = table
    // Only the desktop and the terminal draw a Client: elsewhere the list stands alone.
    const Client =
      e.surface === 'desktop'
        ? (table as ElementTable<'desktop'>).Client
        : e.surface === 'terminal'
          ? (table as ElementTable<'terminal'>).Client
          : undefined
    const workers = workersOf(runningOf(await read($, items)))
    const expandedRun = await read($, expanded)
    const now = await $.clock.now()
    const columns = e.props.bodyColumns ?? 40
    const titleCells = Math.max(16, columns - 6)
    const listRows =
      workers.length === 0
        ? 0
        : 1 + workers.length * RUN_ROWS + (workers.some(({ one }) => one.id === expandedRun) ? OPEN_RUN_ROWS : 0)
    const tankRows = Math.max(TANK_MIN_ROWS, (e.props.scroll?.bodyRows ?? 24) - listRows)
    const type = e.surface === 'desktop' ? { ...TANK_TYPE.desktop, density: desktopDensity } : TANK_TYPE.terminal

    const row = ({ one, number, color }: Worker): JSX.Element => {
      const isOpen = expandedRun === one.id
      const title = one.brief ?? firstLine(one.summary) ?? '(no instruction)'
      const shown = clip(title, titleCells)
      const toggle = () => update($, expanded, current => (current === one.id ? null : one.id))
      const facts = [
        one.agent === 'claude' ? 'Subagent' : modeOf(one),
        one.isBackground ? 'Background' : 'Foreground',
        `since ${clockOf(one.startedAt, now)}`,
      ].join(' · ')

      return (
        <Box key={`item-${one.id}`} flexDirection="column">
          <Box flexDirection="row" alignItems="center" gap="sm">
            <Text color={color} weight="semibold" tabular>{`${number}`}</Text>
            <Text color={color} weight="medium">
              {nameOf(one)}
            </Text>
            {one.isDangerous && (
              <Text color="error" size="footnote">
                ⚠
              </Text>
            )}
            <Box flexGrow={1} />
            <Text dimColor size="footnote" tabular>
              {runningFor(now - one.startedAt)}
            </Text>
          </Box>
          <Box flexDirection="row" alignItems="flex-start" gap="xs">
            <Button key={`row-${one.id}`} plain label={shown} onPress={() => void toggle()} />
            <Button key={`chevron-${one.id}`} plain dimColor label={isOpen ? '⌄' : '›'} onPress={() => void toggle()} />
          </Box>
          {isOpen && shown !== title && (
            <Text size="footnote" wrap="wrap">
              {title}
            </Text>
          )}
          {isOpen && (
            <Text dimColor size="footnote" wrap="wrap">
              {facts}
            </Text>
          )}
          {isOpen && (
            <Text dimColor size="footnote" wrap="truncate-middle">
              {shortPath(one.cwd)}
            </Text>
          )}
          {isOpen && (
            <Box flexDirection="row">
              <Button
                key={`dismiss-${one.id}`}
                plain
                dimColor
                label="Mark as ended"
                onPress={async () => {
                  await patch($, one.id, { status: 'killed', endedAt: await $.clock.now(), note: 'Marked as ended by hand' })
                }}
              />
            </Box>
          )}
        </Box>
      )
    }

    return (
      <Box flexDirection="column" gap="md">
        {Client !== undefined && (
          <Box key="tank-frame" backgroundColor={LOOK.paper}>
            <Client key="tank" module="./tank.ts" props={{ sharks: sharksOf(workers), rows: tankRows, ...type }} width="100%" height={tankRows} />
          </Box>
        )}
        {workers.length > 0 && (
          <Box key="workers" flexDirection="column" gap="md">
            {workers.map(row)}
          </Box>
        )}
        {/* Where no tank is drawn, an empty pane says why. */}
        {Client === undefined && workers.length === 0 && (
          <Text key="idle" dimColor size="footnote">
            All idle
          </Text>
        )}
      </Box>
    )
  })
}
