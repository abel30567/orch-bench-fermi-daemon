import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { ROOT } from './run-worker.mjs'

const POLL = join(ROOT, 'poll.sh')
const hasZsh = spawnSync('zsh', ['-c', 'true']).status === 0

const exe = (path, body) => {
  writeFileSync(path, body)
  chmodSync(path, 0o755)
  return path
}
// A fake `node`: answers --version with `version`, records its argv, and runs
// the script with the real node.
const fakeNode = (path, version, calls) =>
  exe(
    path,
    `#!/bin/sh\nif [ "$1" = --version ]; then echo ${version}; exit 0; fi\n` +
      `echo "${path} $*" >>"${calls}"\nexec "${process.execPath}" "$@"\n`,
  )

// Runs poll.sh in a throwaway HOME with the warm worker "down" (fake pgrep) and
// an empty queue (fake curl), so it takes the heartbeat fallback spawn.
// bin/run-once.mjs in the daemon home is `runOnce` (source text).
function poll({ pathNode, nodeBin, runOnce = 'console.log("run-once ok")\n' }) {
  const home = mkdtempSync(join(tmpdir(), 'dmn7-poll-'))
  const daemon = join(home, 'fermi-daemon')
  const fakebin = join(home, 'fakebin')
  for (const d of ['prompts', 'runs', 'logs', 'bin']) mkdirSync(join(daemon, d), { recursive: true })
  mkdirSync(fakebin)
  writeFileSync(join(daemon, 'prompts/heartbeat.md'), 'check in\n')
  writeFileSync(join(daemon, 'bin/run-once.mjs'), runOnce)
  const calls = join(home, 'node-calls')
  let env = 'FERMI_URL=http://127.0.0.1:9\nFERMI_BEARER_TOKEN=t\n'
  if (nodeBin) env += `NODE_BIN=${fakeNode(join(home, 'node-from-env'), nodeBin, calls)}\n`
  writeFileSync(join(daemon, '.env'), env)
  exe(join(fakebin, 'pgrep'), '#!/bin/sh\nexit 1\n')
  exe(join(fakebin, 'curl'), '#!/bin/sh\necho \'{"pending":0}\'\n')
  if (pathNode) fakeNode(join(fakebin, 'node'), pathNode, calls)
  const r = spawnSync('zsh', [POLL], {
    env: { PATH: `${fakebin}:${process.env.PATH}`, HOME: home },
    encoding: 'utf8',
  })
  const read = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : '')
  return {
    ...r,
    daemon,
    pollLog: read(join(daemon, 'logs/poll.log')),
    lanes: existsSync(join(daemon, 'lanes')) ? readdirSync(join(daemon, 'lanes')) : [],
    runs: () => readdirSync(join(daemon, 'runs')),
    runLog: () => {
      const [f] = readdirSync(join(daemon, 'runs'))
      return f ? read(join(daemon, 'runs', f)) : ''
    },
    calls: () => read(calls),
  }
}

async function until(fn, ms = 10000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (fn()) return true
    await sleep(50)
  }
  return false
}

describe('poll.sh cold path node check', { skip: !hasZsh && 'zsh not installed' }, () => {
  test('AC1: node v14 on PATH logs the error line, exits non-zero, spawns nothing', () => {
    const r = poll({ pathNode: 'v14.21.3' })
    assert.notEqual(r.status, 0)
    const node = join(r.daemon, '..', 'fakebin', 'node')
    assert.ok(
      r.pollLog.includes(
        `ERROR: node '${node}' is v14.21.3; bin/run-once.mjs needs node >= 22 (set NODE_BIN in .env) — not spawning heartbeat.md`,
      ),
      r.pollLog,
    )
    assert.equal(r.pollLog.match(/ERROR/g).length, 1, r.pollLog)
    assert.doesNotMatch(r.pollLog, /spawned/)
    assert.deepEqual(r.lanes, [])
    assert.deepEqual(r.runs(), [])
    assert.equal(r.calls(), '')
  })

  test('AC2: NODE_BIN from .env wins over node on PATH', async () => {
    const r = poll({ pathNode: 'v14.21.3', nodeBin: 'v22.3.0' })
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.pollLog, /spawned heartbeat\.md in lane 1/)
    assert.doesNotMatch(r.pollLog, /ERROR/)
    assert.ok(await until(() => r.runLog().includes('run-once ok')), r.runLog())
    const calls = r.calls()
    assert.match(calls, /node-from-env .*bin\/run-once\.mjs --prompt prompts\/heartbeat\.md/)
    assert.doesNotMatch(calls, /fakebin\/node/)
  })

  test('AC2: too-old NODE_BIN is refused', () => {
    const r = poll({ pathNode: 'v22.3.0', nodeBin: 'v20.11.1' })
    assert.notEqual(r.status, 0)
    assert.match(r.pollLog, /ERROR: node '.*node-from-env' is v20\.11\.1; .* — not spawning heartbeat\.md/)
    assert.deepEqual(r.lanes, [])
    assert.equal(r.calls(), '')
  })

  test('AC3: a crashing run-once leaves its error in runs/<ts>.log', async () => {
    const r = poll({
      pathNode: 'v22.3.0',
      runOnce: 'console.error("run-once: about to crash")\nthrow new Error("kaboom from run-once")\n',
    })
    assert.equal(r.status, 0, r.stderr)
    assert.ok(await until(() => r.runs().length === 1), 'one run log')
    const [log] = r.runs()
    assert.match(log, /^\d{8}-\d{6}-\d+-\d+\.log$/)
    assert.match(r.pollLog, new RegExp(`log runs/${log.replace(/\./g, '\\.')}`))
    assert.ok(await until(() => /Error: kaboom from run-once/.test(r.runLog())), r.runLog())
    assert.match(r.runLog(), /run-once: about to crash/)
  })
})
