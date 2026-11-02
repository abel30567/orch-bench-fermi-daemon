import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ROOT } from './run-worker.mjs'

const POLL = join(ROOT, 'poll.sh')

const script = (path, body) => {
  writeFileSync(path, `#!/bin/sh\n${body}\n`)
  chmodSync(path, 0o755)
}

// A fake node that reports `version` and records how it was invoked (it never
// runs anything, so no harness is ever spawned).
const fakeNode = (path, version) =>
  script(path, `[ "$1" = --version ] && { echo v${version}; exit 0; }\necho "$0 $*" >>"${path}.calls"`)

// Runs poll.sh with HOME = a temp dir holding a fake daemon home, and a PATH
// whose first entry shims out pgrep (warm worker down), curl (no network; 0
// pending, so the heartbeat fallback spawns) and optionally node.
function runPoll({ env = '', pathNode, runOnce } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'poll-'))
  const d = join(home, 'fermi-daemon')
  const fakebin = join(home, 'fakebin')
  for (const sub of ['logs', 'runs', 'prompts', 'bin', 'fakebin']) mkdirSync(join(sub === 'fakebin' ? home : d, sub), { recursive: true })
  writeFileSync(join(d, '.env'), `FERMI_URL=http://127.0.0.1:9\nFERMI_BEARER_TOKEN=test\n${env}`)
  writeFileSync(join(d, 'prompts/heartbeat.md'), 'check in\n')
  if (runOnce) writeFileSync(join(d, 'bin/run-once.mjs'), runOnce)
  script(join(fakebin, 'pgrep'), 'exit 1')
  script(join(fakebin, 'curl'), `echo '{"pending":0}'`)
  if (pathNode) fakeNode(join(fakebin, 'node'), pathNode)
  const r = spawnSync('zsh', [POLL], {
    env: { HOME: home, PATH: `${fakebin}:${process.env.PATH}` },
    encoding: 'utf8',
  })
  const pollLog = existsSync(join(d, 'logs/poll.log')) ? readFileSync(join(d, 'logs/poll.log'), 'utf8') : ''
  return { home, d, fakebin, code: r.status, stderr: r.stderr, pollLog, lanes: readdirSync(join(d, 'lanes')) }
}

describe('poll.sh cold path: node resolution', () => {
  test('node v14 on PATH: one ERROR line in poll.log, non-zero exit, no lane, no spawn', () => {
    const r = runPoll({ pathNode: '14.21.3' })
    assert.notEqual(r.code, 0)
    const lines = r.pollLog.trim().split('\n').filter((l) => !/heartbeat: spawning/.test(l))
    assert.equal(lines.length, 1, r.pollLog)
    assert.ok(
      lines[0].endsWith(
        `ERROR: node '${join(r.fakebin, 'node')}' is v14.21.3; bin/run-once.mjs needs node >= 22 (set NODE_BIN in .env) — not spawning heartbeat.md`,
      ),
      r.pollLog,
    )
    assert.doesNotMatch(r.pollLog, /spawned/)
    assert.deepEqual(r.lanes, [])
    assert.ok(!existsSync(join(r.fakebin, 'node.calls')), 'old node never ran run-once')
    assert.deepEqual(readdirSync(join(r.d, 'runs')), [])
  })

  test('NODE_BIN from .env is used instead of the node on PATH', () => {
    const home = mkdtempSync(join(tmpdir(), 'poll-nb-'))
    const good = join(home, 'node22')
    fakeNode(good, '22.12.0')
    const r = runPoll({ pathNode: '14.21.3', env: `NODE_BIN=${good}\n` })
    assert.equal(r.code, 0, r.pollLog)
    assert.match(r.pollLog, /spawned heartbeat\.md in lane 1/)
    assert.doesNotMatch(r.pollLog, /ERROR/)
    for (let t0 = Date.now(); !existsSync(`${good}.calls`) && Date.now() - t0 < 5000; ) spawnSync('sleep', ['0.05'])
    assert.match(readFileSync(`${good}.calls`, 'utf8'), /bin\/run-once\.mjs --prompt prompts\/heartbeat\.md/)
    assert.ok(!existsSync(join(r.fakebin, 'node.calls')), 'PATH node not used')
  })

  test('a too-old NODE_BIN fails loudly even when PATH has a good node', () => {
    const home = mkdtempSync(join(tmpdir(), 'poll-nb-'))
    const old = join(home, 'node18')
    fakeNode(old, '18.20.4')
    const r = runPoll({ pathNode: '22.12.0', env: `NODE_BIN=${old}\n` })
    assert.notEqual(r.code, 0)
    assert.match(r.pollLog, new RegExp(`ERROR: node '${old}' is v18\\.20\\.4; .* not spawning heartbeat\\.md$`, 'm'))
    assert.deepEqual(r.lanes, [])
  })
})

describe('poll.sh cold path: run-once output', () => {
  test('a crashing run-once leaves its error in runs/<ts>.log', () => {
    const r = runPoll({
      env: `NODE_BIN=${process.execPath}\n`,
      runOnce: `console.log('run-once starting')\nthrow new Error('boom: run-once crashed')\n`,
    })
    assert.equal(r.code, 0, r.pollLog)
    const logName = r.pollLog.match(/log runs\/(\S+\.log)\)/)?.[1]
    assert.ok(logName, r.pollLog)
    const logFile = join(r.d, 'runs', logName)
    let log = ''
    for (let t0 = Date.now(); !/boom: run-once crashed/.test(log) && Date.now() - t0 < 5000; ) {
      spawnSync('sleep', ['0.05'])
      log = existsSync(logFile) ? readFileSync(logFile, 'utf8') : ''
    }
    assert.match(log, /run-once starting/)
    assert.match(log, /Error: boom: run-once crashed/)
  })
})
