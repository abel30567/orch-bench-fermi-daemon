// poll.sh cold path: node resolution ($NODE_BIN, else PATH), the >= 22 check,
// and run-once's stdout/stderr landing in runs/<ts>.log.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ROOT } from './run-worker.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const exe = (path, body) => {
  writeFileSync(path, `#!/bin/sh\n${body}\n`)
  chmodSync(path, 0o755)
}
const fakeNode = (path, version, marker) =>
  exe(path, `if [ "$1" = "-v" ]; then echo ${version}; exit 0; fi\n${marker ? `echo "$@" > "${marker}"` : ''}`)

// A daemon home with the warm worker down (fake pgrep) and one pending task
// (fake curl), so poll.sh takes the reactive cold-spawn path for drain.md.
function setup({ env = '', pathNode = 'v22.11.0', runOnce = 'process.exit(0)\n' } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'poll-'))
  const d = join(home, 'fermi-daemon')
  for (const sub of ['bin', 'logs', 'runs', 'prompts', 'fakebin']) mkdirSync(join(d, sub), { recursive: true })
  writeFileSync(join(d, '.env'), `FERMI_URL=http://fermi.invalid\nFERMI_BEARER_TOKEN=t\n${env}`)
  writeFileSync(join(d, 'prompts/drain.md'), 'drain\n')
  writeFileSync(join(d, 'bin/run-once.mjs'), runOnce)
  exe(join(d, 'fakebin/pgrep'), 'exit 1')
  exe(join(d, 'fakebin/curl'), `echo '{"pending":1}'`)
  exe(join(d, 'fakebin/python3'), 'exit 0') // narrator
  if (pathNode) fakeNode(join(d, 'fakebin/node'), pathNode, join(d, 'path-node-ran'))
  const r = spawnSync('zsh', [join(ROOT, 'poll.sh')], {
    env: { HOME: home, PATH: `${join(d, 'fakebin')}:/usr/bin:/bin:/usr/sbin:/sbin` },
    encoding: 'utf8',
  })
  const pollLog = () => (existsSync(join(d, 'logs/poll.log')) ? readFileSync(join(d, 'logs/poll.log'), 'utf8') : '')
  return { d, status: r.status, pollLog, lanes: () => readdirSync(join(d, 'lanes')) }
}

async function waitFor(fn, ms = 5000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const v = fn()
    if (v) return v
    await sleep(50)
  }
  return fn()
}

describe('poll.sh node resolution', () => {
  test('node v14 on PATH: one poll.log error line, non-zero exit, no lane, no spawn', () => {
    const p = setup({ pathNode: 'v14.21.3' })
    assert.notEqual(p.status, 0)
    const errors = p.pollLog().split('\n').filter((l) => l.includes('ERROR'))
    assert.equal(errors.length, 1, p.pollLog())
    assert.ok(
      errors[0].endsWith(
        `ERROR: node '${join(p.d, 'fakebin/node')}' is v14.21.3; bin/run-once.mjs needs node >= 22 (set NODE_BIN in .env) — not spawning drain.md`,
      ),
      errors[0],
    )
    assert.deepEqual(p.lanes(), [])
    assert.ok(!existsSync(join(p.d, 'path-node-ran')))
    assert.doesNotMatch(p.pollLog(), /spawned/)
  })

  test('NODE_BIN from .env is honoured over PATH node', async () => {
    const home = mkdtempSync(join(tmpdir(), 'nodebin-'))
    const nodeBin = join(home, 'my-node')
    const marker = join(home, 'node-bin-ran')
    fakeNode(nodeBin, 'v22.3.0', marker)
    const p = setup({ env: `NODE_BIN=${nodeBin}\n`, pathNode: 'v14.21.3' })
    assert.equal(p.status, 0, p.pollLog())
    assert.match(p.pollLog(), /spawned drain\.md in lane 1/)
    assert.match(await waitFor(() => existsSync(marker) && readFileSync(marker, 'utf8')), /bin\/run-once\.mjs --prompt prompts\/drain\.md/)
    assert.ok(!existsSync(join(p.d, 'path-node-ran')))
  })

  test('NODE_BIN pointing at an old node fails loudly', () => {
    const home = mkdtempSync(join(tmpdir(), 'nodebin-'))
    const nodeBin = join(home, 'old-node')
    fakeNode(nodeBin, 'v20.1.0')
    const p = setup({ env: `NODE_BIN=${nodeBin}\n` })
    assert.notEqual(p.status, 0)
    assert.match(p.pollLog(), new RegExp(`ERROR: node '${nodeBin}' is v20\\.1\\.0; .* not spawning drain\\.md`))
    assert.deepEqual(p.lanes(), [])
  })

  const systemNode = ['/usr/bin/node', '/bin/node', '/usr/sbin/node', '/sbin/node'].some(existsSync)
  test('no node at all fails loudly', { skip: systemNode && 'node in a system dir' }, () => {
    const p = setup({ pathNode: null })
    assert.notEqual(p.status, 0)
    assert.match(p.pollLog(), /ERROR: node 'node' is vunknown; .* not spawning drain\.md/)
    assert.deepEqual(p.lanes(), [])
  })
})

describe('poll.sh run-once output', () => {
  test('a crashing run-once leaves its error in runs/<ts>.log', async () => {
    const p = setup({
      env: `NODE_BIN=${process.execPath}\n`,
      runOnce: `console.log('run-once stdout line')\nthrow new Error('boom from run-once')\n`,
    })
    assert.equal(p.status, 0, p.pollLog())
    const ts = p.pollLog().match(/log runs\/(\S+)\.log/)?.[1]
    assert.ok(ts, p.pollLog())
    const logPath = join(p.d, 'runs', `${ts}.log`)
    const log = await waitFor(() => existsSync(logPath) && /boom from run-once/.test(readFileSync(logPath, 'utf8')) && readFileSync(logPath, 'utf8'))
    assert.match(log, /Error: boom from run-once/)
    assert.match(log, /run-once stdout line/)
  })
})
