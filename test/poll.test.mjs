import { test, describe, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, chmodSync, copyFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ROOT } from './run-worker.mjs'

// poll.sh uses BSD `stat -f %m`, so it only runs as-is on macOS.
const hasZsh = spawnSync('zsh', ['-c', 'true']).status === 0
const skip = process.platform !== 'darwin' || !hasZsh ? 'needs macOS + zsh' : false

const sleepers = []
after(() => sleepers.forEach((c) => c.kill('SIGKILL')))

const stub = (path, body) => {
  writeFileSync(path, `#!/bin/sh\n${body}\n`)
  chmodSync(path, 0o755)
}

// Runs poll.sh against a fake daemon home: warm worker down (pgrep fails),
// `pending` tasks queued (curl stub), a node stub standing in for run-once.mjs.
// `lanes` maps lane name -> 'live' | 'fresh' (no pid yet) | 'dead' | 'orphan'.
function runPoll({ pending, maxConcurrent, lanes = {} }) {
  const home = mkdtempSync(join(tmpdir(), 'poll-'))
  const daemon = join(home, 'fermi-daemon')
  const stubs = join(home, 'stubs')
  for (const d of ['logs', 'runs', 'prompts', 'lanes']) mkdirSync(join(daemon, d), { recursive: true })
  mkdirSync(stubs)
  copyFileSync(join(ROOT, 'poll.sh'), join(daemon, 'poll.sh'))
  stub(join(stubs, 'curl'), `echo '{"pending": ${pending}}'`)
  stub(join(stubs, 'pgrep'), 'exit 1')
  stub(join(stubs, 'python3'), 'exit 0')
  stub(join(stubs, 'node'), '[ "$1" = -v ] && echo v22.0.0; exit 0')
  writeFileSync(join(daemon, '.env'), `FERMI_URL=http://fermi.invalid\nFERMI_BEARER_TOKEN=x\nNODE_BIN=${join(stubs, 'node')}\n`)

  const old = new Date(Date.now() - 120_000)
  for (const [name, kind] of Object.entries(lanes)) {
    const lane = join(daemon, 'lanes', name)
    mkdirSync(lane)
    if (kind === 'live') {
      const c = spawn('sleep', ['60'], { stdio: 'ignore' })
      sleepers.push(c)
      writeFileSync(join(lane, 'pid'), String(c.pid))
    } else if (kind === 'dead') {
      const { pid } = spawnSync('true')
      writeFileSync(join(lane, 'pid'), String(pid))
    } else if (kind === 'orphan') {
      utimesSync(lane, old, old)
    }
  }

  const r = spawnSync('zsh', [join(daemon, 'poll.sh')], {
    env: { PATH: `${stubs}:${process.env.PATH}`, HOME: home, MAX_CONCURRENT: String(maxConcurrent) },
    encoding: 'utf8',
  })
  assert.equal(r.status, 0, r.stderr)
  let log = ''
  try {
    log = readFileSync(join(daemon, 'logs/poll.log'), 'utf8')
  } catch {}
  return {
    spawned: (log.match(/spawned drain\.md/g) || []).length,
    lanesLeft: readdirSync(join(daemon, 'lanes')).sort(),
    log,
  }
}

describe('poll.sh live-lane count', { skip }, () => {
  test('empty lanes/ counts 0 live lanes: MAX_CONCURRENT=1 spawns a drain lane', () => {
    const { spawned, log } = runPoll({ pending: 1, maxConcurrent: 1 })
    assert.equal(spawned, 1, log)
    assert.match(log, /spawning 1\b/)
  })

  test('0 live lanes: fills every free lane', () => {
    const { spawned, log } = runPoll({ pending: 10, maxConcurrent: 5 })
    assert.equal(spawned, 5, log)
  })

  test('1 live lane', () => {
    const { spawned, log } = runPoll({ pending: 10, maxConcurrent: 5, lanes: { 1: 'live' } })
    assert.equal(spawned, 4, log)
  })

  test('3 live lanes (incl. a freshly claimed one)', () => {
    const { spawned, log } = runPoll({ pending: 10, maxConcurrent: 5, lanes: { 1: 'live', 2: 'live', 3: 'fresh' } })
    assert.equal(spawned, 2, log)
  })

  test('stale lanes are reaped and not counted', () => {
    const { spawned, lanesLeft, log } = runPoll({
      pending: 10,
      maxConcurrent: 5,
      lanes: { 1: 'live', 2: 'dead', 3: 'orphan' },
    })
    assert.equal(spawned, 4, log)
    assert.ok(lanesLeft.includes('1'), lanesLeft.join(','))
  })

  test('only stale lanes: all reaped, MAX_CONCURRENT=1 still spawns', () => {
    const { spawned, log } = runPoll({ pending: 1, maxConcurrent: 1, lanes: { 1: 'dead', 2: 'orphan' } })
    assert.equal(spawned, 1, log)
  })
})
