// poll.sh live-lane counting: run the real script against a fake $HOME with
// stub curl/pgrep/stat/python3 and a fake NODE_BIN; no network, no real harness.
import { test, describe, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync, utimesSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ROOT } from './run-worker.mjs'

const hasZsh = spawnSync('zsh', ['-c', 'true']).status === 0
const sleepers = []
after(() => sleepers.forEach((p) => p.kill('SIGKILL')))

const script = (path, body) => {
  writeFileSync(path, `#!/bin/bash\n${body}\n`)
  chmodSync(path, 0o755)
}

function setup({ pending }) {
  const home = mkdtempSync(join(tmpdir(), 'poll-lanes-'))
  const dh = join(home, 'fermi-daemon')
  const bin = join(home, 'stubs')
  for (const d of ['logs', 'runs', 'prompts', 'lanes', 'bin']) mkdirSync(join(dh, d), { recursive: true })
  mkdirSync(bin)
  const fakeNode = join(home, 'fake-node')
  script(fakeNode, '[ "$1" = -v ] && echo v22.0.0; exit 0')
  writeFileSync(join(dh, '.env'), `FERMI_URL=http://127.0.0.1:9\nFERMI_BEARER_TOKEN=test\nNODE_BIN=${fakeNode}\n`)
  script(join(bin, 'curl'), `echo '{"pending": ${pending}}'`)
  script(join(bin, 'pgrep'), 'exit 1') // warm worker down -> cold fallback
  script(join(bin, 'python3'), 'exit 0') // no narrator
  // poll.sh uses BSD `stat -f %m`; make it portable for Linux CI.
  script(join(bin, 'stat'), 'if [ "$1" = -f ] && [ "$2" = %m ]; then\n  /usr/bin/stat -f %m "$3" 2>/dev/null || /usr/bin/stat -c %Y "$3"\nelse exec /usr/bin/stat "$@"; fi')
  return { home, dh, bin, lanes: join(dh, 'lanes') }
}

const old = (p, secs) => {
  const t = Date.now() / 1000 - secs
  utimesSync(p, t, t)
}

function addLane(env, name, kind) {
  const dir = join(env.lanes, name)
  mkdirSync(dir)
  if (kind === 'orphan') return old(dir, 120) // no pid file, >30s old
  if (kind === 'dead') return writeFileSync(join(dir, 'pid'), '999999\n')
  const p = spawn('sleep', ['60'], { stdio: 'ignore' })
  sleepers.push(p)
  writeFileSync(join(dir, 'pid'), `${p.pid}\n`)
  if (kind === 'stuck') old(join(dir, 'pid'), 5000) // > MAX_RUN_SECONDS
  return p
}

function runPoll(env, extra) {
  const r = spawnSync('zsh', [join(ROOT, 'poll.sh')], {
    env: { PATH: `${env.bin}:${process.env.PATH}`, HOME: env.home, MAX_RUN_SECONDS: '1200', ...extra },
    encoding: 'utf8',
    timeout: 20000,
  })
  assert.equal(r.status, 0, r.stderr)
  const log = existsSync(join(env.dh, 'logs/poll.log')) ? readFileSync(join(env.dh, 'logs/poll.log'), 'utf8') : ''
  // spawn_run logs each spawn synchronously (the fake node exits immediately).
  const spawns = log.split('\n').filter((l) => / spawned \S+ in lane /.test(l))
  rmSync(env.home, { recursive: true, force: true, maxRetries: 3 })
  return { log, spawns }
}

describe('poll.sh live-lane count', { skip: !hasZsh && 'zsh not installed' }, () => {
  test('empty lanes/ counts 0 live lanes; MAX_CONCURRENT=1 spawns a drain lane', () => {
    const env = setup({ pending: 1 })
    const { log, spawns } = runPoll(env, { MAX_CONCURRENT: '1' })
    assert.match(log, /1 pending, spawning 1/)
    assert.equal(spawns.length, 1)
    assert.match(spawns[0], /spawned drain\.md in lane 1 /)
  })

  test('only stale lanes: all reaped, counts 0 live lanes', () => {
    const env = setup({ pending: 1 })
    addLane(env, '1', 'dead')
    addLane(env, '2', 'orphan')
    addLane(env, '3', 'stuck')
    const { log, spawns } = runPoll(env, { MAX_CONCURRENT: '1' })
    assert.match(log, /watchdog: killing stuck lane 3/)
    assert.match(log, /1 pending, spawning 1/)
    assert.equal(spawns.length, 1)
  })

  for (const n of [1, 3]) {
    test(`${n} live lane(s) plus stale ones count ${n}`, () => {
      const env = setup({ pending: 10 })
      for (let i = 1; i <= n; i++) addLane(env, String(i), 'live')
      addLane(env, '7', 'dead')
      addLane(env, '8', 'orphan')
      const { log, spawns } = runPoll(env, { MAX_CONCURRENT: '5' })
      assert.match(log, new RegExp(`10 pending, spawning ${5 - n}\\b`))
      assert.equal(spawns.length, 5 - n)
    })
  }
})
