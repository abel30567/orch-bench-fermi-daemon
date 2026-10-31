// poll.sh live-lane accounting. Runs the real script under zsh against a
// throwaway $HOME/fermi-daemon, with shims for everything that would leave the
// machine or spawn a real run. poll.sh only reports the count through the
// fallback's "spawning N" (N = MAX_CONCURRENT - live), so that is what we assert.
import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const POLL = resolve(dirname(fileURLToPath(import.meta.url)), '../poll.sh')

const SHIMS = {
  curl: 'echo "{\\"pending\\": ${FAKE_PENDING:-0}}"',
  node: '[ "$1" = -v ] && echo v22.0.0\nexit 0',
  pgrep: 'exit 1', // warm worker down: the cold fallback is what we exercise
  python3: 'exit 0',
  sleep: 'exit 0',
  // poll.sh uses BSD `stat -f %m`; CI runs on Linux, where -f means something else.
  stat: '[ "$1" = -f ] && [ "$2" = %m ] && exec date -r "$3" +%s\nexit 1',
}

const cleanups = []
afterEach(() => {
  while (cleanups.length) cleanups.pop()()
})

function makeDaemon() {
  const home = mkdtempSync(join(tmpdir(), 'poll-test-'))
  cleanups.push(() => rmSync(home, { recursive: true, force: true, maxRetries: 5 }))
  const daemon = join(home, 'fermi-daemon')
  const shims = join(home, 'shims')
  for (const dir of ['lanes', 'logs', 'runs']) mkdirSync(join(daemon, dir), { recursive: true })
  mkdirSync(shims)
  for (const [name, body] of Object.entries(SHIMS)) {
    writeFileSync(join(shims, name), `#!/bin/sh\n${body}\n`)
    chmodSync(join(shims, name), 0o755)
  }
  writeFileSync(join(daemon, '.env'), 'FERMI_URL=http://localhost:1\nFERMI_BEARER_TOKEN=test\n')
  return { home, daemon, shims }
}

function livePid() {
  const child = spawn('sleep', ['60'], { stdio: 'ignore' })
  cleanups.push(() => child.kill('SIGKILL'))
  return child.pid
}

const deadPid = () => spawnSync('true').pid

function addLane({ daemon }, name, { pid, ageSeconds = 0 } = {}) {
  const lane = join(daemon, 'lanes', name)
  mkdirSync(lane)
  if (pid !== undefined) writeFileSync(join(lane, 'pid'), `${pid}\n`)
  const then = new Date(Date.now() - ageSeconds * 1000)
  utimesSync(pid === undefined ? lane : join(lane, 'pid'), then, then)
}

function poll({ home, shims, daemon }, { maxConcurrent, pending = 10, maxRunSeconds = 1200 }) {
  const res = spawnSync('zsh', [POLL], {
    encoding: 'utf8',
    env: {
      HOME: home,
      PATH: `${shims}:${process.env.PATH}`,
      MAX_CONCURRENT: String(maxConcurrent),
      MAX_RUN_SECONDS: String(maxRunSeconds),
      FAKE_PENDING: String(pending),
    },
  })
  assert.equal(res.status, 0, res.stderr)
  const logFile = join(daemon, 'logs/poll.log')
  const log = existsSync(logFile) ? readFileSync(logFile, 'utf8') : ''
  return {
    log,
    spawning: Number(log.match(/spawning (\d+)/)?.[1] ?? 0),
    spawnedDrains: log.match(/spawned drain\.md/g)?.length ?? 0,
    lanes: readdirSync(join(daemon, 'lanes')).sort(),
  }
}

test('empty lanes/ counts 0 live, so MAX_CONCURRENT=1 still spawns a drain lane', () => {
  const d = makeDaemon()
  const run = poll(d, { maxConcurrent: 1 })
  assert.equal(run.spawning, 1)
  assert.equal(run.spawnedDrains, 1)
  assert.deepEqual(run.lanes, ['1'])
  assert.ok(existsSync(join(d.daemon, 'lanes/1/pid')))
})

for (const count of [0, 1, 3]) {
  test(`${count} live lanes leave ${5 - count} of 5 free`, () => {
    const d = makeDaemon()
    const names = Array.from({ length: count }, (_, i) => String(i + 1))
    for (const name of names) addLane(d, name, { pid: livePid() })
    const run = poll(d, { maxConcurrent: 5 })
    assert.equal(run.spawning, 5 - count)
    assert.equal(run.spawnedDrains, 5 - count)
    assert.deepEqual(run.lanes, ['1', '2', '3', '4', '5'])
  })
}

test('a lane claimed moments ago, pid not written yet, counts as live', () => {
  const d = makeDaemon()
  addLane(d, '1')
  assert.equal(poll(d, { maxConcurrent: 3 }).spawning, 2)
})

test('no spawn when every lane is live', () => {
  const d = makeDaemon()
  addLane(d, '1', { pid: livePid() })
  const run = poll(d, { maxConcurrent: 1 })
  assert.equal(run.spawning, 0)
  assert.equal(run.spawnedDrains, 0)
})

test('dead, orphaned and stuck lanes are reaped before counting', () => {
  const d = makeDaemon()
  addLane(d, '1', { pid: livePid() })
  addLane(d, '2', { pid: deadPid() })
  addLane(d, '3', { ageSeconds: 500 }) // claimed, pid never written, past the 30s grace
  addLane(d, '4', { pid: livePid(), ageSeconds: 500 }) // past the watchdog
  const run = poll(d, { maxConcurrent: 5, maxRunSeconds: 100 })
  assert.match(run.log, /watchdog: killing stuck lane 4/)
  assert.equal(run.spawning, 4)
  assert.equal(run.spawnedDrains, 4)
})

test('reaping every stale lane leaves 0 live', () => {
  const d = makeDaemon()
  for (const name of ['1', '2', '3']) addLane(d, name, { pid: deadPid() })
  assert.equal(poll(d, { maxConcurrent: 3 }).spawning, 3)
})
