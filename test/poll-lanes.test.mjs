// poll.sh lane accounting: runs the real poll.sh in a throwaway HOME with fake
// curl/pgrep/node/python3/stat on PATH (no network, no real harness) and reads
// the live-lane count back from how many drain lanes the cold fallback spawns.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, chmodSync, utimesSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ROOT } from './run-worker.mjs'

const hasZsh = spawnSync('zsh', ['-c', 'true']).status === 0

function shim(dir, name, body) {
  const p = join(dir, name)
  writeFileSync(p, `#!/bin/sh\n${body}\n`)
  chmodSync(p, 0o755)
}

// A long-lived process to stand in for a running lane's harness.
function liveProc() {
  const child = spawn('sleep', ['60'], { stdio: 'ignore', detached: true })
  child.unref()
  return child
}

// lanes: [{ name, pid?, ageS? }] — ageS backdates the lane (or its pid file).
function runPoll({ lanes = [], maxConcurrent, pending = 10, env = {} }) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'pr54-')))
  const daemon = join(home, 'fermi-daemon')
  const bin = join(home, 'bin')
  for (const d of [daemon, bin, join(daemon, 'logs'), join(daemon, 'runs'), join(daemon, 'lanes')]) mkdirSync(d, { recursive: true })
  writeFileSync(join(daemon, '.env'), 'FERMI_URL=http://127.0.0.1:9\nFERMI_BEARER_TOKEN=test\n')
  const spawned = join(home, 'spawned')
  mkdirSync(spawned)
  shim(bin, 'curl', `echo '{"pending": ${pending}}'`)
  shim(bin, 'pgrep', 'exit 1') // warm worker down → cold fallback path
  shim(bin, 'python3', 'exit 0') // narrator
  shim(bin, 'node', `[ "$1" = -v ] && { echo v22.0.0; exit 0; }; touch "${spawned}/$$"; exit 0`)
  // Portable `stat -f %m FILE` (BSD form poll.sh uses) for Linux CI.
  shim(bin, 'stat', `exec "${process.execPath}" -e 'process.stdout.write(String(Math.floor(require("fs").statSync(process.argv[1]).mtimeMs/1000)))' "$3"`)
  const now = Date.now() / 1000
  for (const l of lanes) {
    const dir = join(daemon, 'lanes', l.name)
    mkdirSync(dir)
    if (l.pid !== undefined) {
      writeFileSync(join(dir, 'pid'), `${l.pid}\n`)
      if (l.ageS) utimesSync(join(dir, 'pid'), now - l.ageS, now - l.ageS)
    }
    if (l.ageS) utimesSync(dir, now - l.ageS, now - l.ageS)
  }
  const r = spawnSync('zsh', [join(ROOT, 'poll.sh')], {
    env: { PATH: `${bin}:/usr/bin:/bin`, HOME: home, MAX_CONCURRENT: String(maxConcurrent), MAX_RUN_SECONDS: '600', ...env },
    encoding: 'utf8',
    timeout: 30_000,
  })
  const log = existsSync(join(daemon, 'logs/poll.log')) ? readFileSync(join(daemon, 'logs/poll.log'), 'utf8') : ''
  const m = log.match(/spawning (\d+)/)
  return {
    status: r.status,
    stderr: r.stderr,
    log,
    toSpawn: m ? Number(m[1]) : 0,
    lanesLeft: readdirSync(join(daemon, 'lanes')).sort(),
  }
}

describe('poll.sh live-lane count', { skip: !hasZsh && 'zsh not installed' }, () => {
  test('empty lanes/ counts 0 live lanes; MAX_CONCURRENT=1 spawns a drain lane', () => {
    const r = runPoll({ maxConcurrent: 1 })
    assert.equal(r.status, 0, r.stderr)
    assert.equal(r.toSpawn, 1, r.log)
    assert.match(r.log, /spawned drain\.md in lane 1 /)
  })

  test('0 lanes with MAX_CONCURRENT=5 → 5 free', () => {
    const r = runPoll({ maxConcurrent: 5 })
    assert.equal(r.toSpawn, 5, r.log)
  })

  test('1 live lane → MAX_CONCURRENT-1 free', () => {
    const p = liveProc()
    try {
      const r = runPoll({ maxConcurrent: 5, lanes: [{ name: '1', pid: p.pid }] })
      assert.equal(r.toSpawn, 4, r.log)
      const full = runPoll({ maxConcurrent: 1, lanes: [{ name: '1', pid: p.pid }] })
      assert.equal(full.toSpawn, 0, full.log)
      assert.doesNotMatch(full.log, /spawned/)
    } finally {
      p.kill()
    }
  })

  test('3 live lanes → MAX_CONCURRENT-3 free', () => {
    const ps = [liveProc(), liveProc(), liveProc()]
    try {
      const r = runPoll({ maxConcurrent: 5, lanes: ps.map((p, i) => ({ name: String(i + 1), pid: p.pid })) })
      assert.equal(r.toSpawn, 2, r.log)
    } finally {
      for (const p of ps) p.kill()
    }
  })

  test('stale lanes are reaped before counting', () => {
    const live = liveProc()
    const stuck = liveProc()
    const dead = spawnSync('true').pid // exited → kill -0 fails
    try {
      const r = runPoll({
        maxConcurrent: 5,
        lanes: [
          { name: '1', pid: live.pid }, // live: kept
          { name: '2', pid: dead }, // dead pid: reaped
          { name: '3', ageS: 120 }, // pid never written, orphaned: reaped
          { name: '4', pid: stuck.pid, ageS: 3600 }, // past MAX_RUN_SECONDS: killed + reaped
        ],
      })
      assert.match(r.log, /watchdog: killing stuck lane 4/)
      assert.equal(r.toSpawn, 4, r.log) // only lane 1 is live
      // Lane 1 survives; the 4 new drain lanes take 2..5.
      assert.deepEqual(r.lanesLeft, ['1', '2', '3', '4', '5'])
    } finally {
      live.kill()
      stuck.kill()
    }
  })
})
