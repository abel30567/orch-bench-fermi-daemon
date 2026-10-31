// poll.sh cold path: node resolution ($NODE_BIN, else PATH), the node >= 22
// check, and run-once's own output landing in runs/<ts>.log. Runs the real
// poll.sh under zsh in a throwaway $HOME/fermi-daemon with fake curl/pgrep
// (warm worker down, nothing pending → heartbeat fallback spawn) and a fake
// bin/run-once.mjs. No network, no real harness.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, chmodSync, copyFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { ROOT } from './run-worker.mjs'

const ZSH = ['/bin/zsh', '/usr/bin/zsh'].find(existsSync)

function exe(path, body) {
  writeFileSync(path, body)
  chmodSync(path, 0o755)
}

// A daemon home whose bin/run-once.mjs is `runOnce` (JS source). Returns paths
// plus run(env) → spawnSync result of poll.sh.
function setup({ runOnce = 'process.exit(0)\n', pathNode } = {}) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'dmn7-poll-')))
  const daemon = join(home, 'fermi-daemon')
  const fakebin = join(home, 'fakebin')
  for (const d of [daemon, fakebin, join(daemon, 'bin'), join(daemon, 'prompts')]) mkdirSync(d, { recursive: true })
  copyFileSync(join(ROOT, 'poll.sh'), join(daemon, 'poll.sh'))
  writeFileSync(join(daemon, 'prompts/heartbeat.md'), 'check in\n')
  writeFileSync(join(daemon, 'bin/run-once.mjs'), runOnce)
  exe(join(fakebin, 'curl'), '#!/bin/sh\nexit 7\n') // Fermi unreachable → 0 pending
  exe(join(fakebin, 'pgrep'), '#!/bin/sh\nexit 1\n') // warm worker down
  if (pathNode) exe(join(fakebin, 'node'), pathNode)
  const run = (dotenv = '') => {
    writeFileSync(join(daemon, '.env'), `FERMI_URL=http://127.0.0.1:9\nFERMI_BEARER_TOKEN=test\n${dotenv}`)
    return spawnSync(ZSH, [join(daemon, 'poll.sh')], {
      env: { HOME: home, PATH: `${fakebin}:/usr/bin:/bin:/usr/sbin:/sbin` },
      encoding: 'utf8',
      timeout: 30_000,
    })
  }
  const pollLog = () => (existsSync(join(daemon, 'logs/poll.log')) ? readFileSync(join(daemon, 'logs/poll.log'), 'utf8') : '')
  const lanes = () => (existsSync(join(daemon, 'lanes')) ? readdirSync(join(daemon, 'lanes')) : [])
  const runLogs = () => (existsSync(join(daemon, 'runs')) ? readdirSync(join(daemon, 'runs')).filter((f) => f.endsWith('.log')) : [])
  return { home, daemon, fakebin, run, pollLog, lanes, runLogs }
}

async function waitFor(fn, ms = 10_000) {
  const end = Date.now() + ms
  for (;;) {
    const v = fn()
    if (v) return v
    if (Date.now() > end) return v
    await sleep(50)
  }
}

describe('poll.sh cold path node check', { skip: !ZSH && 'zsh not installed' }, () => {
  test('node v14 on PATH: one error line in poll.log, non-zero exit, no lane, no spawn', () => {
    const d = setup({ pathNode: '#!/bin/sh\necho v14.21.3\n' })
    const r = d.run()
    assert.notEqual(r.status, 0, r.stderr)
    const errors = d.pollLog().split('\n').filter((l) => l.includes('ERROR:'))
    assert.equal(errors.length, 1, d.pollLog())
    assert.ok(
      errors[0].endsWith(
        `ERROR: node '${d.fakebin}/node' is v14.21.3; bin/run-once.mjs needs node >= 22 (set NODE_BIN in .env) — not spawning heartbeat.md`,
      ),
      errors[0],
    )
    assert.doesNotMatch(d.pollLog(), /spawned/)
    assert.deepEqual(d.lanes(), [])
    assert.deepEqual(d.runLogs(), [])
  })

  test('no node at all: error line, non-zero exit, no lane', () => {
    const d = setup()
    const r = d.run()
    assert.notEqual(r.status, 0, r.stderr)
    assert.match(d.pollLog(), /ERROR: node 'node' not found; bin\/run-once\.mjs needs node >= 22 \(set NODE_BIN in \.env\) — not spawning heartbeat\.md/)
    assert.deepEqual(d.lanes(), [])
  })

  test('NODE_BIN from .env wins over an old PATH node and runs run-once', async () => {
    const marker = 'ran.json'
    const d = setup({
      pathNode: '#!/bin/sh\necho v14.21.3\n',
      runOnce: `import { writeFileSync } from 'node:fs'\nwriteFileSync(${JSON.stringify(marker)}, JSON.stringify({ node: process.env.VIA_NODE_BIN, argv: process.argv.slice(2) }))\n`,
    })
    const nodeBin = join(d.home, 'my-node')
    exe(nodeBin, `#!/bin/sh\nVIA_NODE_BIN=1 exec "${process.execPath}" "$@"\n`)
    const r = d.run(`NODE_BIN=${nodeBin}\n`)
    assert.equal(r.status, 0, r.stderr)
    assert.doesNotMatch(d.pollLog(), /ERROR/)
    assert.match(d.pollLog(), /spawned heartbeat\.md in lane 1/)
    const ran = await waitFor(() => existsSync(join(d.daemon, marker)) && readFileSync(join(d.daemon, marker), 'utf8'))
    assert.ok(ran, 'run-once never ran')
    const { node, argv } = JSON.parse(ran)
    assert.equal(node, '1')
    assert.ok(argv.includes('--session') && argv.includes('prompts/heartbeat.md'), argv.join(' '))
  })

  test("a crashing run-once leaves its error in runs/<ts>.log", async () => {
    const d = setup({ runOnce: "throw new Error('run-once exploded DMN7')\n" })
    const r = d.run(`NODE_BIN=${process.execPath}\n`)
    assert.equal(r.status, 0, r.stderr)
    const logs = await waitFor(() => d.runLogs().length && d.runLogs())
    assert.equal(logs.length, 1, d.pollLog())
    assert.ok(d.pollLog().includes(`log runs/${logs[0]})`), d.pollLog())
    const text = await waitFor(() => {
      const t = readFileSync(join(d.daemon, 'runs', logs[0]), 'utf8')
      return t.includes('run-once exploded DMN7') && t
    })
    assert.ok(text, 'crash not in run log')
  })
})
