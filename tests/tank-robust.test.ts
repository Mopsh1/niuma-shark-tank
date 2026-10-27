import { expect, test } from 'claude-code/testing'

import Tank, { LOOK, MAX_COLS, MAX_ROWS, MAX_SHARKS, framed, newWorld, reconcile, resize, setLook, step } from '../hooks/tank'

// Elements as the engine keeps them: a type and its props, children among them.
const ELEMENTS = {
  Box: (props: object) => ({ type: 'Box', props }),
  Text: (props: object) => ({ type: 'Text', props }),
} as never

type World = ReturnType<typeof newWorld>
type Node = { props?: { children?: unknown } }

// The engine unmounts a Client whose tree passes 100,000 characters, 20,000 nodes or 32 deep.
function expectInBounds(tree: unknown): void {
  let nodes = 0
  let depth = 0
  const walk = (node: unknown, at: number) => {
    if (typeof node !== 'object' || node === null) return
    nodes += 1
    depth = Math.max(depth, at)
    const children = (node as Node).props?.children
    for (const child of Array.isArray(children) ? children : [children]) walk(child, at + 1)
  }
  walk(tree, 1)
  expect(JSON.stringify(tree).length).toBeLessThan(100_000)
  expect(nodes).toBeLessThan(20_000)
  expect(depth).toBeLessThanOrEqual(32)
}

function isFiniteWorld(world: World): boolean {
  const isPoint = (p: { x: number; y: number }) => Number.isFinite(p.x) && Number.isFinite(p.y)

  return (
    world.sharks.every(sh => Number.isFinite(sh.heading) && Number.isFinite(sh.length) && sh.nodes.every(isPoint)) &&
    world.fish.every(isPoint)
  )
}

// Loosely typed on purpose: the tests hand the tank kinds and fields it must cope with.
const shark = (id: string, extra: object = {}) => ({ id, kind: 'hammer', color: '#4C9AF5', tag: id, isActive: true, ...extra }) as never

function swim(world: World, ticks: number): void {
  for (let k = 0; k < ticks; k++) {
    reconcile(world)
    step(world, 0.05)
    step(world, 0.05)
  }
}

// The tank module on a stand-in surface: its timers run when the test ticks them.
function mounted(columns: number, rows: number) {
  const timers: (() => void)[] = []
  const surface = {
    elements: ELEMENTS,
    state: undefined as unknown,
    columns,
    rows,
    setState(next: unknown) {
      surface.state = next
    },
    every(_ms: number, fn: () => void) {
      timers.push(fn)

      return () => undefined
    },
    onPointer: () => () => undefined,
    onKey: () => () => undefined,
    post: () => undefined,
  }

  return {
    surface,
    world: () => (surface.state as { world: World }).world,
    draw: (props: unknown) => (Tank as (p: unknown, s: unknown) => unknown)(props, surface),
    tick: (n: number) => {
      for (let k = 0; k < n; k++) for (const fn of timers) fn()
    },
  }
}

test('any size draws, from none at all to past the most it draws', () => {
  for (const [cols, rows] of [
    [0, 0],
    [1, 1],
    [2, 3],
    [-5, -5],
    [Number.NaN, 10],
    [300, 4],
    [4, 200],
    [500, 400],
  ] as const) {
    const world = newWorld()
    world.aspect = 2.5
    resize(world, cols, rows)
    expect(world.cols).toBeLessThanOrEqual(MAX_COLS)
    expect(world.rows).toBeLessThanOrEqual(MAX_ROWS)
    world.wanted = [shark('a'), shark('b', { kind: 'tiger', isActive: false })]
    for (let k = 0; k < 20; k++) {
      swim(world, 1)
      expectInBounds(framed(world, ELEMENTS))
    }
    expect(isFiniteWorld(world)).toBe(true)
  }
})

test('props of any shape: the tank draws what it can of them', () => {
  const odd = [
    {},
    { sharks: 'oops' },
    { sharks: null, rows: 'x', density: Number.NaN, aspect: -1 },
    { sharks: [null, 5, 'a', {}, { id: 3, kind: 'whale', color: 7, tag: null, isActive: 'yes' }], rows: 20, density: 1.15, aspect: 2.5 },
    { sharks: [shark('a', { color: 'red' }), shark('b', { color: '' }), shark('c', { tag: 'x'.repeat(300) }), shark('d', { tag: '中文標籤🦈' })], rows: 30 },
    { sharks: [shark('dup'), shark('dup'), shark('dup', { kind: 'tiger' })], rows: 30 },
    { sharks: Array.from({ length: 40 }, (_, k) => shark(`s${k}`)), rows: 1e6, density: 1e3, aspect: 1e3 },
  ]
  for (const props of odd) {
    const tank = mounted(60, 30)
    tank.draw(props)
    tank.tick(20)
    expectInBounds(tank.draw(props))
    expect(tank.world().sharks.length).toBeLessThanOrEqual(MAX_SHARKS)
    expect(isFiniteWorld(tank.world())).toBe(true)
  }
})

test('a region that changes size mid-swim', () => {
  const tank = mounted(70, 40)
  const props = { sharks: [shark('a'), shark('b', { kind: 'mako' })], rows: 40, density: 1.15, aspect: 2.5 }
  tank.draw(props)
  for (const [columns, rows] of [
    [20, 10],
    [150, 90],
    [0, 0],
    [60, 30],
  ] as const) {
    tank.surface.columns = columns
    tank.tick(15)
    expectInBounds(tank.draw({ ...props, rows }))
    expect(isFiniteWorld(tank.world())).toBe(true)
  }
})

test('the look at its extremes still draws', () => {
  const extremes = [
    { activeSize: 0, idleSize: 0 },
    { activeSize: 3, idleSize: 3 },
    { broad: 0.1 },
    { broad: 4 },
    { dotShare: 0 },
    { dotShare: 1 },
    { speed: 0 },
    { speed: 6 },
    { tint: 1, shimmer: 1, idleStrength: 0 },
    { paper: 'not a colour' },
  ]
  try {
    for (const one of extremes) {
      setLook(one)
      const world = newWorld()
      world.aspect = 2.5
      resize(world, 71, 60)
      world.wanted = [shark('a'), shark('b', { kind: 'tiger', isActive: false })]
      for (let k = 0; k < 30; k++) {
        swim(world, 1)
        expectInBounds(framed(world, ELEMENTS))
      }
      expect(isFiniteWorld(world)).toBe(true)
      setLook(LOOK)
    }
  } finally {
    setLook(LOOK)
  }
})

test('a long run: sharks come and go, stay finite and inside the bounds, and all swim off at the end', () => {
  const world = newWorld()
  world.aspect = 2.5
  resize(world, 71, 60)
  for (let k = 0; k < 1500; k++) {
    if (k % 40 === 0) {
      const extras = Array.from({ length: k % 5 }, (_, j) => shark(`x${k}-${j}`, { kind: 'mako' }))
      world.wanted = [shark('codex', { isActive: k % 80 === 0 }), shark('agy', { kind: 'tiger', isActive: k % 120 === 0 }), ...extras]
    }
    swim(world, 1)
    if (k % 25 === 0) expectInBounds(framed(world, ELEMENTS))
    expect(world.sharks.length).toBeLessThanOrEqual(MAX_SHARKS * 2)
  }
  expect(isFiniteWorld(world)).toBe(true)

  world.wanted = []
  swim(world, 600)
  expect(world.sharks).toHaveLength(0)
})

test('the largest tank with the most sharks: every frame inside the bounds and well under the engine\'s second', () => {
  const world = newWorld()
  world.aspect = 2.5
  resize(world, 500, 400)
  world.wanted = Array.from({ length: 40 }, (_, k) => shark(`s${k}`, { kind: ['hammer', 'tiger', 'mako'][k % 3] }))
  let slowest = 0
  for (let k = 0; k < 40; k++) {
    swim(world, 1)
    const started = performance.now()
    const tree = framed(world, ELEMENTS)
    slowest = Math.max(slowest, performance.now() - started)
    expectInBounds(tree)
  }
  expect(world.sharks.length).toBeLessThanOrEqual(MAX_SHARKS)
  expect(slowest).toBeLessThan(500)
})
