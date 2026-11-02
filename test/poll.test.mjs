import { test, describe, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, chmodSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ROOT } from './run-worker.mjs'

const POLL = join(ROOT, 'poll.sh')
// poll.sh uses BSD `stat -f %m`, so it only runs on macOS.
const skip = process.platform !== 'darwin' || spawnSync('zsh', ['-c', 'true']).status !== 0
  ? 'poll.sh needs zsh + BSD stat (macOS)'
  : false

const sleepers = []
after(() => sleepers.forEach((c) => c.kill('SIGKILL')))
const livePid = () => {
  const c = spawn('sleep', ['60'], { stdio: 'ignore' })
  sleepers.push(c)
  return c.pid
}
const deadPid = () => {
  const r = spawnSync('sh', ['-c', 'echo $$'], { encoding: 'utf8' })
  return Number(r.stdout.trim())
}

// Runs poll.sh against a scratch $HOME/fermi-daemon with the warm worker
// "down" (pgrep stub fails) and `pending` tasks on the queue. `setup(lanes)`
// populates lanes/ first. Returns the lanes left over and poll.log.
function runPoll({ maxConcurrent, pending = 10, setup = () => {} }) {
  const home = mkdtempSync(join(tmpdir(), 'dmn7-poll-'))
  const daemon = join(home, 'fermi-daemon')
  const lanes = join(daemon, 'lanes')
  const stubs = join(home, 'stubs')
  for (const d of [lanes, join(daemon, 'logs'), join(daemon, 'runs'), stubs]) mkdirSync(d, { recursive: true })
  writeFileSync(join(daemon, '.env'), 'FERMI_URL=http://fermi.invalid\nFERMI_BEARER_TOKEN=t\n')
  const stub = (name, body) => {
    writeFileSync(join(stubs, name), `#!/bin/sh\n${body}\n`)
    chmodSync(join(stubs, name), 0o755)
  }
  stub('pgrep', 'exit 1')
  stub('curl', `echo '{"pending": ${pending}}'`)
  stub('python3', 'exit 0')
  stub('node', `[ "$1" = -v ] && { echo v22.0.0; exit 0; }\necho "$@" >>"${join(home, 'spawns')}"`)
  setup(lanes)
  const r = spawnSync('zsh', [POLL], {
    encoding: 'utf8',
    env: {
      PATH: `${stubs}:${process.env.PATH}`,
      HOME: home,
      MAX_CONCURRENT: String(maxConcurrent),
      HEARTBEAT_SECONDS: '999999999',
    },
  })
  assert.equal(r.status, 0, r.stderr)
  const logFile = join(daemon, 'logs/poll.log')
  return {
    log: existsSync(logFile) ? readFileSync(logFile, 'utf8') : '',
    lanes: readdirSync(lanes).sort(),
  }
}

const spawned = (log) => Number(log.match(/spawning (\d+)/)?.[1] ?? 0)

describe('poll.sh live-lane count', { skip }, () => {
  test('empty lanes/ counts 0 live, so MAX_CONCURRENT=1 spawns a drain lane', () => {
    const { log, lanes } = runPoll({ maxConcurrent: 1 })
    assert.equal(spawned(log), 1, log)
    assert.match(log, /spawned drain\.md in lane 1/)
    assert.deepEqual(lanes, ['1'])
  })

  test('1 live lane is counted', () => {
    const { log } = runPoll({
      maxConcurrent: 3,
      setup: (lanes) => {
        mkdirSync(join(lanes, '1'))
        writeFileSync(join(lanes, '1/pid'), String(livePid()))
      },
    })
    assert.equal(spawned(log), 2, log)
  })

  test('3 live lanes are counted', () => {
    const { log } = runPoll({
      maxConcurrent: 5,
      setup: (lanes) => {
        for (const n of ['1', '2', '3']) {
          mkdirSync(join(lanes, n))
          writeFileSync(join(lanes, n, 'pid'), String(livePid()))
        }
      },
    })
    assert.equal(spawned(log), 2, log)
  })

  test('3 live lanes at MAX_CONCURRENT=3 spawn nothing', () => {
    const { log } = runPoll({
      maxConcurrent: 3,
      setup: (lanes) => {
        for (const n of ['1', '2', '3']) {
          mkdirSync(join(lanes, n))
          writeFileSync(join(lanes, n, 'pid'), String(livePid()))
        }
      },
    })
    assert.equal(spawned(log), 0, log)
  })

  test('stale lanes are reaped and not counted', () => {
    const { log, lanes } = runPoll({
      maxConcurrent: 3,
      setup: (lanes) => {
        // live
        mkdirSync(join(lanes, '1'))
        writeFileSync(join(lanes, '1/pid'), String(livePid()))
        // dead pid
        mkdirSync(join(lanes, '2'))
        writeFileSync(join(lanes, '2/pid'), String(deadPid()))
        // orphaned claim: no pid file, older than 30s
        mkdirSync(join(lanes, '3'))
        const old = new Date(Date.now() - 120_000)
        utimesSync(join(lanes, '3'), old, old)
      },
    })
    assert.equal(spawned(log), 2, log)
    assert.deepEqual(lanes, ['1', '2', '3'])
  })

  test('only stale lanes reap to 0 live', () => {
    const { log } = runPoll({
      maxConcurrent: 1,
      setup: (lanes) => {
        mkdirSync(join(lanes, '1'))
        writeFileSync(join(lanes, '1/pid'), String(deadPid()))
      },
    })
    assert.equal(spawned(log), 1, log)
  })
})
