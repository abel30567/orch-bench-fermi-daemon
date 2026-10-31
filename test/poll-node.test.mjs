// poll.sh cold path: node resolution ($NODE_BIN, else PATH), the >= 22 gate and
// run-once's output landing in runs/<ts>.log. Runs the real poll.sh in a
// throwaway HOME with fake curl/pgrep (warm worker down, nothing pending) so it
// takes the heartbeat fallback spawn.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, chmodSync, copyFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ROOT } from './run-worker.mjs'

const hasZsh = spawnSync('zsh', ['-c', 'true']).status === 0

function script(path, body) {
  writeFileSync(path, `#!/bin/sh\n${body}\n`)
  chmodSync(path, 0o755)
  return path
}

// runOnce: source of the daemon's bin/run-once.mjs. Returns { home, daemon, poll() }.
function setup({ env = '', pathNode = 'real', runOnce = 'process.exit(0)\n' } = {}) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'poll-node-')))
  const daemon = join(home, 'fermi-daemon')
  const fakeBin = join(home, 'fakebin')
  for (const d of [daemon, fakeBin, join(daemon, 'bin'), join(daemon, 'prompts')]) mkdirSync(d, { recursive: true })
  copyFileSync(join(ROOT, 'poll.sh'), join(daemon, 'poll.sh'))
  writeFileSync(join(daemon, 'bin/run-once.mjs'), runOnce)
  writeFileSync(join(daemon, 'prompts/heartbeat.md'), 'hi\n')
  writeFileSync(join(daemon, '.env'), `FERMI_URL=http://127.0.0.1:9\nFERMI_BEARER_TOKEN=x\n${env}`)
  script(join(fakeBin, 'curl'), 'exit 7')
  script(join(fakeBin, 'pgrep'), 'exit 1')
  if (pathNode === 'v14') script(join(fakeBin, 'node'), '[ "$1" = --version ] && { echo v14.21.3; exit 0; }\necho "fake node v14 ran" >&2; exit 1')
  else script(join(fakeBin, 'node'), `exec "${process.execPath}" "$@"`)
  const poll = () =>
    spawnSync('zsh', [join(daemon, 'poll.sh')], {
      env: { HOME: home, PATH: `${fakeBin}:/usr/bin:/bin:/usr/sbin:/sbin` },
      encoding: 'utf8',
    })
  return { home, daemon, poll }
}

const pollLog = (daemon) => readFileSync(join(daemon, 'logs/poll.log'), 'utf8')

async function waitFor(fn, ms = 5000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const v = fn()
    if (v) return v
    await new Promise((r) => setTimeout(r, 50))
  }
  return fn()
}

test('a node older than 22 logs one clear error, exits non-zero and spawns nothing', { skip: !hasZsh }, () => {
  const { daemon, poll } = setup({ pathNode: 'v14' })
  const r = poll()
  assert.notEqual(r.status, 0)
  const errors = pollLog(daemon).split('\n').filter((l) => l.includes('ERROR'))
  assert.equal(errors.length, 1)
  assert.match(
    errors[0],
    /ERROR: node '\S+\/fakebin\/node' is v14\.21\.3; bin\/run-once\.mjs needs node >= 22 \(set NODE_BIN in \.env\) — not spawning heartbeat\.md$/,
  )
  assert.deepEqual(readdirSync(join(daemon, 'lanes')), [])
  assert.deepEqual(readdirSync(join(daemon, 'runs')), [])
  assert.doesNotMatch(pollLog(daemon), /spawned/)
})

test('NODE_BIN from .env is used instead of the node on PATH', { skip: !hasZsh }, async () => {
  const { home, daemon, poll } = setup({ pathNode: 'v14' })
  const marker = join(home, 'node-bin-used')
  const nodeBin = script(join(home, 'my-node'), `[ "$1" = --version ] || touch "${marker}"\nexec "${process.execPath}" "$@"`)
  writeFileSync(join(daemon, '.env'), readFileSync(join(daemon, '.env'), 'utf8') + `NODE_BIN=${nodeBin}\n`)
  const r = poll()
  assert.equal(r.status, 0, r.stderr)
  assert.doesNotMatch(pollLog(daemon), /ERROR/)
  assert.match(pollLog(daemon), /spawned heartbeat\.md in lane 1/)
  assert.ok(await waitFor(() => existsSync(marker)), 'run-once was not started with NODE_BIN')
})

test('a crashing run-once leaves its error in runs/<ts>.log', { skip: !hasZsh }, async () => {
  const { daemon, poll } = setup({ runOnce: "throw new Error('run-once exploded')\n" })
  const r = poll()
  assert.equal(r.status, 0, r.stderr)
  const runs = join(daemon, 'runs')
  const log = await waitFor(() => {
    const [f] = readdirSync(runs).filter((n) => n.endsWith('.log'))
    const s = f ? readFileSync(join(runs, f), 'utf8') : ''
    return s.includes('run-once exploded') && s
  })
  assert.ok(log, 'run-once error not found in runs/<ts>.log')
})
