/** `claude` is a subagent Claude started with its Agent tool; the others are external CLIs. */
export type DelegationAgent = 'codex' | 'agy' | 'claude'

export type DelegationKind = 'exec' | 'review' | 'resume' | 'print' | 'agent'

export type DelegationStatus = 'running' | 'done' | 'failed' | 'killed' | 'unknown'

export type Delegation = {
  id: string
  agent: DelegationAgent
  kind: DelegationKind
  /** The sandbox or permission mode; for a subagent, its type (`Explore`, `general-purpose`). */
  mode: string
  isDangerous: boolean
  cwd: string
  summary: string
  outputFile?: string
  command: string
  startedAt: number
  endedAt?: number
  status: DelegationStatus
  isBackground: boolean
  /** A background Bash run's task id, or a background subagent's agent id: what its notice names. */
  backgroundTaskId?: string
  /** A subagent's id, as SubagentStop names it. */
  agentId?: string
  /** The session that started it: when that session ends, nothing is left to report the end. */
  sessionId?: string
  note?: string
  /** A one-line Chinese summary of the task: written when it starts, or later by the session-start backfill. */
  brief?: string
  /** The language `brief` is in; a brief in another one (0.7.0 wrote English) is written again, once. */
  briefLanguage?: 'zh' | 'en'
}

export type SharkKind = 'hammer' | 'tiger' | 'mako'

/** One shark the pane asks the tank for; an id it stops asking for swims out. */
export type TankShark = {
  id: string
  kind: SharkKind
  color: string
  /** Drawn beside the shark: `1 Codex` while it works, `Codex idle` while it waits. */
  tag: string
  isActive: boolean
}

export type TankProps = {
  sharks: TankShark[]
  /** Rows of the tank's type to draw: the desktop reports a Client's rows as what it has drawn so far. */
  rows: number
  /** How many cells of the tank's type fit across one of the region's: more on the desktop's small type, 1 on the terminal. */
  density: number
  /** How many columns tall one row of the tank's type is. */
  aspect: number
}

declare module 'claude-code' {
  interface PluginState {
    'niuma': {
      items: Delegation[]
      expanded: string | null
    }
  }
}
