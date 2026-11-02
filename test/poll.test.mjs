import { test, describe, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync, utimesSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ROOT } from './run-worker.mjs'

const POLL = join(ROOT, 'poll.sh')
const hasZsh = spawnSync('zsh', ['-c', 'true']).status === 0

const sleepers = []
after(() => sleepers.forEach((p) => p.kill('SIGKILL')))
const liveSleeper = () => {
  const p = spawn('sleep', ['120'], { stdio: 'ignore' })
  sleepers.push(p)
  return p.pid
}
const deadPid = () => spawnSync('sh', ['-c', 'echo $$']).stdout.toString().trim()
const old = () => new Date(Date.now() - 3600_000)

function exe(path, body) {
  writeFileSync(path, `#!/bin/sh\n${body}\n`)
  chmodSync(path, 0o755)
}

// Runs the real poll.sh against a temp $HOME with the warm worker "down",
// `pending` queued tasks, and the given lanes pre-populated.
// lanes: { name: 'live' | 'dead' | 'stuck' | 'orphan' }
function runPoll({ maxConcurrent, pending = 10, lanes = {} }) {
  const home = mkdtempSync(join(tmpdir(), 'poll-'))
  const daemon = join(home, 'fermi-daemon')
  const bin = join(home, 'bin')
  for (const d of ['logs', 'runs', 'prompts', 'lanes']) mkdirSync(join(daemon, d), { recursive: true })
  mkdirSync(bin)
  writeFileSync(join(daemon, '.env'), 'FERMI_URL=http://fermi.invalid\nFERMI_BEARER_TOKEN=t\n')
  exe(join(bin, 'curl'), `echo '{"pending": ${pending}}'`)
  exe(join(bin, 'pgrep'), 'exit 1') // warm worker down -> cold fallback
  exe(join(bin, 'python3'), 'exit 0') // narrator
  // BSD `stat -f %m FILE` shim so the harness also runs on Linux.
  exe(join(bin, 'stat'), `exec perl -e 'print((stat $ARGV[0])[9], "\\n")' "$3"`)
  const node = join(bin, 'fake-node')
  exe(node, `[ "$1" = -v ] && { echo v22.0.0; exit 0; }\necho spawned >>"${join(home, 'spawns')}"`)

  for (const [name, kind] of Object.entries(lanes)) {
    const lane = join(daemon, 'lanes', name)
    mkdirSync(lane)
    if (kind === 'orphan') {
      utimesSync(lane, old(), old())
      continue
    }
    const pidFile = join(lane, 'pid')
    writeFileSync(pidFile, String(kind === 'dead' ? deadPid() : liveSleeper()))
    if (kind === 'stuck') utimesSync(pidFile, old(), old())
  }

  const r = spawnSync('zsh', [POLL], {
    env: {
      HOME: home,
      PATH: `${bin}:${process.env.PATH}`,
      NODE_BIN: node,
      MAX_CONCURRENT: String(maxConcurrent),
      MAX_RUN_SECONDS: '1200',
    },
    encoding: 'utf8',
    timeout: 30_000,
  })
  assert.equal(r.status, 0, r.stderr)
  const log = existsSync(join(daemon, 'logs/poll.log')) ? readFileSync(join(daemon, 'logs/poll.log'), 'utf8') : ''
  const m = log.match(/spawning (\d+)/)
  return {
    log,
    toSpawn: m ? Number(m[1]) : 0,
    spawnedLanes: [...log.matchAll(/spawned drain\.md in lane (\S+)/g)].map((x) => x[1]),
    lanesLeft: readdirSync(join(daemon, 'lanes')).sort(),
  }
}

describe('poll.sh live-lane count', { skip: !hasZsh && 'zsh not installed' }, () => {
  test('empty lanes/ counts 0 live lanes: MAX_CONCURRENT=1 spawns a drain lane', () => {
    const r = runPoll({ maxConcurrent: 1 })
    assert.equal(r.toSpawn, 1, r.log)
    assert.deepEqual(r.spawnedLanes, ['1'])
  })

  test('0 lanes, MAX_CONCURRENT=5 spawns 5', () => {
    assert.equal(runPoll({ maxConcurrent: 5 }).toSpawn, 5)
  })

  test('1 live lane counts as 1', () => {
    const r = runPoll({ maxConcurrent: 5, lanes: { 1: 'live' } })
    assert.equal(r.toSpawn, 4, r.log)
    assert.deepEqual(r.spawnedLanes, ['2', '3', '4', '5'])
  })

  test('1 live lane fills MAX_CONCURRENT=1', () => {
    const r = runPoll({ maxConcurrent: 1, lanes: { 1: 'live' } })
    assert.equal(r.toSpawn, 0, r.log)
    assert.deepEqual(r.lanesLeft, ['1'])
  })

  test('3 live lanes plus stale ones reaped counts 3', () => {
    const r = runPoll({
      maxConcurrent: 5,
      lanes: { 1: 'live', 2: 'dead', 3: 'live', 4: 'orphan', 5: 'live', 6: 'stuck' },
    })
    assert.equal(r.toSpawn, 2, r.log)
    assert.match(r.log, /watchdog: killing stuck lane 6/)
    assert.deepEqual(r.spawnedLanes, ['2', '4'])
  })

  test('only stale lanes: all reaped, counts 0', () => {
    const r = runPoll({ maxConcurrent: 1, lanes: { 1: 'dead', 2: 'orphan' } })
    assert.equal(r.toSpawn, 1, r.log)
    assert.deepEqual(r.spawnedLanes, ['1'])
  })
})
