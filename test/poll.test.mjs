import { test, describe, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, chmodSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ROOT } from './run-worker.mjs'

const hasZsh = existsSync('/bin/zsh')
const sleepers = []
after(() => sleepers.forEach((c) => c.kill('SIGKILL')))

function sleeper() {
  const c = spawn('sleep', ['60'], { stdio: 'ignore' })
  c.exited = new Promise((res) => c.on('exit', (code, signal) => res(signal)))
  sleepers.push(c)
  return c
}

// Runs poll.sh in a fake $HOME with the warm worker down (fake pgrep) and a
// queue reporting `pending` tasks (fake curl). `setup(lanesDir)` pre-populates
// lanes. Fake node/python3 exit immediately, so spawned lanes record a pid.
function pollSh({ pending = 10, env = {}, setup } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'dmn7-lanes-'))
  const daemon = join(home, 'fermi-daemon')
  const bin = join(home, 'bin')
  for (const d of ['logs', 'runs', 'prompts', 'lanes']) mkdirSync(join(daemon, d), { recursive: true })
  mkdirSync(bin)
  writeFileSync(join(daemon, '.env'), 'FERMI_URL=http://127.0.0.1:9\nFERMI_BEARER_TOKEN=t\n')
  const fake = (name, body) => (writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`), chmodSync(join(bin, name), 0o755))
  fake('pgrep', 'exit 1')
  fake('curl', `echo '{"pending": ${pending}}'`)
  fake('node', '[ "$1" = -v ] && { echo v22.3.0; exit 0; }\nexit 0')
  fake('python3', 'exit 0')
  // poll.sh uses BSD `stat -f %m`; translate on GNU systems.
  fake('stat', '[ "$(uname)" = Darwin ] && exec /usr/bin/stat "$@"\nexec /usr/bin/stat -c %Y "$3"')
  setup?.(join(daemon, 'lanes'))
  const r = spawnSync('/bin/zsh', [join(ROOT, 'poll.sh')], {
    env: { HOME: home, PATH: `${bin}:/usr/bin:/bin`, ...env },
    encoding: 'utf8',
  })
  const pollLog = existsSync(join(daemon, 'logs/poll.log')) ? readFileSync(join(daemon, 'logs/poll.log'), 'utf8') : ''
  const spawning = pollLog.match(/spawning (\d+)$/m)
  return { ...r, pollLog, spawned: spawning ? Number(spawning[1]) : 0, lanes: readdirSync(join(daemon, 'lanes')).sort() }
}

const liveLane = (dir, name, pid = sleeper().pid) => {
  mkdirSync(join(dir, name))
  writeFileSync(join(dir, name, 'pid'), String(pid))
  return pid
}
const old = (path, secs) => {
  const t = Date.now() / 1000 - secs
  utimesSync(path, t, t)
}

describe('poll.sh live-lane count', { skip: !hasZsh && 'zsh not installed' }, () => {
  test('empty lanes/ counts 0 live, so MAX_CONCURRENT=1 spawns a drain lane', () => {
    const r = pollSh({ env: { MAX_CONCURRENT: '1' } })
    assert.equal(r.status, 0, r.stderr)
    assert.equal(r.spawned, 1, r.pollLog)
    assert.match(r.pollLog, /spawned drain\.md in lane 1/)
    assert.deepEqual(r.lanes, ['1'])
  })

  test('0 live lanes: free = MAX_CONCURRENT', () => {
    const r = pollSh({ env: { MAX_CONCURRENT: '5' } })
    assert.equal(r.spawned, 5, r.pollLog)
  })

  test('1 live lane: one fewer spawn; with MAX_CONCURRENT=1 nothing spawns', () => {
    assert.equal(pollSh({ env: { MAX_CONCURRENT: '5' }, setup: (d) => liveLane(d, '1') }).spawned, 4)
    const r = pollSh({ env: { MAX_CONCURRENT: '1' }, setup: (d) => liveLane(d, '1') })
    assert.equal(r.spawned, 0, r.pollLog)
    assert.doesNotMatch(r.pollLog, /spawned/)
  })

  test('3 live lanes: spawns MAX_CONCURRENT - 3', () => {
    const r = pollSh({ env: { MAX_CONCURRENT: '5' }, setup: (d) => ['1', '2', '3'].forEach((n) => liveLane(d, n)) })
    assert.equal(r.spawned, 2, r.pollLog)
    assert.deepEqual(r.lanes, ['1', '2', '3', '4', '5'])
  })

  test('stale lanes are reaped before counting', async () => {
    let stuck
    const r = pollSh({
      env: { MAX_CONCURRENT: '5', MAX_RUN_SECONDS: '60' },
      setup: (d) => {
        liveLane(d, '1') // live: kept
        liveLane(d, '2', 2 ** 22 + 12345) // dead pid: reaped
        mkdirSync(join(d, '3')) // no pid, orphaned > 30s: reaped
        old(join(d, '3'), 120)
        stuck = sleeper()
        liveLane(d, '4', stuck.pid) // pid older than MAX_RUN_SECONDS: killed + reaped
        old(join(d, '4', 'pid'), 600)
        mkdirSync(join(d, '5')) // no pid, just claimed: kept
      },
    })
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.pollLog, /watchdog: killing stuck lane 4/)
    assert.equal(await stuck.exited, 'SIGTERM')
    // live = lanes 1 and 5, so 3 spawn into the reaped slots 2, 3, 4.
    assert.equal(r.spawned, 3, r.pollLog)
    assert.deepEqual(r.lanes, ['1', '2', '3', '4', '5'])
  })
})
