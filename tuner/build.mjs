// Builds tank.js for the tuner page from the mod's own hooks/tank.ts, its types stripped, so the
// page runs exactly the tank the pane runs. Run before opening the page: node tuner/build.mjs
import { readFileSync, writeFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'

const here = new URL('.', import.meta.url)
const source = readFileSync(new URL('../hooks/tank.ts', here), 'utf8')
writeFileSync(new URL('tank.js', here), `// Built from hooks/tank.ts by build.mjs: do not edit.\n${stripTypeScriptTypes(source)}`)
console.log('tuner/tank.js built')
