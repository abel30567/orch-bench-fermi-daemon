import { test, describe, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, chmodSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ROOT } from './run-worker.mjs'

// Long-lived processes standing in for running lane workers.
const sleepers = []
after(() => sleepers.forEach((p) => p.kill('SIGKILL')))
const livePid = () => {
  const p = spawn('sleep', ['60'], { stdio: 'ignore' })
  sleepers.push(p)
  return p.pid
}
const deadPid = () => {
  const r = spawnSync('true')
  return r.pid
}

// Fake bins shared by every run: freshly written scripts are slow to exec the
// first time on macOS, so write them once. The warm worker is down (pgrep), the
// queue reports $FAKE_PENDING tasks (curl), and the fake node only answers -v.
const bin = mkdtempSync(join(tmpdir(), 'dmn7-lanes-bin-'))
const fake = (name, body) => {
  writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`)
  chmodSync(join(bin, name), 0o755)
  return join(bin, name)
}
fake('pgrep', 'exit 1')
fake('curl', 'echo "{\\"pending\\": $FAKE_PENDING}"')
fake('python3', 'exit 0')
const node = fake('fakenode', '[ "$1" = -v ] && { echo v22.3.0; exit 0; }\nexit 0')

// Runs poll.sh in a fake $HOME with pre-made `lanes` ({ name: pid | null }).
// The fake node exits at once, so spawned lanes keep their pid file.
function pollSh({ pending, lanes = {}, maxConcurrent }) {
  const home = mkdtempSync(join(tmpdir(), 'dmn7-lanes-'))
  const daemon = join(home, 'fermi-daemon')
  for (const d of ['logs', 'runs', 'prompts', 'lanes']) mkdirSync(join(daemon, d), { recursive: true })
  writeFileSync(join(daemon, '.env'), 'FERMI_URL=http://127.0.0.1:9\nFERMI_BEARER_TOKEN=t\n')
  // Recent heartbeat so only the reactive drain path can spawn.
  writeFileSync(join(daemon, 'last-heartbeat'), '')
  const old = Date.now() / 1000 - 3600
  for (const [name, pid] of Object.entries(lanes)) {
    const lane = join(daemon, 'lanes', name)
    mkdirSync(lane)
    if (pid != null) writeFileSync(join(lane, 'pid'), String(pid))
    else utimesSync(lane, old, old) // claimed long ago, never got a pid: orphaned
  }
  const r = spawnSync('/bin/zsh', [join(ROOT, 'poll.sh')], {
    env: {
      HOME: home,
      PATH: `${bin}:/usr/bin:/bin`,
      NODE_BIN: node,
      FAKE_PENDING: String(pending),
      ...(maxConcurrent ? { MAX_CONCURRENT: String(maxConcurrent) } : {}),
    },
    encoding: 'utf8',
  })
  const pollLog = existsSync(join(daemon, 'logs/poll.log')) ? readFileSync(join(daemon, 'logs/poll.log'), 'utf8') : ''
  return { ...r, pollLog, lanes: readdirSync(join(daemon, 'lanes')).sort() }
}

const spawned = (log) => [...log.matchAll(/spawned drain\.md in lane (\d+)/g)].map((m) => m[1]).sort()

describe('poll.sh live-lane count', () => {
  test('empty lanes/ with MAX_CONCURRENT=1: counts 0 live lanes and spawns a drain lane', () => {
    const r = pollSh({ pending: 1, maxConcurrent: 1 })
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.pollLog, /1 pending, spawning 1$/m)
    assert.deepEqual(spawned(r.pollLog), ['1'])
    assert.deepEqual(r.lanes, ['1'])
  })

  test('0 lanes: all MAX_CONCURRENT slots are free', () => {
    const r = pollSh({ pending: 9, maxConcurrent: 5 })
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.pollLog, /9 pending, spawning 5$/m)
    assert.deepEqual(spawned(r.pollLog), ['1', '2', '3', '4', '5'])
  })

  test('1 live lane: one slot taken', () => {
    const r = pollSh({ pending: 9, maxConcurrent: 5, lanes: { 1: livePid() } })
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.pollLog, /9 pending, spawning 4$/m)
    assert.deepEqual(spawned(r.pollLog), ['2', '3', '4', '5'])
  })

  test('3 live lanes: three slots taken', () => {
    const r = pollSh({ pending: 9, maxConcurrent: 5, lanes: { 1: livePid(), 2: livePid(), 3: livePid() } })
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.pollLog, /9 pending, spawning 2$/m)
    assert.deepEqual(spawned(r.pollLog), ['4', '5'])
  })

  test('live lanes at MAX_CONCURRENT=1: nothing spawns', () => {
    const r = pollSh({ pending: 1, maxConcurrent: 1, lanes: { 1: livePid() } })
    assert.equal(r.status, 0, r.stderr)
    assert.doesNotMatch(r.pollLog, /spawn/)
  })

  test('stale lanes (dead pid, orphaned claim) are reaped and not counted', () => {
    const r = pollSh({ pending: 9, maxConcurrent: 5, lanes: { 1: deadPid(), 2: null, 3: livePid() } })
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.pollLog, /9 pending, spawning 4$/m)
    assert.deepEqual(spawned(r.pollLog), ['1', '2', '4', '5'])
    assert.deepEqual(r.lanes, ['1', '2', '3', '4', '5'])
  })

  test('all lanes stale: reaped to 0 live, MAX_CONCURRENT=1 still spawns', () => {
    const r = pollSh({ pending: 1, maxConcurrent: 1, lanes: { 1: deadPid(), 2: null, 3: deadPid() } })
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.pollLog, /1 pending, spawning 1$/m)
    assert.deepEqual(r.lanes, ['1'])
  })
})
