import { test, describe, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ROOT } from './run-worker.mjs'

const POLL = join(ROOT, 'poll.sh')
const hasZsh = spawnSync('zsh', ['-c', 'exit 0']).status === 0
const sleepers = []
after(() => sleepers.forEach((c) => c.kill('SIGKILL')))

const liveProc = () => {
  const c = spawn('sleep', ['60'], { stdio: 'ignore' })
  sleepers.push(c)
  return c.pid
}
const deadPid = () => {
  const r = spawnSync('sh', ['-c', 'echo $$'])
  return Number(r.stdout.toString().trim())
}

// Runs poll.sh in a sandbox HOME with the warm worker "down" (pgrep stub fails),
// `pending` tasks queued (curl stub), and a no-op run-once.mjs. `setup(laneDir)`
// populates lanes/ before the run. Returns the poll.log spawn lines.
function runPoll({ maxConcurrent, pending, setup }) {
  const home = mkdtempSync(join(tmpdir(), 'dmn7-poll-'))
  const dh = join(home, 'fermi-daemon')
  for (const d of ['logs', 'runs', 'prompts', 'bin', 'lanes', 'stubs']) mkdirSync(join(dh, d), { recursive: true })
  writeFileSync(join(dh, '.env'), `FERMI_URL=http://fermi.invalid\nFERMI_BEARER_TOKEN=x\nNODE_BIN=${process.execPath}\n`)
  writeFileSync(join(dh, 'bin/run-once.mjs'), '')
  writeFileSync(join(dh, 'last-heartbeat'), '')
  const stub = (name, body) => {
    writeFileSync(join(dh, 'stubs', name), `#!/bin/sh\n${body}\n`)
    chmodSync(join(dh, 'stubs', name), 0o755)
  }
  stub('pgrep', 'exit 1')
  stub('curl', `echo '{"pending": ${pending}}'`)
  stub('python3', 'exit 0')
  setup?.(join(dh, 'lanes'))
  const r = spawnSync('zsh', [POLL], {
    env: { PATH: `${join(dh, 'stubs')}:${process.env.PATH}`, HOME: home, MAX_CONCURRENT: String(maxConcurrent) },
    encoding: 'utf8',
  })
  assert.equal(r.status, 0, r.stderr)
  const logFile = join(dh, 'logs/poll.log')
  const log = existsSync(logFile) ? readFileSync(logFile, 'utf8') : ''
  return { log, spawned: log.split('\n').filter((l) => l.includes('spawned drain.md')).length, lanes: join(dh, 'lanes') }
}

const lane = (dir, name, pid) => {
  mkdirSync(join(dir, name))
  if (pid !== undefined) writeFileSync(join(dir, name, 'pid'), String(pid))
}

describe('poll.sh live-lane count', { skip: !hasZsh && 'zsh not available' }, () => {
  test('empty lanes/ counts 0 live lanes: MAX_CONCURRENT=1 spawns a drain lane', () => {
    const { spawned, log } = runPoll({ maxConcurrent: 1, pending: 1 })
    assert.equal(spawned, 1, log)
  })

  test('1 live lane leaves MAX_CONCURRENT-1 free', () => {
    const { spawned, log } = runPoll({ maxConcurrent: 5, pending: 10, setup: (d) => lane(d, '1', liveProc()) })
    assert.equal(spawned, 4, log)
  })

  test('3 live lanes leave MAX_CONCURRENT-3 free', () => {
    const { spawned, log } = runPoll({
      maxConcurrent: 5,
      pending: 10,
      setup: (d) => ['1', '2', '3'].forEach((n) => lane(d, n, liveProc())),
    })
    assert.equal(spawned, 2, log)
  })

  test('stale lanes are reaped and not counted', () => {
    const { spawned, log, lanes } = runPoll({
      maxConcurrent: 5,
      pending: 10,
      setup: (d) => {
        lane(d, '1', liveProc())
        lane(d, '2', deadPid()) // dead pid
        lane(d, '3') // orphaned claim without pid, >30s old
        const old = new Date(Date.now() - 120_000)
        utimesSync(join(d, '3'), old, old)
      },
    })
    assert.equal(spawned, 4, log)
    assert.ok(existsSync(join(lanes, '1')))
  })

  test('all lanes live: nothing spawns', () => {
    const { spawned, log } = runPoll({ maxConcurrent: 1, pending: 1, setup: (d) => lane(d, '1', liveProc()) })
    assert.equal(spawned, 0, log)
  })
})
