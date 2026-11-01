// poll.sh live-lane accounting: runs the real poll.sh in a throwaway $HOME with
// the warm worker down (fake pgrep), a fake queue reporting `pending` tasks
// (fake curl) and a fake node >= 22, then reads how many drain lanes it spawned.
// spawned = min(pending, MAX_CONCURRENT - live), so the spawn count exposes the
// live-lane count poll.sh computed after reaping.
import { test, describe, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, chmodSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { ROOT } from './run-worker.mjs'

const children = []
after(() => children.forEach((c) => c.exitCode === null && c.kill('SIGKILL')))

// A real process for a lane's pid file; killed after the suite.
const liveProc = () => {
  const c = spawn('sleep', ['60'], { stdio: 'ignore' })
  children.push(c)
  return c
}
// A pid that no longer exists.
const deadPid = () => spawnSync('sh', ['-c', 'echo $$'], { encoding: 'utf8' }).stdout.trim()

// lanes: { name: { pid?, ageS? } } pre-populated before poll.sh runs.
function pollSh({ pending, max, lanes = {} }) {
  const home = mkdtempSync(join(tmpdir(), 'dmn7-lanes-'))
  const daemon = join(home, 'fermi-daemon')
  const bin = join(home, 'bin')
  for (const d of ['logs', 'runs', 'prompts', 'lanes']) mkdirSync(join(daemon, d), { recursive: true })
  mkdirSync(bin)
  writeFileSync(join(daemon, '.env'), 'FERMI_URL=http://127.0.0.1:9\nFERMI_BEARER_TOKEN=t\n')
  const fake = (name, body) => (writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`), chmodSync(join(bin, name), 0o755), join(bin, name))
  fake('pgrep', 'exit 1')
  fake('curl', `echo '{"pending": ${pending}}'`)
  fake('python3', 'exit 0')
  // Portable `stat -f %m FILE` (BSD mtime) so the reaper behaves the same on Linux CI.
  fake('stat', `exec "${process.execPath}" -e 'console.log(Math.floor(require("fs").statSync(process.argv[1]).mtimeMs / 1000))' "$3"`)
  const node = fake('node22', '[ "$1" = -v ] && echo v22.3.0\nexit 0')

  const now = Date.now() / 1000
  for (const [name, { pid, ageS = 0 }] of Object.entries(lanes)) {
    const lane = join(daemon, 'lanes', name)
    mkdirSync(lane)
    if (pid !== undefined) {
      writeFileSync(join(lane, 'pid'), `${pid}\n`)
      utimesSync(join(lane, 'pid'), now - ageS, now - ageS)
    }
    utimesSync(lane, now - ageS, now - ageS)
  }

  const r = spawnSync('/bin/zsh', [join(ROOT, 'poll.sh')], {
    env: { HOME: home, PATH: `${bin}:/usr/bin:/bin`, NODE_BIN: node, MAX_CONCURRENT: String(max) },
    encoding: 'utf8',
  })
  const pollLog = existsSync(join(daemon, 'logs/poll.log')) ? readFileSync(join(daemon, 'logs/poll.log'), 'utf8') : ''
  const spawned = (pollLog.match(/^.* spawned drain\.md in lane .*$/gm) || []).length
  return { ...r, pollLog, spawned, lanes: readdirSync(join(daemon, 'lanes')).sort() }
}

describe('poll.sh live-lane count', () => {
  test('empty lanes/ counts 0 live: with MAX_CONCURRENT=1 a drain lane spawns', () => {
    const r = pollSh({ pending: 1, max: 1 })
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.pollLog, /reactive \(fallback, warm worker down\): 1 pending, spawning 1$/m)
    assert.equal(r.spawned, 1)
    assert.match(r.pollLog, /spawned drain\.md in lane 1 /)
    assert.deepEqual(r.lanes, ['1'])
  })

  test('0 lanes: all MAX_CONCURRENT lanes are free', () => {
    const r = pollSh({ pending: 10, max: 5 })
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.pollLog, /10 pending, spawning 5$/m)
    assert.equal(r.spawned, 5)
    assert.deepEqual(r.lanes, ['1', '2', '3', '4', '5'])
  })

  test('1 live lane counts 1', () => {
    const r = pollSh({ pending: 10, max: 5, lanes: { 1: { pid: liveProc().pid } } })
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.pollLog, /spawning 4$/m)
    assert.equal(r.spawned, 4)
  })

  test('1 live lane with MAX_CONCURRENT=1: nothing spawns', () => {
    const r = pollSh({ pending: 1, max: 1, lanes: { 1: { pid: liveProc().pid } } })
    assert.equal(r.status, 0, r.stderr)
    assert.equal(r.spawned, 0)
    assert.doesNotMatch(r.pollLog, /spawning/)
    assert.deepEqual(r.lanes, ['1'])
  })

  test('3 live lanes count 3', () => {
    const lanes = { 1: { pid: liveProc().pid }, 2: { pid: liveProc().pid }, 3: { pid: liveProc().pid } }
    const r = pollSh({ pending: 10, max: 5, lanes })
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.pollLog, /spawning 2$/m)
    assert.equal(r.spawned, 2)
    assert.deepEqual(r.lanes, ['1', '2', '3', '4', '5'])
  })

  test('only stale lanes: all reaped, 0 live, so with MAX_CONCURRENT=1 a drain lane spawns', () => {
    const r = pollSh({ pending: 1, max: 1, lanes: { 1: { pid: deadPid() }, 7: { ageS: 120 } } })
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.pollLog, /1 pending, spawning 1$/m)
    assert.equal(r.spawned, 1)
    assert.deepEqual(r.lanes, ['1'])
  })

  test('3 live lanes plus stale ones: stale lanes are reaped and not counted', async () => {
    const stuck = liveProc()
    const lanes = {
      1: { pid: liveProc().pid },
      2: { pid: liveProc().pid },
      3: {}, // just claimed, pid not written yet: live
      4: { pid: deadPid() }, // dead process: reaped
      5: { ageS: 120 }, // orphaned claim with no pid: reaped
      6: { pid: stuck.pid, ageS: 5000 }, // stuck past MAX_RUN_SECONDS: killed and reaped
    }
    const r = pollSh({ pending: 10, max: 6, lanes })
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.pollLog, /watchdog: killing stuck lane 6 /)
    assert.match(r.pollLog, /10 pending, spawning 3$/m)
    assert.equal(r.spawned, 3)
    // 1-3 kept; 4-6 reaped then reclaimed by the 3 new drain lanes.
    assert.deepEqual(r.lanes, ['1', '2', '3', '4', '5', '6'])
    // The child is ours, so wait for its exit (a killed-but-unreaped zombie still answers kill -0).
    const [, signal] = await Promise.race([once(stuck, 'exit'), new Promise((res) => setTimeout(() => res([null, 'timeout']), 3000))])
    assert.ok(signal === 'SIGTERM' || signal === 'SIGKILL', `stuck lane process killed (got ${signal})`)
  })
})
