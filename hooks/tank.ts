// The shark tank the pane draws in a Client region: each agent a shark, fish and dots around them.
// After stackedlol/ascii-sharks (MIT): a top-down spine rasterized cell by cell, skin as shaded
// grey blocks under dark glyphs with a soft glyph edge, fish as dashes, and a wake that lights the dots.
import type { ClientModule, ClientSurface, RenderElement } from 'claude-code'

import type { SharkKind, TankProps, TankShark } from '../types'

type RGB = readonly [number, number, number]
type Point = { x: number; y: number }

const TICK_MS = 100
const SUBSTEPS = 2
// A cell is about this many columns tall unless the pane says otherwise; the world is measured
// in columns both ways.
const DEFAULT_ASPECT = 2.1
const NODES = 20

/** How the tank looks: tuned by eye in tuner/index.html, which runs this file and sets these live. */
export type Look = {
  /** The paper the tank is drawn on. */
  paper: string
  /** The share of cells that hold a dot. */
  dotShare: number
  /** How dark the dots are, 1 as drawn. */
  dotStrength: number
  /** A shark at work, and an idle one: its length as a share of the tank's shorter side. */
  activeSize: number
  idleSize: number
  /** Across the body everything is drawn this much wider than life: a row is a coarse step. */
  broad: number
  /** How strongly an idle shark is drawn, 1 as one at work. */
  idleStrength: number
  /** How much of the agent's colour is mixed into the grey skin. */
  tint: number
  /** The share of a working shark's glyphs that flash a colour or white. */
  shimmer: number
  /** How fast the sharks swim, 1 as tuned. */
  speed: number
}

// Tuned by Mopshi in the tuner, 2026-10-27.
export const LOOK: Look = {
  paper: '#ffffff',
  dotShare: 0.25,
  dotStrength: 1,
  activeSize: 1.07,
  idleSize: 0.6,
  broad: 1.1,
  idleStrength: 0.5,
  tint: 0.2,
  shimmer: 0.1,
  speed: 1.3,
}

let look: Look = { ...LOOK }
let paperRgb: RGB = rgbOf(LOOK.paper)

/** Sets the look while the tank runs: the tuner's way in; the mod itself keeps LOOK. */
export function setLook(next: Partial<Look>): void {
  look = { ...look, ...next }
  paperRgb = rgbOf(look.paper)
}

// The faint dots on the paper: mostly grey, a few blue, green and red; the wake lights them teal.
const DOT_RGB: RGB[] = [
  [150, 150, 146],
  [80, 100, 225],
  [70, 170, 95],
  [215, 85, 75],
]
const WAKE_RGB: RGB = [40, 160, 200]
const FISH_RGB: RGB = [70, 82, 104]
const EDGE_RGB: RGB = [110, 110, 108]
const ACCENTS = ['#e0892c', '#e03a32', '#b44ae0', '#33c8cc', '#3cb54a', '#3150e8', '#d9c14a']

// Sparse glyphs on bright skin, dense glyphs in shadow, so the texture follows the shading.
const SKIN_RAMP = ':;t%SX8#@'
const FIN_GLYPHS = '%;tS:'
const RIDGE_GLYPHS = '@8%'
const MARK_GLYPHS = '#%@'
const EDGE_HEAVY = ':;'
const EDGE_LIGHT = ".',`"

const FLAG_BODY = 1
const FLAG_FIN = 2
const FLAG_RIDGE = 3
const FLAG_EYE = 4
const FLAG_MARK = 5

// Four sub-cell samples besides the centre, for anti-aliased silhouettes.
const SUBSAMPLES: readonly Point[] = [
  { x: 0.25, y: 0.3 },
  { x: 0.75, y: 0.3 },
  { x: 0.25, y: 0.72 },
  { x: 0.75, y: 0.72 },
]

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v)
const rand = (lo: number, hi: number) => lo + Math.random() * (hi - lo)

function smoothstep(e0: number, e1: number, x: number): number {
  const t = clamp((x - e0) / (e1 - e0), 0, 1)

  return t * t * (3 - 2 * t)
}

// Shortest signed angle from a to b.
function angleDiff(a: number, b: number): number {
  let d = (b - a) % (Math.PI * 2)
  if (d > Math.PI) d -= Math.PI * 2
  if (d < -Math.PI) d += Math.PI * 2

  return d
}

// Cheap integer hash to [0, 1): deterministic, so textures stay put on the skin.
function hash3(x: number, y: number, z: number): number {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(z | 0, 1442695041)
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  h ^= h >>> 16

  return (h >>> 0) / 4294967296
}

function inTriangle(px: number, py: number, ax: number, ay: number, bx: number, by: number, cx: number, cy: number): boolean {
  const d1 = (px - bx) * (ay - by) - (ax - bx) * (py - by)
  const d2 = (px - cx) * (by - cy) - (bx - cx) * (py - cy)
  const d3 = (px - ax) * (cy - ay) - (cx - ax) * (py - ay)

  return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0))
}

// ── colour ────────────────────────────────────────────────────────────

// Channels in steps of 12, so neighbouring cells share a colour and a row draws as few runs.
function hexOf(r: number, g: number, b: number): string {
  const step = (v: number) => clamp(Math.round(v / 12) * 12, 0, 255).toString(16).padStart(2, '0')

  return `#${step(r)}${step(g)}${step(b)}`
}

// `c` laid over the paper at strength `k`.
function over(c: RGB, k: number): string {
  return hexOf(
    paperRgb[0] + (c[0] - paperRgb[0]) * k,
    paperRgb[1] + (c[1] - paperRgb[1]) * k,
    paperRgb[2] + (c[2] - paperRgb[2]) * k,
  )
}

// A grey of brightness `level` (0 dark, 1 light) with a little of the agent's colour in it.
function skinOf(tint: RGB, level: number): RGB {
  const grey = 60 + Math.round(clamp(level, 0, 1.1) * 10) * 16
  const lum = (tint[0] * 0.3 + tint[1] * 0.59 + tint[2] * 0.11) || 1
  const mix = (v: number) => grey * (1 - look.tint) + clamp((v * grey) / lum, 0, 255) * look.tint

  return [mix(tint[0]), mix(tint[1]), mix(tint[2])]
}

function rgbOf(hex: string): RGB {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(hex)

  return m === null ? [150, 160, 180] : [parseInt(m[1] ?? '0', 16), parseInt(m[2] ?? '0', 16), parseInt(m[3] ?? '0', 16)]
}

// ── shapes, all fractions of length (from ascii-sharks) ───────────────

type Shape = {
  halfWidth: (s: number) => number
  /** Pectoral fin: leading root, trailing root, tip position along the body, and reach. */
  pectoral: readonly [number, number, number, number]
  falcate: boolean
  pelvic: readonly [number, number, number, number]
  caudal: number
  dorsal: readonly [number, number]
  secondDorsal: readonly [number, number]
  /** A hammerhead's cephalofoil: half-span, how far its tips sweep back, its depth, a notch. */
  head?: { span: number; sweep: number; depth: number; notch: number }
  eye: readonly [number, number] | null
  gills: readonly [number, number]
  isBarred: boolean
}

function classicHalfWidth(s: number): number {
  if (s < 0.13) return 0.09 * Math.pow(Math.sin(((s / 0.13) * Math.PI) / 2), 0.95)
  if (s < 0.3) return 0.09 + 0.016 * smoothstep(0.13, 0.3, s)
  if (s < 0.84) return 0.019 + 0.087 * Math.pow(1 - (s - 0.3) / 0.54, 1.25)
  const k = (s - 0.84) / 0.16

  return 0.019 * (1 - k) + 0.012 * Math.sin(k * Math.PI)
}

const SHAPES: Record<SharkKind, Shape> = {
  // Codex: slim neck under a wide, swept-back cephalofoil.
  hammer: {
    halfWidth: s => (s < 0.06 ? 0.045 : s < 0.3 ? 0.045 + 0.061 * smoothstep(0.06, 0.3, s) : classicHalfWidth(s) * 0.92),
    head: { span: 0.17, sweep: 0.035, depth: 0.09, notch: 0 },
    pectoral: [0.17, 0.4, 0.5, 0.22],
    falcate: true,
    pelvic: [0.56, 0.63, 0.67, 0.075],
    caudal: 0.11,
    dorsal: [0.28, 0.44],
    secondDorsal: [0.7, 0.74],
    eye: null,
    gills: [0.16, 0.26],
    isBarred: false,
  },
  // Antigravity: blunt, square snout on a heavy, barred body.
  tiger: {
    halfWidth: s => {
      if (s < 0.13) return 0.1 * Math.pow(Math.sin(((s / 0.13) * Math.PI) / 2), 0.45)
      if (s < 0.3) return 0.1 + 0.014 * smoothstep(0.13, 0.3, s)
      if (s < 0.84) return 0.019 + 0.095 * Math.pow(1 - (s - 0.3) / 0.54, 1.2)
      const k = (s - 0.84) / 0.16

      return 0.019 * (1 - k) + 0.012 * Math.sin(k * Math.PI)
    },
    pectoral: [0.15, 0.42, 0.53, 0.25],
    falcate: true,
    pelvic: [0.57, 0.65, 0.69, 0.085],
    caudal: 0.095,
    dorsal: [0.33, 0.46],
    secondDorsal: [0.71, 0.75],
    eye: [0.08, 0.12],
    gills: [0.19, 0.28],
    isBarred: true,
  },
  // Claude's subagents: a mako, long conical snout, torpedo body, tall crescent tail.
  mako: {
    halfWidth: s => {
      if (s < 0.17) return 0.088 * Math.pow(Math.sin(((s / 0.17) * Math.PI) / 2), 1.5)
      if (s < 0.32) return 0.088 + 0.012 * smoothstep(0.17, 0.32, s)
      if (s < 0.86) return 0.014 + 0.086 * Math.pow(1 - (s - 0.32) / 0.54, 1.45)
      const k = (s - 0.86) / 0.14

      return 0.014 * (1 - k) + 0.01 * Math.sin(k * Math.PI)
    },
    pectoral: [0.18, 0.4, 0.5, 0.21],
    falcate: true,
    pelvic: [0.58, 0.64, 0.68, 0.06],
    caudal: 0.13,
    dorsal: [0.34, 0.45],
    secondDorsal: [0.76, 0.79],
    eye: [0.11, 0.15],
    gills: [0.2, 0.3],
    isBarred: false,
  },
}

// ── the world ─────────────────────────────────────────────────────────

type Shark = {
  id: string
  kind: SharkKind
  rgb: RGB
  tag: string
  isActive: boolean
  seed: number
  length: number
  /** Spine positions, snout first. */
  nodes: Point[]
  heading: number
  speed: number
  /** Tail-beat phase: drives the body wave. */
  phase: number
  /** Smoothed angular velocity: the shark banks its fins into turns. */
  turn: number
  wander: number
  orbitDir: 1 | -1
  orbitRadius: number
  /** 0 idle (a faint shadow, slower, smaller) to 1 at work. */
  glow: number
  /** Where a shark no longer asked for swims off to: the nearest edge. */
  exit: Point | null
}

type Fish = { x: number; y: number; vx: number; vy: number; turn: number; depth: number; school: number }

type World = {
  cols: number
  rows: number
  width: number
  height: number
  time: number
  sharks: Shark[]
  fish: Fish[]
  wake: Float32Array
  dots: Uint8Array
  dotPhase: Float32Array
  wanted: readonly TankShark[]
  /** How many cells of the tank's small type fit across one of the region's own. */
  density: number
  /** Rows to draw, when the pane says; else the region's own. */
  wantRows: number
  /** How many columns tall one row of the tank's type is. */
  aspect: number
  /**
   * 0 draws everything; 1 leaves out the dots, and the sharks' glyphs take one colour and stop
   * shimmering; 2 the fish too, and the skin keeps five shades; 3 three shades and one edge;
   * 4 the sharks are their glyphs alone, in one colour; 5 the tags alone, on bare paper.
   */
  detail: number
  isSeeded: boolean
  nextSeed: number
}

type State = { world: World; frame: number }

// A shark at work spans most of the tank; an idle one is drawn smaller, and a crowd smaller still.
function lengthFor(world: World, glow: number): number {
  const crowd = world.sharks.filter(one => one.exit === null).length
  const base = clamp(Math.min(world.width, world.height * 1.15), 14, 90) * (crowd > 4 ? 0.8 : 1)

  return base * (look.idleSize + (look.activeSize - look.idleSize) * glow)
}

function newWorld(): World {
  return {
    cols: 0,
    rows: 0,
    width: 0,
    height: 0,
    time: 0,
    sharks: [],
    fish: [],
    wake: new Float32Array(0),
    dots: new Uint8Array(0),
    dotPhase: new Float32Array(0),
    wanted: [],
    density: 1,
    wantRows: 0,
    aspect: DEFAULT_ASPECT,
    detail: 0,
    isSeeded: false,
    nextSeed: 1,
  }
}

// The most cells the tank draws: a pane larger still shows the rest as paper, and each frame stays
// quick to draw and inside the engine's bounds.
const MAX_COLS = 180
const MAX_ROWS = 120
// The most sharks the tank draws: past that a frame takes too long.
const MAX_SHARKS = 12

/** The size the tank draws at for a region of this many cells. */
function fitted(cols: number, rows: number): { cols: number; rows: number } {
  const whole = (v: number, most: number) => (Number.isFinite(v) ? clamp(Math.floor(v), 0, most) : 0)

  return { cols: whole(cols, MAX_COLS), rows: whole(rows, MAX_ROWS) }
}

function resize(world: World, wantCols: number, wantRows: number): void {
  const { cols, rows } = fitted(wantCols, wantRows)
  world.cols = cols
  world.rows = rows
  world.width = cols
  world.height = rows * world.aspect
  // A new size may fit everything again.
  world.detail = 0
  const n = cols * rows
  world.wake = new Float32Array(n)
  world.dots = new Uint8Array(n)
  world.dotPhase = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const roll = Math.random()
    // A share of the cells holds a dot: mostly grey, a few blue, green and red.
    const u = roll / Math.max(look.dotShare, 1e-6)
    world.dots[i] = u > 1 ? 0 : u > 0.1 ? 1 : u > 0.065 ? 2 : u > 0.03 ? 3 : 4
    world.dotPhase[i] = rand(-0.6, 0.6)
  }
  const count = clamp(Math.round((cols * rows) / 45), 10, 48)
  if (world.fish.length !== count) {
    world.fish = []
    const schools = count > 24 ? 3 : 2
    for (let school = 0; school < schools; school++) {
      const cx = rand(4, Math.max(5, cols - 4))
      const cy = rand(3, Math.max(4, world.height - 3))
      const angle = rand(0, Math.PI * 2)
      for (let k = school; k < count; k += schools) {
        world.fish.push({
          x: clamp(cx + rand(-4, 4), 1, cols - 1),
          y: clamp(cy + rand(-3, 3), 1, world.height - 1),
          vx: Math.cos(angle) * 4,
          vy: Math.sin(angle) * 4,
          turn: 0,
          depth: rand(0.55, 1),
          school,
        })
      }
    }
  }
  for (const fish of world.fish) {
    fish.x = clamp(fish.x, 0.5, cols - 0.5)
    fish.y = clamp(fish.y, 0.5, world.height - 0.5)
  }
}

// A shark the tank starts with swims already inside; one asked for later comes in from an edge.
function spawn(world: World, want: TankShark, isInside: boolean): Shark {
  const L = lengthFor(world, want.isActive ? 1 : 0)
  const { width: W, height: H } = world
  let head: Point
  let heading: number
  if (isInside) {
    head = { x: rand(W * 0.2, W * 0.8), y: rand(H * 0.2, H * 0.8) }
    heading = rand(0, Math.PI * 2)
  } else {
    const edge = Math.floor(Math.random() * 4)
    head = edge === 0 ? { x: -1, y: rand(0, H) } : edge === 1 ? { x: W + 1, y: rand(0, H) } : edge === 2 ? { x: rand(0, W), y: -1 } : { x: rand(0, W), y: H + 1 }
    heading = Math.atan2(H / 2 - head.y, W / 2 - head.x) + rand(-0.4, 0.4)
  }
  const seg = L / (NODES - 1)
  const nodes: Point[] = []
  for (let k = 0; k < NODES; k++) nodes.push({ x: head.x - Math.cos(heading) * seg * k, y: head.y - Math.sin(heading) * seg * k })
  world.nextSeed += 1

  return {
    id: want.id,
    kind: want.kind,
    rgb: rgbOf(want.color),
    tag: want.tag,
    isActive: want.isActive,
    seed: world.nextSeed,
    length: L,
    nodes,
    heading,
    speed: L * 0.15,
    phase: Math.random() * Math.PI * 2,
    turn: 0,
    wander: 0,
    orbitDir: Math.random() < 0.5 ? 1 : -1,
    orbitRadius: rand(0.22, 0.36),
    glow: want.isActive ? 1 : 0,
    exit: null,
  }
}

const KINDS = new Set<string>(Object.keys(SHAPES))

/**
 * The sharks asked for, as the tank can draw them: whatever came in props, each a shark of a kind
 * it knows, with strings where it needs them, each id once, and no more than it draws.
 */
function wantedOf(list: unknown): TankShark[] {
  if (!Array.isArray(list)) return []
  const seen = new Set<string>()
  const sharks: TankShark[] = []
  for (const raw of list) {
    if (typeof raw !== 'object' || raw === null) continue
    const one = raw as Partial<Record<keyof TankShark, unknown>>
    const id = typeof one.id === 'string' ? one.id : typeof one.id === 'number' ? String(one.id) : ''
    if (id === '' || seen.has(id) || sharks.length >= MAX_SHARKS) continue
    seen.add(id)
    sharks.push({
      id,
      kind: typeof one.kind === 'string' && KINDS.has(one.kind) ? (one.kind as SharkKind) : 'mako',
      color: typeof one.color === 'string' ? one.color : '',
      tag: typeof one.tag === 'string' ? one.tag : '',
      isActive: one.isActive === true,
    })
  }

  return sharks
}

function reconcile(world: World): void {
  world.wanted = wantedOf(world.wanted)
  for (const want of world.wanted) {
    let shark = world.sharks.find(one => one.id === want.id && one.exit === null)
    if (shark === undefined) {
      shark = spawn(world, want, !world.isSeeded)
      world.sharks.push(shark)
    }
    shark.kind = want.kind
    shark.rgb = rgbOf(want.color)
    shark.tag = want.tag
    shark.isActive = want.isActive
  }
  for (const shark of world.sharks) {
    if (shark.exit !== null || world.wanted.some(want => want.id === shark.id)) continue
    const head = shark.nodes[0] ?? { x: 0, y: 0 }
    const edges = [
      { d: head.x, to: { x: -1, y: 0 } },
      { d: world.width - head.x, to: { x: 1, y: 0 } },
      { d: head.y, to: { x: 0, y: -1 } },
      { d: world.height - head.y, to: { x: 0, y: 1 } },
    ].sort((a, b) => a.d - b.d)
    shark.exit = edges[0]?.to ?? { x: 1, y: 0 }
  }
  world.isSeeded = true
}

// After ascii-sharks' stepSharks: wander, a lazy circuit round the middle, room for the others,
// a turn back once the snout leaves the frame, a turning circle that grows with speed.
function stepSharks(world: World, dt: number): void {
  const { width: W, height: H } = world
  const cx = W / 2
  const cy = H / 2
  const minSide = Math.min(W, H)
  for (const sh of world.sharks) {
    const head = sh.nodes[0]
    if (head === undefined) continue
    sh.length += (lengthFor(world, sh.glow) - sh.length) * Math.min(1, dt * 0.5)
    const L = sh.length
    sh.glow += ((sh.isActive && sh.exit === null ? 1 : 0) - sh.glow) * Math.min(1, dt * 1.2)

    let dx = Math.cos(sh.heading)
    let dy = Math.sin(sh.heading)
    sh.wander = clamp(sh.wander + (Math.random() - 0.5) * dt * 3.2, -1.1, 1.1)
    dx += Math.cos(sh.heading + sh.wander) * 0.45
    dy += Math.sin(sh.heading + sh.wander) * 0.45

    if (sh.exit === null) {
      const rx = (head.x - cx) / (minSide > 0 ? W / minSide : 1)
      const ry = head.y - cy
      const r = Math.hypot(rx, ry) || 1
      const radius = sh.orbitRadius * minSide * (1 + 0.15 * Math.sin(world.time * 0.05 + sh.seed))
      const radial = clamp((radius - r) / radius, -1, 1)
      dx += ((-ry / r) * sh.orbitDir + (rx / r) * radial * 0.9) * 0.55
      dy += ((rx / r) * sh.orbitDir + (ry / r) * radial * 0.9) * 0.55

      const out = Math.max(-head.x, head.x - W, -head.y, head.y - H)
      if (out > -L * 0.05) {
        const w = clamp((out + L * 0.05) / (L * 0.35), 0, 1) * 3.5
        const toX = cx - head.x
        const toY = cy - head.y
        const d = Math.hypot(toX, toY) || 1
        dx += (toX / d) * w
        dy += (toY / d) * w
      }
    } else {
      dx += sh.exit.x * 3
      dy += sh.exit.y * 3
    }

    for (const other of world.sharks) {
      if (other === sh) continue
      for (let k = 0; k < other.nodes.length; k += 4) {
        const node = other.nodes[k]
        if (node === undefined) continue
        const ox = head.x - node.x
        const oy = head.y - node.y
        const d = Math.hypot(ox, oy)
        const range = (L + other.length) * 0.35
        if (d < range && d > 1e-3) {
          const w = (1 - d / range) * 3
          dx += (ox / d) * w
          dy += (oy / d) * w
        }
      }
    }

    const cruise = L * (0.13 + 0.09 * sh.glow) * look.speed * (sh.exit === null ? 1 : 1.5)
    sh.speed += (cruise - sh.speed) * Math.min(1, dt * 1.1)
    const agility = Math.min(0.8, sh.speed / (L * 0.22))
    const turned = clamp(angleDiff(sh.heading, Math.atan2(dy, dx)), -agility * dt, agility * dt)
    sh.heading += turned
    sh.turn += (turned / dt - sh.turn) * Math.min(1, dt * 3)
    head.x += Math.cos(sh.heading) * sh.speed * dt
    head.y += Math.sin(sh.heading) * sh.speed * dt
    sh.phase += dt * (2 + (sh.speed / L) * 6)

    // Follow the leader, each joint stiff enough that the body bends into a C at most.
    const seg = L / (NODES - 1)
    let previous = sh.heading + Math.PI
    for (let k = 1; k < sh.nodes.length; k++) {
      const a = sh.nodes[k - 1]
      const b = sh.nodes[k]
      if (a === undefined || b === undefined) continue
      const angle = previous + clamp(angleDiff(previous, Math.atan2(b.y - a.y, b.x - a.x)), -0.16, 0.16)
      b.x = a.x + Math.cos(angle) * seg
      b.y = a.y + Math.sin(angle) * seg
      previous = angle
    }
  }
  // A shark that has swum out is gone.
  world.sharks = world.sharks.filter(
    sh => sh.exit === null || sh.nodes.some(node => node.x > -2 && node.x < W + 2 && node.y > -2 && node.y < H + 2),
  )
}

function stepFish(world: World, dt: number): void {
  const { width: W, height: H, fish } = world
  for (const f of fish) {
    let ax = 0
    let ay = 0
    let n = 0
    let cx = 0
    let cy = 0
    let avx = 0
    let avy = 0
    for (const o of fish) {
      if (o === f) continue
      const dx = o.x - f.x
      const dy = o.y - f.y
      const d = Math.hypot(dx, dy)
      if (d < 1.6 && d > 1e-3) {
        ax -= (dx / d) * (1.6 - d) * 14
        ay -= (dy / d) * (1.6 - d) * 14
      }
      if (o.school === f.school && d < 8) {
        n += 1
        cx += o.x
        cy += o.y
        avx += o.vx
        avy += o.vy
      }
    }
    if (n > 0) {
      ax += (avx / n - f.vx) * 1.4 + (cx / n - f.x) * 0.9
      ay += (avy / n - f.vy) * 1.4 + (cy / n - f.y) * 0.9
    }
    // Sharks scatter the schools.
    for (const sh of world.sharks) {
      const r = sh.length * 0.3
      for (let k = 0; k < sh.nodes.length; k += 3) {
        const node = sh.nodes[k]
        if (node === undefined) continue
        const dx = f.x - node.x
        const dy = f.y - node.y
        const d = Math.hypot(dx, dy)
        if (d < r && d > 1e-3) {
          ax += (dx / d) * (1 - d / r) * 40
          ay += (dy / d) * (1 - d / r) * 40
        }
      }
    }
    const margin = 2.5
    if (f.x < margin) ax += (margin - f.x) * 8
    if (f.x > W - margin) ax -= (f.x - (W - margin)) * 8
    if (f.y < margin) ay += (margin - f.y) * 8
    if (f.y > H - margin) ay -= (f.y - (H - margin)) * 8
    // A slow current, so idle schools still drift about.
    ax += Math.sin(f.y * 0.11 + world.time * 0.3) * 1.2 + (Math.random() - 0.5) * 6
    ay += Math.cos(f.x * 0.09 - world.time * 0.25) * 1.2 + (Math.random() - 0.5) * 6

    const before = Math.atan2(f.vy, f.vx)
    f.vx += ax * dt
    f.vy += ay * dt
    const speed = Math.hypot(f.vx, f.vy) || 1
    const capped = clamp(speed, 2.2, 9)
    f.vx = (f.vx / speed) * capped
    f.vy = (f.vy / speed) * capped
    f.turn += (angleDiff(before, Math.atan2(f.vy, f.vx)) / dt - f.turn) * Math.min(1, dt * 5)
    f.x = clamp(f.x + f.vx * dt, 0.2, W - 0.2)
    f.y = clamp(f.y + f.vy * dt, 0.2, H - 0.2)
  }
}

function cellOf(world: World, x: number, y: number): number {
  const c = Math.floor(x)
  const r = Math.floor(y / world.aspect)

  return c < 0 || r < 0 || c >= world.cols || r >= world.rows ? -1 : r * world.cols + c
}

// Where things swim the water stirs, then settles and spreads.
function stepWake(world: World, dt: number): void {
  const { wake, cols, rows } = world
  for (const sh of world.sharks) {
    for (let k = 4; k < sh.nodes.length; k += 2) {
      const node = sh.nodes[k]
      const i = node === undefined ? -1 : cellOf(world, node.x, node.y)
      if (i >= 0) wake[i] = Math.min(1.4, (wake[i] ?? 0) + (0.1 + 0.25 * sh.glow) * dt * 10)
    }
  }
  for (const f of world.fish) {
    const i = cellOf(world, f.x, f.y)
    if (i >= 0) wake[i] = Math.min(1.4, (wake[i] ?? 0) + 0.04 * dt * 10)
  }
  const decay = Math.exp(-dt * 1.4)
  const next = new Float32Array(wake.length)
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c
      const left = c > 0 ? (wake[i - 1] ?? 0) : 0
      const right = c < cols - 1 ? (wake[i + 1] ?? 0) : 0
      const up = r > 0 ? (wake[i - cols] ?? 0) : 0
      const down = r < rows - 1 ? (wake[i + cols] ?? 0) : 0
      next[i] = ((wake[i] ?? 0) * 0.84 + (left + right + up + down) * 0.04) * decay
    }
  }
  world.wake = next
}

function step(world: World, dt: number): void {
  world.time += dt
  // No tank, nothing to swim in: a shark there would have no middle to circle.
  if (world.width <= 0 || world.height <= 0) return
  stepSharks(world, dt)
  stepFish(world, dt)
  stepWake(world, dt)
}

// ── drawing ───────────────────────────────────────────────────────────

type Grid = { ch: string[]; fg: string[]; bg: string[] }

type Pose = {
  shape: Shape
  L: number
  spine: Point[]
  arc: number[]
  total: number
  tipLeft: number
  tipRight: number
}

type Hit = { flag: number; shade: number; s: number; v: number; dist: number }

// Whether a point falls on the shark, and if so where and how lit (from ascii-sharks' sampleShark).
function sample(pose: Pose, px: number, py: number, hit: Hit): boolean {
  const { spine, arc, total, shape, L } = pose
  let best = Infinity
  let bestS = 0
  let sign = 1
  let nx = 0
  let ny = 0
  for (let k = 1; k < spine.length; k++) {
    const a = spine[k - 1]
    const b = spine[k]
    if (a === undefined || b === undefined) continue
    const sx = b.x - a.x
    const sy = b.y - a.y
    const len2 = sx * sx + sy * sy || 1
    const u = clamp(((px - a.x) * sx + (py - a.y) * sy) / len2, 0, 1)
    const d2 = (px - a.x - sx * u) ** 2 + (py - a.y - sy * u) ** 2
    if (d2 < best) {
      best = d2
      const len = Math.sqrt(len2)
      bestS = ((arc[k - 1] ?? 0) + u * len) / total
      sign = sx * (py - a.y) - sy * (px - a.x) >= 0 ? 1 : -1
      nx = (-sy / len) * sign
      ny = (sx / len) * sign
    }
  }

  const dist = Math.sqrt(best)
  const s = bestS
  const u = s * L
  const w = shape.halfWidth(s) * L * look.broad
  hit.dist = dist
  hit.s = s
  hit.v = dist * sign

  const head = shape.head
  if (head !== undefined && u < L * (head.sweep + head.depth + head.notch)) {
    const r = dist / (L * head.span * look.broad)
    const front = L * head.sweep * r * r + L * head.notch * Math.max(0, 1 - r / 0.14)
    const depth = L * head.depth * (1 - 0.2 * r ** 4)
    if (r <= 1 && u >= front && u <= front + depth) {
      // The eyes sit at the cephalofoil's tips.
      hit.flag = r > 0.84 ? FLAG_EYE : FLAG_BODY
      hit.shade = r > 0.84 ? 0 : 0.62 - 0.2 * r + (u < front + L * 0.012 ? 0.1 : 0)

      return true
    }
  }

  if (dist <= w) {
    const across = dist / (w || 1)
    // A rounded back lit from the top-left; the flanks fall off into shadow.
    const facing = (nx * -0.6 + ny * -0.8) * across
    let shade = 0.58 - across * across * 0.42 + facing * 0.26
    let flag = FLAG_BODY
    if (s > shape.dorsal[0] && s < shape.dorsal[1] && across < 0.3) {
      flag = FLAG_RIDGE
      shade = 1
    } else if (s > shape.secondDorsal[0] && s < shape.secondDorsal[1] && across < 0.4) {
      shade = Math.max(shade, 0.82)
    } else if (shape.eye !== null && s > shape.eye[0] && s < shape.eye[1] && across > 0.6) {
      flag = FLAG_EYE
      shade = 0
    } else if (s > shape.gills[0] && s < shape.gills[1] && across > 0.58) {
      if (Math.floor(((s - shape.gills[0]) / (shape.gills[1] - shape.gills[0])) * 5) % 2 === 0) shade *= 0.45
    } else if (s < 0.05) {
      shade = Math.max(shade, 0.7)
    } else if (shape.isBarred && isBar(s, dist * sign, L, across)) {
      flag = FLAG_MARK
    }
    hit.flag = flag
    hit.shade = shade

    return true
  }

  const tip = sign > 0 ? pose.tipRight : pose.tipLeft
  const [p0, p1, p2] = shape.pectoral
  if (
    inTriangle(u, dist, L * p0, 0, L * p1, 0, L * p2, tip) &&
    !(shape.falcate && inTriangle(u, dist, L * p1, 0, L * (p1 + (p2 - p1) * 0.33), tip * 0.55, L * p2, tip))
  ) {
    hit.flag = shape.isBarred && isBar(s, dist * sign, L, 0) ? FLAG_MARK : FLAG_FIN
    hit.shade = 0.38 + 0.22 * (1 - clamp(dist / tip, 0, 1))

    return true
  }
  const [v0, v1, v2, vr] = shape.pelvic
  if (
    inTriangle(u, dist, L * v0, 0, L * v1, 0, L * v2, L * vr * look.broad) ||
    (shape.caudal > 0 && inTriangle(u, dist, L * 0.86, 0, L * 0.95, 0, L, L * shape.caudal * look.broad))
  ) {
    hit.flag = FLAG_FIN
    hit.shade = 0.36

    return true
  }

  return false
}

// A tiger shark's wavy bars over the back half, fading out toward the head.
function isBar(s: number, v: number, L: number, across: number): boolean {
  if (s < 0.2 || s > 0.9 || across > 0.85) return false
  const wobble = 0.35 * Math.sin((v / L) * 25 + s * 5)

  return Math.sin(s * Math.PI * 2 * 9 + wobble) > 0.65 - 0.5 * smoothstep(0.2, 0.42, s) + 0.4 * smoothstep(0.8, 0.9, s)
}

function poseOf(sh: Shark): Pose {
  const L = sh.length
  const n = sh.nodes.length
  const swim = clamp(sh.speed / (L * 0.2), 0.4, 1.4)
  // A travelling body wave, growing toward the tail.
  const spine = sh.nodes.map((node, k) => {
    const s = k / (n - 1)
    const a = sh.nodes[Math.max(0, k - 1)] ?? node
    const b = sh.nodes[Math.min(n - 1, k + 1)] ?? node
    const tl = Math.hypot(a.x - b.x, a.y - b.y) || 1
    const tx = (a.x - b.x) / tl
    const ty = (a.y - b.y) / tl
    const off = L * 0.05 * (0.1 + 0.9 * Math.pow(s, 1.8)) * swim * Math.sin(sh.phase - s * 5.2)

    return { x: node.x - ty * off, y: node.y + tx * off }
  })
  const arc = [0]
  for (let k = 1; k < spine.length; k++) {
    const a = spine[k - 1]
    const b = spine[k]
    arc.push((arc[k - 1] ?? 0) + (a === undefined || b === undefined ? 0 : Math.hypot(b.x - a.x, b.y - a.y)))
  }
  const shape = SHAPES[sh.kind] ?? SHAPES.mako
  // Banking into a turn: the inside fin foreshortens, the outside one spreads.
  const bank = clamp(sh.turn * 0.45, -0.35, 0.35)
  const flex = 1 + 0.06 * Math.sin(sh.phase * 0.5)
  const reach = L * shape.pectoral[3] * flex * look.broad

  return { shape, L, spine, arc, total: arc[arc.length - 1] || 1, tipRight: reach * (1 - bank), tipLeft: reach * (1 + bank) }
}

function drawShark(world: World, grid: Grid, sh: Shark): void {
  if (world.detail > 4) return
  const pose = poseOf(sh)
  const { L } = pose
  const xs = pose.spine.map(p => p.x)
  const ys = pose.spine.map(p => p.y)
  const reach = L * 0.36 * look.broad
  const c0 = Math.max(0, Math.floor(Math.min(...xs) - reach))
  const c1 = Math.min(world.cols - 1, Math.floor(Math.max(...xs) + reach))
  const r0 = Math.max(0, Math.floor((Math.min(...ys) - reach) / world.aspect))
  const r1 = Math.min(world.rows - 1, Math.floor((Math.max(...ys) + reach) / world.aspect))
  // An idle shark is a paler shadow of itself on the paper, still clear enough to read its shape.
  const strength = look.idleStrength + (1 - look.idleStrength) * sh.glow
  const isShimmering = sh.glow > 0.5 && world.detail === 0
  const shades = world.detail > 2 ? 2 : world.detail > 1 ? 4 : 0
  // Drawing least, a shark is its glyphs alone, in one colour.
  const isOutline = world.detail > 3
  const outline = over(skinOf(sh.rgb, 0.3), strength)
  const tick = Math.floor(world.time * 2.4)
  const hit: Hit = { flag: 0, shade: 0, s: 0, v: 0, dist: 0 }

  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      const y = r * world.aspect
      const isCenter = sample(pose, c + 0.5, y + world.aspect / 2, hit)
      if (!isCenter && hit.dist > reach + 2.4) continue
      const { flag, shade, s, v } = hit
      let hits = isCenter ? 1 : 0
      for (const sub of SUBSAMPLES) if (sample(pose, c + sub.x, y + sub.y * world.aspect, hit)) hits += 1
      if (hits === 0) continue
      const coverage = hits / 5
      const i = r * world.cols + c
      // Keyed to the skin, so each glyph rides along with the body.
      const key = (hash3(Math.round(s * 52), Math.round(v / 0.9), sh.seed) * 4294967295) >>> 0
      const roll = hash3(key, tick + (key % 997), 7)

      if (!isCenter || coverage < 0.6) {
        // A soft, anti-aliased silhouette: no block, a light glyph.
        const set = coverage >= 0.5 ? EDGE_HEAVY : EDGE_LIGHT
        grid.ch[i] = set[(key >>> 8) % set.length] ?? '.'
        grid.fg[i] = isOutline ? outline : over(EDGE_RGB, (coverage >= 0.5 || world.detail > 2 ? 0.75 : 0.5) * strength)
        grid.bg[i] = ''
        continue
      }

      let level: number
      let glyph: string
      if (flag === FLAG_RIDGE) {
        level = 1.05
        glyph = RIDGE_GLYPHS[(key >>> 8) % RIDGE_GLYPHS.length] ?? '@'
      } else if (flag === FLAG_EYE) {
        level = 0
        glyph = 'o'
      } else if (flag === FLAG_MARK) {
        level = 0.12 + shade * 0.12
        glyph = MARK_GLYPHS[(key >>> 8) % MARK_GLYPHS.length] ?? '#'
      } else if (flag === FLAG_FIN) {
        level = 0.2 + shade * 0.6
        glyph = FIN_GLYPHS[(key >>> 8) % FIN_GLYPHS.length] ?? '%'
      } else {
        level = 0.24 + shade * 0.8
        const jitter = ((key >>> 4) % 3) - 1
        glyph = SKIN_RAMP[clamp(Math.floor((1 - shade) * 8.99) + jitter, 0, SKIN_RAMP.length - 1)] ?? 't'
      }
      grid.ch[i] = glyph
      if (isOutline) {
        grid.fg[i] = outline
        grid.bg[i] = ''
        continue
      }
      // Drawing less, the skin keeps fewer shades.
      grid.bg[i] = over(skinOf(sh.rgb, shades > 0 ? Math.round(level * shades) / shades : level), strength)
      // The hide shimmers while the shark works: now and then an accent or a white glyph.
      grid.fg[i] =
        flag === FLAG_EYE
          ? over([200, 204, 214], strength)
          : isShimmering && roll < look.shimmer * 0.73
            ? (ACCENTS[key % ACCENTS.length] ?? '#ffffff')
            : isShimmering && roll < look.shimmer
              ? '#ffffff'
              : over(shade > 0.55 || world.detail > 0 ? [14, 15, 19] : [27, 29, 36], strength)
    }
  }
}

// The tag goes beside the snout, above it or below, else nudged sideways: never over another tag.
function drawTag(world: World, grid: Grid, sh: Shark, taken: Set<number>): void {
  if (sh.exit !== null || sh.tag === '') return
  const head = sh.nodes[0]
  if (head === undefined) return
  const text = [...sh.tag].slice(0, Math.max(0, world.cols - 2))
  const headRow = Math.round(head.y / world.aspect)
  const rows = [headRow - 3, headRow + 3, headRow - 4, headRow + 4, headRow - 2, headRow + 2]
    .map(row => clamp(row, 0, world.rows - 1))
    .filter((row, k, all) => all.indexOf(row) === k)
  const home = Math.round(head.x - text.length / 2)
  const clampCol = (col: number) => clamp(col, 0, Math.max(0, world.cols - text.length))
  const isFree = (i: number) => !taken.has(i) && grid.bg[i] === ''
  const fits = (row: number, col: number) => text.every((_, k) => isFree(row * world.cols + col + k))
  let spot: { row: number; col: number } | undefined
  for (const shift of [0, -text.length - 1, text.length + 1]) {
    for (const row of rows) {
      if (spot === undefined && fits(row, clampCol(home + shift))) spot = { row, col: clampCol(home + shift) }
    }
  }
  // Nowhere clear: drawn over whatever is there, as a tag must be read.
  spot ??= rows[0] === undefined ? undefined : { row: rows[0], col: clampCol(home) }
  if (spot === undefined) return
  const color = over(sh.rgb, 0.55 + 0.45 * sh.glow)
  text.forEach((ch, k) => {
    const i = (spot?.row ?? 0) * world.cols + (spot?.col ?? 0) + k
    taken.add(i)
    grid.ch[i] = ch
    grid.fg[i] = color
    grid.bg[i] = ''
  })
}

function paint(world: World): Grid {
  const n = world.cols * world.rows
  const grid: Grid = { ch: new Array<string>(n).fill(' '), fg: new Array<string>(n).fill(''), bg: new Array<string>(n).fill('') }
  const t = world.time

  // A colour per kind of dot, the wake, the fish: few colours, so a row draws as few runs.
  const dotHex = DOT_RGB.map(rgb => over(rgb, clamp(0.45 * look.dotStrength, 0, 1)))
  const wakeHex = [over(WAKE_RGB, 0.45), over(WAKE_RGB, 0.75)]
  const fishHex = over(FISH_RGB, 0.6)

  // Dots twinkle on their own clocks under slow bands of light, and flare teal in the wake.
  for (let i = 0; i < n; i++) {
    const e = world.wake[i] ?? 0
    if (e > 0.3 && world.detail < 5) {
      grid.ch[i] = e > 0.8 ? ':' : '·'
      grid.fg[i] = wakeHex[e > 0.8 ? 1 : 0] ?? ''
      continue
    }
    if (world.detail > 0) continue
    const hex = dotHex[(world.dots[i] ?? 0) - 1]
    if (hex === undefined) continue
    const col = i % world.cols
    const row = Math.floor(i / world.cols)
    // A dot twinkles by coming and going on a slow wave, never by changing colour: dots side by
    // side share their colour, and so a run.
    const twinkle = 0.5 + 0.5 * Math.sin(t * 1.3 - col * 0.18 - row * 0.3 + (world.dotPhase[i] ?? 0))
    const caustic = 0.85 + 0.15 * Math.sin(col * 0.11 + t * 0.35) * Math.sin(row * 0.37 - t * 0.27)
    if (twinkle * caustic + e < 0.22) continue
    grid.ch[i] = '·'
    grid.fg[i] = hex
  }

  for (const f of world.detail > 1 ? [] : world.fish) {
    const i = cellOf(world, f.x, f.y)
    if (i < 0) continue
    // A hard turn glints.
    grid.ch[i] = '-'
    grid.fg[i] = Math.abs(f.turn) > 1.75 ? (wakeHex[1] ?? '') : fishHex
  }

  // Idle sharks below, sharks at work on top.
  const order = [...world.sharks].sort((a, b) => a.glow - b.glow)
  for (const sh of order) drawShark(world, grid, sh)
  const taken = new Set<number>()
  for (const sh of [...order].reverse()) drawTag(world, grid, sh, taken)

  return grid
}

type Elements = ClientSurface<State>['elements']

// One row as runs of one style: a blank joins the run before it unless that run has a block behind it.
// The row's commonest colour of text goes on the row itself, and a run in it, with nothing behind
// it, is a plain string: the tree stays small enough for the engine's bounds.
function rowOf(grid: Grid, cols: number, r: number, Text: Elements['Text']): RenderElement {
  const runs: { text: string; fg: string; bg: string }[] = []
  let text = ''
  let fg = ''
  let bg = ''
  let hasInk = false
  const flush = () => {
    if (text !== '') runs.push({ text, fg, bg })
    text = ''
    hasInk = false
  }
  for (let c = 0; c < cols; c++) {
    const i = r * cols + c
    const ch = grid.ch[i] ?? ' '
    const f = grid.fg[i] ?? ''
    const b = grid.bg[i] ?? ''
    if (ch === ' ' && b === '') {
      if (bg !== '') {
        flush()
        fg = ''
        bg = ''
      }
      text += ' '
      continue
    }
    if (!hasInk && bg === '' && b === '') {
      fg = f
    } else if (f !== fg || b !== bg) {
      flush()
      fg = f
      bg = b
    }
    text += ch
    hasInk = true
  }
  flush()

  const tally = new Map<string, number>()
  for (const run of runs) if (run.fg !== '' && run.bg === '') tally.set(run.fg, (tally.get(run.fg) ?? 0) + 1)
  let rowFg = ''
  let most = 0
  for (const [color, n] of tally) {
    if (n > most) {
      rowFg = color
      most = n
    }
  }
  const children: (RenderElement | string)[] = []
  for (const run of runs) {
    const last = children[children.length - 1]
    if (run.bg === '' && (run.fg === '' || run.fg === rowFg)) {
      if (typeof last === 'string') children[children.length - 1] = last + run.text
      else children.push(run.text)
    } else {
      children.push(Text({ ...(run.fg === '' ? {} : { color: run.fg }), ...(run.bg === '' ? {} : { backgroundColor: run.bg }), children: run.text }))
    }
  }

  return Text({ mono: true, size: 'caption', wrap: 'truncate', ...(rowFg === '' ? {} : { color: rowFg }), children })
}

export function frame(world: World, elements: Elements): RenderElement {
  const { Box, Text } = elements
  const grid = paint(world)
  const rows: RenderElement[] = []
  // Each row in a box one line tall that clips: the desktop wraps a Text of runs that comes out
  // too long, which would push every row below it down.
  for (let r = 0; r < world.rows; r++) rows.push(Box({ height: 1, overflow: 'hidden', children: [rowOf(grid, world.cols, r, Text)] }))

  return Box({ flexDirection: 'column', backgroundColor: look.paper, children: rows })
}

// The engine unmounts a Client whose tree serializes past 100,000 characters. Past this budget the
// tank draws less, and keeps to that until its size changes, so it does not flicker between the two.
const BUDGET = 85_000
const MAX_DETAIL = 5

// One level a frame, so no call draws the tank twice in full (the engine allows a call a second):
// a frame past the budget is shown bare, tags on paper, quick and small, and the next draws less.
export function framed(world: World, elements: Elements): RenderElement {
  const tree = frame(world, elements)
  if (world.detail >= MAX_DETAIL || JSON.stringify(tree).length <= BUDGET) return tree
  const next = world.detail + 1
  world.detail = MAX_DETAIL
  const bare = frame(world, elements)
  world.detail = next

  return bare
}

export { MAX_COLS, MAX_ROWS, MAX_SHARKS, newWorld, reconcile, resize, step }

const Tank: ClientModule<TankProps, State> = (props, surface) => {
  let state = surface.state
  if (state === undefined) {
    const world = newWorld()
    state = { world, frame: 0 }
    surface.every(TICK_MS, () => {
      // Narrower type than the region's own cells: the density says how many more fit across.
      // The desktop reports a Client's rows as what it has drawn so far, so the pane names them.
      // One column spare: a row a cell too long would otherwise spill.
      const { cols, rows } = fitted(
        Math.floor(surface.columns * world.density) - (world.density > 1 ? 1 : 0),
        world.wantRows > 0 ? world.wantRows : surface.rows,
      )
      if (cols > 0 && rows > 0 && (cols !== world.cols || rows !== world.rows)) resize(world, cols, rows)
      if (world.cols === 0) return
      reconcile(world)
      for (let k = 0; k < SUBSTEPS; k++) step(world, TICK_MS / 1000 / SUBSTEPS)
      surface.setState({ world, frame: (surface.state?.frame ?? 0) + 1 })
    })
    surface.setState(state)
  }
  // New props reach the running tank: the next tick swims the sharks toward them.
  state.world.wanted = wantedOf(props.sharks)
  state.world.density = props.density > 0 ? props.density : 1
  state.world.wantRows = props.rows > 0 ? Math.floor(props.rows) : 0
  if (props.aspect > 0 && props.aspect !== state.world.aspect) {
    state.world.aspect = props.aspect
    if (state.world.cols > 0) resize(state.world, state.world.cols, state.world.rows)
  }
  const { Box } = surface.elements

  return state.world.cols === 0 ? Box({ backgroundColor: look.paper, children: [] }) : framed(state.world, surface.elements)
}

export default Tank
