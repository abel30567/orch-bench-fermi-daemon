// poll.sh lane accounting: the real script under a temp $HOME with fake
// curl/pgrep/node/python3 on PATH (no network, no real harness). The fake
// queue always reports PENDING tasks, so the number of drain spawns logged to
// logs/poll.log is exactly MAX_CONCURRENT - live.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, chmodSync, realpathSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ROOT } from './run-worker.mjs'

const POLL = join(ROOT, 'poll.sh')
const PENDING = 10
const DEAD_PID = 999999
const hasZsh = spawnSync('zsh', ['-c', 'true']).status === 0
// poll.sh uses BSD `stat -f %m`, so it only runs on macOS.
const skip = !hasZsh || process.platform !== 'darwin' ? 'needs zsh on macOS' : false

function setup() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'pr54-')))
  const daemon = join(home, 'fermi-daemon')
  const bin = join(home, 'bin')
  for (const d of [bin, join(daemon, 'logs'), join(daemon, 'runs'), join(daemon, 'lanes')]) mkdirSync(d, { recursive: true })
  writeFileSync(join(daemon, '.env'), 'FERMI_URL=http://fermi.invalid\nFERMI_BEARER_TOKEN=test-token\n')
  const fakes = {
    curl: `#!/bin/sh\necho '{"pending":${PENDING}}'\n`,
    pgrep: '#!/bin/sh\nexit 1\n', // warm worker down -> cold fallback path
    node: '#!/bin/sh\n[ "$1" = "-v" ] && echo v22.0.0\nexit 0\n',
    python3: '#!/bin/sh\nexit 0\n',
  }
  for (const [name, body] of Object.entries(fakes)) {
    writeFileSync(join(bin, name), body)
    chmodSync(join(bin, name), 0o755)
  }
  return { home, daemon, bin, lanes: join(daemon, 'lanes') }
}

function runPoll(env, maxConcurrent) {
  const r = spawnSync('zsh', [POLL], {
    env: {
      ...process.env,
      HOME: env.home,
      PATH: `${env.bin}:/usr/bin:/bin:/usr/sbin:/sbin`,
      MAX_CONCURRENT: String(maxConcurrent),
      MAX_RUN_SECONDS: '600',
    },
    encoding: 'utf8',
    timeout: 30_000,
  })
  assert.equal(r.status, 0, r.stderr)
  const logFile = join(env.daemon, 'logs/poll.log')
  const log = existsSync(logFile) ? readFileSync(logFile, 'utf8') : ''
  const m = log.match(/spawning (\d+)/)
  return { spawned: m ? Number(m[1]) : 0, log }
}

const sleeper = () => spawn('sleep', ['60'], { stdio: 'ignore' })

function addLane(env, name, pid, ageSeconds = 0) {
  const lane = join(env.lanes, name)
  mkdirSync(lane)
  if (pid !== undefined) writeFileSync(join(lane, 'pid'), `${pid}\n`)
  if (ageSeconds) {
    const t = Date.now() / 1000 - ageSeconds
    if (pid !== undefined) utimesSync(join(lane, 'pid'), t, t)
    utimesSync(lane, t, t)
  }
}

describe('poll.sh live-lane count', { skip }, () => {
  test('empty lanes/ counts 0 live lanes; MAX_CONCURRENT=1 spawns a drain lane', () => {
    const env = setup()
    const { spawned, log } = runPoll(env, 1)
    assert.equal(spawned, 1, log)
    assert.match(log, /spawned drain\.md in lane 1 /)
  })

  test('1 live lane counts as 1', () => {
    const env = setup()
    const live = sleeper()
    try {
      addLane(env, '1', live.pid)
      const { spawned, log } = runPoll(env, 5)
      assert.equal(spawned, 4, log)
      assert.ok(existsSync(join(env.lanes, '1/pid')), 'live lane must not be reaped')
    } finally {
      live.kill()
    }
  })

  test('3 live lanes count as 3', () => {
    const env = setup()
    const kids = [sleeper(), sleeper(), sleeper()]
    try {
      kids.forEach((k, i) => addLane(env, String(i + 1), k.pid))
      const { spawned, log } = runPoll(env, 5)
      assert.equal(spawned, 2, log)
    } finally {
      kids.forEach((k) => k.kill())
    }
  })

  test('stale lanes are reaped and not counted', () => {
    const env = setup()
    const live = sleeper()
    const stuck = sleeper()
    try {
      addLane(env, '1', live.pid) // live: counted
      addLane(env, '2', DEAD_PID) // dead pid: reaped
      addLane(env, '3', undefined, 120) // claimed >30s ago, no pid: reaped
      addLane(env, '4', stuck.pid, 3600) // past MAX_RUN_SECONDS: watchdog kill + reap
      const { spawned, log } = runPoll(env, 5)
      assert.match(log, /watchdog: killing stuck lane 4 /)
      assert.equal(spawned, 4, log)
      // Lane 1 survives; 2..5 are the freshly spawned drain lanes.
      assert.deepEqual(readdirSync(env.lanes).sort(), ['1', '2', '3', '4', '5'])
    } finally {
      live.kill()
      stuck.kill()
    }
  })
})
