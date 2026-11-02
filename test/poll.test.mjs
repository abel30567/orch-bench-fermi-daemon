import { test, describe, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, chmodSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ROOT } from './run-worker.mjs'

const POLL = join(ROOT, 'poll.sh')
// poll.sh is macOS-only (launchd, BSD `stat -f %m`) and needs zsh.
const skip = process.platform !== 'darwin' || spawnSync('zsh', ['-c', 'true']).status !== 0

const sleepers = []
after(() => {
  for (const p of sleepers) {
    try {
      p.kill('SIGKILL')
    } catch {}
  }
})
const livePid = () => {
  const p = spawn('sleep', ['300'], { stdio: 'ignore' })
  sleepers.push(p)
  return p.pid
}
const deadPid = () => {
  const r = spawnSync('sh', ['-c', 'echo $$'], { encoding: 'utf8' })
  return Number(r.stdout.trim())
}
const backdate = (path, seconds) => {
  const t = Date.now() / 1000 - seconds
  utimesSync(path, t, t)
}

// Runs poll.sh with HOME pointing at a stub daemon home: curl reports
// `pending` tasks, pgrep reports the warm worker down, and bin/run-once.mjs is
// a no-op. `lanes` is a list of { pid?, ageS? } pre-existing lane dirs.
function runPoll({ lanes = [], pending = 10, maxConcurrent = 5 } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'dmn7-poll-'))
  const d = join(home, 'fermi-daemon')
  const stubs = join(home, 'stubs')
  for (const sub of ['logs', 'runs', 'prompts', 'bin', 'lanes']) mkdirSync(join(d, sub), { recursive: true })
  mkdirSync(stubs)
  writeFileSync(join(d, '.env'), `FERMI_URL=http://fermi.invalid\nFERMI_BEARER_TOKEN=t\nNODE_BIN=${process.execPath}\n`)
  writeFileSync(join(d, 'bin/run-once.mjs'), '')
  writeFileSync(join(d, 'narrator.py'), '')
  writeFileSync(join(stubs, 'curl'), `#!/bin/sh\necho '{"pending": ${pending}}'\n`)
  writeFileSync(join(stubs, 'pgrep'), '#!/bin/sh\nexit 1\n')
  chmodSync(join(stubs, 'curl'), 0o755)
  chmodSync(join(stubs, 'pgrep'), 0o755)

  lanes.forEach((lane, i) => {
    const dir = join(d, 'lanes', String(i + 1))
    mkdirSync(dir)
    if (lane.pid) {
      writeFileSync(join(dir, 'pid'), `${lane.pid}\n`)
      if (lane.ageS) backdate(join(dir, 'pid'), lane.ageS)
    }
    if (lane.ageS) backdate(dir, lane.ageS)
  })

  const r = spawnSync('zsh', [POLL], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home, PATH: `${stubs}:${process.env.PATH}`, MAX_CONCURRENT: String(maxConcurrent), MAX_RUN_SECONDS: '1200' },
  })
  assert.equal(r.status, 0, r.stderr)
  const logFile = join(d, 'logs/poll.log')
  const log = existsSync(logFile) ? readFileSync(logFile, 'utf8') : ''
  const spawned = Number(log.match(/spawning (\d+)/)?.[1] ?? 0)
  return { log, spawned, lanes: readdirSync(join(d, 'lanes')).sort() }
}

describe('poll.sh live-lane count', { skip }, () => {
  test('empty lanes/ counts 0 live lanes; MAX_CONCURRENT=1 spawns a drain lane', () => {
    const r = runPoll({ maxConcurrent: 1, pending: 1 })
    assert.equal(r.spawned, 1, r.log)
    assert.match(r.log, /spawned drain\.md in lane 1/)
    assert.deepEqual(r.lanes, ['1'])
  })

  test('empty lanes/ fills all MAX_CONCURRENT lanes', () => {
    const r = runPoll({ maxConcurrent: 5 })
    assert.equal(r.spawned, 5, r.log)
    assert.deepEqual(r.lanes, ['1', '2', '3', '4', '5'])
  })

  test('1 live lane counts 1', () => {
    const r = runPoll({ lanes: [{ pid: livePid() }] })
    assert.equal(r.spawned, 4, r.log)
  })

  test('3 live lanes count 3', () => {
    const r = runPoll({ lanes: [{ pid: livePid() }, { pid: livePid() }, { pid: livePid() }] })
    assert.equal(r.spawned, 2, r.log)
  })

  test('all lanes live: nothing spawns', () => {
    const r = runPoll({ maxConcurrent: 1, lanes: [{ pid: livePid() }] })
    assert.equal(r.spawned, 0, r.log)
    assert.deepEqual(r.lanes, ['1'])
  })

  test('stale lanes are reaped and not counted', () => {
    const r = runPoll({
      lanes: [
        { pid: livePid() }, // live
        { pid: deadPid() }, // dead pid
        {}, // claimed, no pid, fresh: kept (counted)
        { ageS: 120 }, // claimed, no pid, orphaned: reaped
        { pid: livePid(), ageS: 7200 }, // stuck past MAX_RUN_SECONDS: killed
      ],
    })
    assert.match(r.log, /watchdog: killing stuck lane 5/)
    assert.equal(r.spawned, 3, r.log)
    assert.deepEqual(r.lanes, ['1', '2', '3', '4', '5'])
  })
})
