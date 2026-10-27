import { expect, test } from 'claude-code/testing'

import { framed, newWorld, reconcile, resize, step } from '../hooks/tank'

// Elements as the engine keeps them: a type and its props, children among them.
const ELEMENTS = {
  Box: (props: object) => ({ type: 'Box', props }),
  Text: (props: object) => ({ type: 'Text', props }),
} as never

const WORKING = [
  { id: 'codex', kind: 'hammer', color: '#4C9AF5', tag: '1 Codex', isActive: true },
  { id: 'agy', kind: 'tiger', color: '#34A877', tag: '2 Antigravity', isActive: true },
  { id: 'claude', kind: 'mako', color: '#CC7B5C', tag: '3 Explore', isActive: true },
  { id: 'extra', kind: 'mako', color: '#DCA591', tag: '4 Plan', isActive: true },
] as const

// The engine unmounts a Client whose tree serializes past 100,000 characters.
test('a tank as big as a wide pane, four sharks at work, stays inside the engine\'s bounds', () => {
  for (const [cols, rows] of [
    [71, 60],
    [140, 100],
  ] as const) {
    const world = newWorld()
    world.aspect = 2.5
    resize(world, cols, rows)
    world.wanted = WORKING
    let largest = 0
    for (let k = 0; k < 50; k++) {
      reconcile(world)
      step(world, 0.05)
      step(world, 0.05)
      largest = Math.max(largest, JSON.stringify(framed(world, ELEMENTS)).length)
    }
    expect(largest).toBeLessThan(100_000)
  }
})
