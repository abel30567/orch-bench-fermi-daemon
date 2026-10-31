// poll.sh lane accounting end to end: the real script under a throwaway $HOME,
// with fake curl/pgrep/node/python3 on PATH (warm worker down, no network, no
// harness). `live` is not printed, so it is read back from the fallback fan-out:
// spawned drains = min(pending, MAX_CONCURRENT - live).
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, chmodSync, realpathSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ROOT } from './run-worker.mjs'

const LONG_AGO = new Date(Date.now() - 86_400_000)

function exe(path, body) {
  writeFileSync(path, body)
  chmodSync(path, 0o755)
}

function makeDaemon() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'poll-lanes-')))
  const daemon = join(home, 'fermi-daemon')
  const bin = join(home, 'fake-bin')
  for (const d of [join(daemon, 'lanes'), join(daemon, 'logs'), join(daemon, 'runs'), bin]) mkdirSync(d, { recursive: true })
  exe(join(bin, 'curl'), '#!/bin/sh\nprintf \'{"pending":%s}\' "$FAKE_PENDING"\n')
  exe(join(bin, 'pgrep'), '#!/bin/sh\nexit 1\n')
  exe(join(bin, 'python3'), '#!/bin/sh\nexit 0\n')
  exe(join(bin, 'fake-node'), '#!/bin/sh\n[ "$1" = -v ] && echo v22.0.0\nexit 0\n')
  // poll.sh only uses BSD `stat -f %m PATH`; CI runs on GNU coreutils.
  exe(join(bin, 'stat'), `#!/bin/sh\nexec "${process.execPath}" -e 'console.log(Math.floor(require("fs").statSync(process.argv[1]).mtimeMs / 1000))' "$3"\n`)
  writeFileSync(join(daemon, '.env'), `FERMI_URL=http://127.0.0.1:1\nFERMI_BEARER_TOKEN=test\nNODE_BIN=${join(bin, 'fake-node')}\n`)
  return { home, daemon, bin, lanes: join(daemon, 'lanes') }
}

function addLane(d, name, { pid, oldPid = false, oldDir = false } = {}) {
  const lane = join(d.lanes, name)
  mkdirSync(lane)
  if (pid !== undefined) writeFileSync(join(lane, 'pid'), `${pid}\n`)
  if (oldPid) utimesSync(join(lane, 'pid'), LONG_AGO, LONG_AGO)
  if (oldDir) utimesSync(lane, LONG_AGO, LONG_AGO)
}

const deadPid = () => spawnSync('true').pid

function runPoll(d, { maxConcurrent, pending }) {
  const res = spawnSync('zsh', [join(ROOT, 'poll.sh')], {
    env: { PATH: `${d.bin}:${process.env.PATH}`, HOME: d.home, MAX_CONCURRENT: String(maxConcurrent), MAX_RUN_SECONDS: '600', FAKE_PENDING: String(pending) },
    encoding: 'utf8',
    timeout: 30_000,
  })
  assert.equal(res.status, 0, res.stderr)
  const logPath = join(d.daemon, 'logs/poll.log')
  const log = existsSync(logPath) ? readFileSync(logPath, 'utf8') : ''
  return {
    log,
    drains: log.match(/spawned drain\.md in lane \d+/g)?.length ?? 0,
    laneNames: readdirSync(d.lanes).sort(),
  }
}

describe('poll.sh live-lane count', () => {
  // Live lanes hold a real process so `kill -0` passes.
  const withSleepers = async (n, fn) => {
    const kids = Array.from({ length: n }, () => spawn('sleep', ['120'], { stdio: 'ignore' }))
    try {
      return await fn(kids.map((k) => k.pid))
    } finally {
      for (const k of kids) k.kill('SIGKILL')
    }
  }

  test('empty lanes/ counts 0: MAX_CONCURRENT=1 still cold-spawns a drain lane', () => {
    const d = makeDaemon()
    const r = runPoll(d, { maxConcurrent: 1, pending: 1 })
    assert.equal(r.drains, 1, r.log)
    assert.deepEqual(r.laneNames, ['1'])
    assert.ok(existsSync(join(d.lanes, '1/pid')))
  })

  test('empty lanes/ counts 0: MAX_CONCURRENT=1 still runs the heartbeat sweep', () => {
    const d = makeDaemon()
    const r = runPoll(d, { maxConcurrent: 1, pending: 0 })
    assert.match(r.log, /spawned heartbeat\.md in lane 1/)
  })

  test('0 live lanes leaves every slot free', () => {
    const r = runPoll(makeDaemon(), { maxConcurrent: 5, pending: 9 })
    assert.equal(r.drains, 5, r.log)
  })

  for (const [live, free] of [[1, 4], [3, 2]]) {
    test(`${live} live lane(s) of 5 leave ${free} free`, () =>
      withSleepers(live, (pids) => {
        const d = makeDaemon()
        pids.forEach((pid, i) => addLane(d, String(i + 1), { pid }))
        const r = runPoll(d, { maxConcurrent: 5, pending: 9 })
        assert.equal(r.drains, free, r.log)
        assert.equal(r.laneNames.length, 5)
      }))
  }

  test('all lanes busy: nothing spawns', () =>
    withSleepers(3, (pids) => {
      const d = makeDaemon()
      pids.forEach((pid, i) => addLane(d, String(i + 1), { pid }))
      const r = runPoll(d, { maxConcurrent: 3, pending: 9 })
      assert.equal(r.drains, 0, r.log)
      assert.deepEqual(r.laneNames, ['1', '2', '3'])
    }))

  test('stale lanes are reaped before counting; a fresh claim still counts', () =>
    withSleepers(3, ([a, b, stuck]) => {
      const d = makeDaemon()
      addLane(d, '1', { pid: a })
      addLane(d, '2', { pid: b })
      addLane(d, '3') // just claimed, pid not written yet: live
      addLane(d, '4', { pid: deadPid() })
      addLane(d, '5', { oldDir: true }) // orphaned claim
      addLane(d, '6', { pid: stuck, oldPid: true }) // past the watchdog
      const r = runPoll(d, { maxConcurrent: 6, pending: 9 })
      assert.match(r.log, /watchdog: killing stuck lane 6/)
      assert.equal(r.drains, 3, r.log) // 6 slots - 3 live survivors
      assert.deepEqual(r.laneNames, ['1', '2', '3', '4', '5', '6'])
    }))

  test('only stale lanes: count falls to 0 and MAX_CONCURRENT=1 spawns', () => {
    const d = makeDaemon()
    addLane(d, '7', { pid: deadPid() })
    addLane(d, '8', { oldDir: true })
    const r = runPoll(d, { maxConcurrent: 1, pending: 1 })
    assert.equal(r.drains, 1, r.log)
    assert.deepEqual(r.laneNames, ['1'])
  })
})
