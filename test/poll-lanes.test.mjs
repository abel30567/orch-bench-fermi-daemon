// poll.sh live-lane counting: runs the real poll.sh under zsh in a temp HOME
// with fake curl/pgrep/node/python3/stat on PATH (no network, no real harness).
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync, copyFileSync, utimesSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ROOT } from './run-worker.mjs'

const hasZsh = spawnSync('zsh', ['-c', 'true']).status === 0

function exe(path, body) {
  writeFileSync(path, body)
  chmodSync(path, 0o755)
}

function setup() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'poll-lanes-')))
  const daemon = join(home, 'fermi-daemon')
  const bin = join(home, 'bin')
  for (const d of [daemon, bin, join(daemon, 'logs'), join(daemon, 'runs'), join(daemon, 'lanes')]) mkdirSync(d, { recursive: true })
  copyFileSync(join(ROOT, 'poll.sh'), join(daemon, 'poll.sh'))
  const node = process.execPath
  // Fake node for run-once: reports v22, otherwise does nothing.
  exe(join(bin, 'fake-node'), '#!/bin/sh\nif [ "$1" = "-v" ]; then echo v22.0.0; fi\nexit 0\n')
  writeFileSync(join(daemon, '.env'), `FERMI_URL=http://127.0.0.1:9\nFERMI_BEARER_TOKEN=test\nNODE_BIN=${join(bin, 'fake-node')}\n`)
  exe(join(bin, 'curl'), '#!/bin/sh\necho \'{"pending": 10}\'\n')
  exe(join(bin, 'pgrep'), '#!/bin/sh\nexit 1\n') // warm worker down
  exe(join(bin, 'python3'), '#!/bin/sh\nexit 0\n') // narrator no-op
  // Portable `stat -f %m FILE` (BSD) -> mtime seconds, so the test also runs on Linux.
  exe(join(bin, 'stat'), `#!/bin/sh\nfor a; do f="$a"; done\nexec "${node}" -e 'console.log(Math.floor(require("fs").statSync(process.argv[1]).mtimeMs/1000))' "$f"\n`)
  return { home, daemon, bin, lanes: join(daemon, 'lanes') }
}

function runPoll(ctx, env) {
  const r = spawnSync('zsh', [join(ctx.daemon, 'poll.sh')], {
    env: { HOME: ctx.home, PATH: `${ctx.bin}:/usr/bin:/bin:/usr/sbin:/sbin`, HEARTBEAT_SECONDS: '999999', ...env },
    encoding: 'utf8',
    timeout: 30000,
  })
  assert.equal(r.status, 0, r.stderr)
  const log = existsSync(join(ctx.daemon, 'logs/poll.log')) ? readFileSync(join(ctx.daemon, 'logs/poll.log'), 'utf8') : ''
  // poll.sh logs each spawn synchronously (the fake node itself runs detached).
  const spawns = log.split('\n').filter((l) => / spawned \S+ in lane /.test(l))
  const m = log.match(/spawning (\d+)/)
  return { log, spawns, toSpawn: m ? Number(m[1]) : 0 }
}

// A lane whose pid is alive (this test process) and fresh.
function liveLane(ctx, n, pid = process.pid) {
  mkdirSync(join(ctx.lanes, String(n)))
  writeFileSync(join(ctx.lanes, String(n), 'pid'), String(pid))
}

function deadPid() {
  const r = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' })
  return Number(r.stdout)
}

describe('poll.sh live-lane count', { skip: !hasZsh && 'zsh not installed' }, () => {
  test('empty lanes/ counts 0 and MAX_CONCURRENT=1 spawns a drain lane', () => {
    const ctx = setup()
    const r = runPoll(ctx, { MAX_CONCURRENT: '1' })
    assert.equal(r.toSpawn, 1, r.log)
    assert.equal(r.spawns.length, 1)
    assert.match(r.spawns[0], /spawned drain\.md in lane 1/)
  })

  test('1 live lane: 5 - 1 = 4 spawned', () => {
    const ctx = setup()
    liveLane(ctx, 1)
    const r = runPoll(ctx, { MAX_CONCURRENT: '5' })
    assert.equal(r.toSpawn, 4, r.log)
    assert.equal(r.spawns.length, 4)
  })

  test('3 live lanes: 5 - 3 = 2 spawned', () => {
    const ctx = setup()
    for (const n of [1, 2, 3]) liveLane(ctx, n)
    const r = runPoll(ctx, { MAX_CONCURRENT: '5' })
    assert.equal(r.toSpawn, 2, r.log)
    assert.equal(r.spawns.length, 2)
  })

  test('MAX_CONCURRENT lanes all live: nothing spawned', () => {
    const ctx = setup()
    liveLane(ctx, 1)
    const r = runPoll(ctx, { MAX_CONCURRENT: '1' })
    assert.equal(r.toSpawn, 0, r.log)
    assert.equal(r.spawns.length, 0)
  })

  test('stale lanes are reaped before counting', async () => {
    const ctx = setup()
    const old = Date.now() / 1000 - 3600
    // live and fresh: kept
    liveLane(ctx, 1)
    // dead pid: reaped
    liveLane(ctx, 2, deadPid())
    // orphaned claim with no pid, >30s old: reaped
    mkdirSync(join(ctx.lanes, '3'))
    utimesSync(join(ctx.lanes, '3'), old, old)
    // stuck past the watchdog: killed and reaped
    const stuck = spawn('sleep', ['300'], { stdio: 'ignore' })
    liveLane(ctx, 4, stuck.pid)
    utimesSync(join(ctx.lanes, '4', 'pid'), old, old)
    const exited = new Promise((r) => stuck.on('exit', r))

    const r = runPoll(ctx, { MAX_CONCURRENT: '3', MAX_RUN_SECONDS: '60' })
    await exited
    assert.match(r.log, /watchdog: killing stuck lane 4/)
    // Only lane 1 was live after reaping: 3 - 1 = 2 spawned (lanes 2 and 3 reused).
    assert.equal(r.toSpawn, 2, r.log)
    assert.equal(r.spawns.length, 2)
    assert.match(r.log, /in lane 2 /)
    assert.match(r.log, /in lane 3 /)
  })
})
