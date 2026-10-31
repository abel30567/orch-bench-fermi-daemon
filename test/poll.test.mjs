// poll.sh end to end: the real zsh script in a throwaway HOME, with stubbed
// curl (pending count), pgrep (warm worker down), stat (portable mtime),
// python3 (narrator) and NODE_BIN (records the cold spawn and exits).
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync, realpathSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ROOT } from './run-worker.mjs'

const hasZsh = spawnSync('zsh', ['-c', 'true']).status === 0

function stub(dir, name, body) {
  const p = join(dir, name)
  writeFileSync(p, `#!/bin/sh\n${body}\n`)
  chmodSync(p, 0o755)
  return p
}

function sandbox() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'dmn7-')))
  const daemon = join(home, 'fermi-daemon')
  const bin = join(home, 'stub-bin')
  for (const d of [daemon, bin, join(daemon, 'logs'), join(daemon, 'runs'), join(daemon, 'lanes')]) mkdirSync(d, { recursive: true })
  stub(bin, 'curl', 'echo "{\\"pending\\": ${FAKE_PENDING:-0}}"')
  stub(bin, 'pgrep', 'exit 1')
  stub(bin, 'python3', 'exit 0')
  stub(bin, 'stat', `exec "${process.execPath}" -e 'console.log(Math.floor(require("fs").statSync(process.argv[1]).mtimeMs / 1000))' "$3"`)
  const node = stub(bin, 'fake-node', '[ "$1" = -v ] && { echo v22.0.0; exit 0; }\nexit 0')
  writeFileSync(join(daemon, '.env'), `FERMI_URL=http://127.0.0.1:9\nFERMI_BEARER_TOKEN=test\nNODE_BIN=${node}\n`)
  return { home, daemon, lanes: join(daemon, 'lanes'), bin }
}

function runPoll(sb, env) {
  const r = spawnSync('zsh', [join(ROOT, 'poll.sh')], {
    env: { PATH: `${sb.bin}:${process.env.PATH}`, HOME: sb.home, ...env },
    encoding: 'utf8',
    timeout: 30_000,
  })
  assert.equal(r.status, 0, r.stderr)
  const log = existsSync(join(sb.daemon, 'logs/poll.log')) ? readFileSync(join(sb.daemon, 'logs/poll.log'), 'utf8') : ''
  return { log, spawnedLanes: [...log.matchAll(/spawned drain\.md in lane (\d+)/g)].map((m) => m[1]) }
}

const sleeper = () => spawn('sleep', ['60'], { stdio: 'ignore' })
const alive = (pid) => { try { process.kill(pid, 0); return true } catch { return false } }
function deadPid() {
  const r = spawnSync('true')
  return r.pid
}
function lane(sb, name, pid, ageS = 0) {
  const dir = join(sb.lanes, name)
  mkdirSync(dir)
  const old = Date.now() / 1000 - ageS
  if (pid != null) {
    writeFileSync(join(dir, 'pid'), `${pid}\n`)
    utimesSync(join(dir, 'pid'), old, old)
  }
  utimesSync(dir, old, old)
}

describe('poll.sh live-lane count', { skip: !hasZsh && 'zsh not installed' }, () => {
  test('empty lanes/ counts 0 live lanes: MAX_CONCURRENT=1 spawns a drain lane', () => {
    const sb = sandbox()
    const { log, spawnedLanes } = runPoll(sb, { MAX_CONCURRENT: '1', FAKE_PENDING: '1' })
    assert.match(log, /spawning 1\b/)
    assert.deepEqual(spawnedLanes, ['1'])
    assert.ok(existsSync(join(sb.lanes, '1/pid')))
  })

  test('1 live lane: spawns MAX_CONCURRENT - 1', () => {
    const sb = sandbox()
    const p = sleeper()
    try {
      lane(sb, '1', p.pid)
      const { log, spawnedLanes } = runPoll(sb, { MAX_CONCURRENT: '5', FAKE_PENDING: '10' })
      assert.match(log, /spawning 4\b/)
      assert.deepEqual(spawnedLanes, ['2', '3', '4', '5'])
    } finally {
      p.kill('SIGKILL')
    }
  })

  test('3 live lanes plus dead, stuck and orphaned ones: stale lanes reaped, 3 counted', () => {
    const sb = sandbox()
    const live = [sleeper(), sleeper(), sleeper()]
    const stuck = sleeper()
    try {
      live.forEach((p, i) => lane(sb, String(i + 1), p.pid))
      lane(sb, '4', deadPid())
      lane(sb, '5', stuck.pid, 5000) // older than MAX_RUN_SECONDS → watchdog kill
      lane(sb, '6', null, 120) // claimed, no pid, >30s old → orphan
      const { log, spawnedLanes } = runPoll(sb, { MAX_CONCURRENT: '6', MAX_RUN_SECONDS: '1200', FAKE_PENDING: '10' })
      assert.match(log, /watchdog: killing stuck lane 5/)
      assert.match(log, /spawning 3\b/)
      assert.deepEqual(spawnedLanes, ['4', '5', '6'])
      live.forEach((p) => assert.ok(alive(p.pid)))
    } finally {
      for (const p of [...live, stuck]) p.kill('SIGKILL')
    }
  })

  test('full lanes: nothing spawns', () => {
    const sb = sandbox()
    const p = sleeper()
    try {
      lane(sb, '1', p.pid)
      const { log, spawnedLanes } = runPoll(sb, { MAX_CONCURRENT: '1', FAKE_PENDING: '3' })
      assert.deepEqual(spawnedLanes, [])
      assert.doesNotMatch(log, /spawning/)
    } finally {
      p.kill('SIGKILL')
    }
  })
})
