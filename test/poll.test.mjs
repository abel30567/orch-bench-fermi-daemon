import { test, describe, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, chmodSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ROOT } from './run-worker.mjs'

const POLL = join(ROOT, 'poll.sh')
// poll.sh uses BSD `stat -f %m`, so it only runs as-is on macOS.
const skip = process.platform !== 'darwin' || spawnSync('zsh', ['-c', 'true']).status !== 0

const sleepers = []
after(() => sleepers.forEach((c) => c.kill('SIGKILL')))

function stub(dir, name, body) {
  const p = join(dir, name)
  writeFileSync(p, `#!/bin/sh\n${body}\n`)
  chmodSync(p, 0o755)
  return p
}

// A pid that is guaranteed dead.
function deadPid() {
  const r = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'])
  return r.stdout.toString()
}

// Runs the real poll.sh against a temp $HOME/fermi-daemon with the warm worker
// "down" (pgrep fails), `pending` tasks queued and a stub node for run-once.
// `lanes` maps lane name -> 'live' | 'dead' | 'orphan' (no pid, >30s old).
function runPoll({ lanes = {}, pending = 10, maxConcurrent = 5 } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'dmn7-poll-'))
  const daemon = join(home, 'fermi-daemon')
  const bin = join(home, 'bin')
  for (const d of ['logs', 'runs', 'prompts', 'lanes']) mkdirSync(join(daemon, d), { recursive: true })
  mkdirSync(bin)
  writeFileSync(join(daemon, '.env'), 'FERMI_URL=http://fermi.invalid\nFERMI_BEARER_TOKEN=t\n')
  writeFileSync(join(daemon, 'last-heartbeat'), '')
  stub(bin, 'pgrep', 'exit 1')
  stub(bin, 'curl', `echo '{"pending": ${pending}}'`)
  stub(bin, 'python3', 'exit 0')
  const node = stub(bin, 'node', `[ "$1" = -v ] && { echo v22.0.0; exit 0; }\necho "$@" >>"${join(home, 'spawns')}"`)

  const old = Math.floor(Date.now() / 1000) - 120
  for (const [name, kind] of Object.entries(lanes)) {
    const lane = join(daemon, 'lanes', name)
    mkdirSync(lane)
    if (kind === 'live') {
      const c = spawn('sleep', ['60'], { stdio: 'ignore' })
      sleepers.push(c)
      writeFileSync(join(lane, 'pid'), String(c.pid))
    } else if (kind === 'dead') {
      writeFileSync(join(lane, 'pid'), deadPid())
    } else if (kind === 'orphan') {
      utimesSync(lane, old, old)
    }
  }

  const r = spawnSync('zsh', [POLL], {
    env: { PATH: `${bin}:${process.env.PATH}`, HOME: home, NODE_BIN: node, MAX_CONCURRENT: String(maxConcurrent) },
    encoding: 'utf8',
  })
  assert.equal(r.status, 0, r.stderr)
  const log = existsSync(join(daemon, 'logs/poll.log')) ? readFileSync(join(daemon, 'logs/poll.log'), 'utf8') : ''
  const spawned = (log.match(/spawned drain\.md/g) || []).length
  const m = log.match(/spawning (\d+)/)
  return { log, spawned, toSpawn: m ? Number(m[1]) : 0, laneNames: readdirSync(join(daemon, 'lanes')).sort() }
}

describe('poll.sh live-lane count', { skip }, () => {
  test('empty lanes/ counts 0 live lanes; MAX_CONCURRENT=1 spawns a drain lane', () => {
    const r = runPoll({ maxConcurrent: 1, pending: 1 })
    assert.equal(r.toSpawn, 1, r.log)
    assert.equal(r.spawned, 1, r.log)
    assert.deepEqual(r.laneNames, ['1'])
  })

  test('empty lanes/ with MAX_CONCURRENT=5 fills all lanes', () => {
    const r = runPoll({ maxConcurrent: 5 })
    assert.equal(r.toSpawn, 5, r.log)
    assert.equal(r.spawned, 5, r.log)
  })

  test('1 live lane counts 1', () => {
    const r = runPoll({ lanes: { 1: 'live' } })
    assert.equal(r.toSpawn, 4, r.log)
    assert.equal(r.spawned, 4, r.log)
  })

  test('3 live lanes count 3', () => {
    const r = runPoll({ lanes: { 1: 'live', 2: 'live', 3: 'live' } })
    assert.equal(r.toSpawn, 2, r.log)
    assert.equal(r.spawned, 2, r.log)
    assert.deepEqual(r.laneNames, ['1', '2', '3', '4', '5'])
  })

  test('stale lanes are reaped and not counted', () => {
    const r = runPoll({ lanes: { 1: 'live', 2: 'dead', 3: 'orphan' } })
    assert.equal(r.toSpawn, 4, r.log)
    assert.equal(r.spawned, 4, r.log)
  })

  test('only stale lanes count 0 after reaping', () => {
    const r = runPoll({ maxConcurrent: 1, pending: 1, lanes: { 1: 'dead', 2: 'orphan' } })
    assert.equal(r.toSpawn, 1, r.log)
    assert.equal(r.spawned, 1, r.log)
  })

  test('full lanes spawn nothing', () => {
    const r = runPoll({ maxConcurrent: 3, lanes: { 1: 'live', 2: 'live', 3: 'live' } })
    assert.equal(r.toSpawn, 0, r.log)
    assert.equal(r.spawned, 0, r.log)
  })
})
