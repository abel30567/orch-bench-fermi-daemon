// poll.sh cold path: node resolution (NODE_BIN, else PATH), the >= 22 check and
// run-once's output landing in runs/<ts>.log. Runs the real poll.sh with HOME
// pointed at a temp daemon home and fake curl/pgrep/node on PATH (no network).
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, chmodSync, realpathSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { ROOT } from './run-worker.mjs'

const POLL = join(ROOT, 'poll.sh')
const ZSH = spawnSync('sh', ['-c', 'command -v zsh'], { encoding: 'utf8' }).stdout.trim()

function exe(path, body) {
  writeFileSync(path, `#!/bin/sh\n${body}\n`)
  chmodSync(path, 0o755)
}

// A temp HOME with ~/fermi-daemon (.env, logs/, runs/, prompts/) and a fake
// bin dir: curl reports `pending` tasks, pgrep finds no warm worker, and `node`
// on PATH reports `pathNodeVersion`.
function setup({ pending = 0, pathNodeVersion = 'v14.21.3', env = '' } = {}) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'pr50-')))
  const daemon = join(home, 'fermi-daemon')
  const fake = join(home, 'fakebin')
  for (const d of ['logs', 'runs', 'prompts', 'bin']) mkdirSync(join(daemon, d), { recursive: true })
  mkdirSync(fake)
  writeFileSync(join(daemon, '.env'), `FERMI_URL=http://127.0.0.1:9\nFERMI_BEARER_TOKEN=test\n${env}`)
  writeFileSync(join(daemon, 'prompts/drain.md'), 'drain\n')
  writeFileSync(join(daemon, 'prompts/heartbeat.md'), 'heartbeat\n')
  exe(join(fake, 'curl'), `echo '{"pending": ${pending}}'`)
  exe(join(fake, 'pgrep'), 'exit 1')
  exe(join(fake, 'python3'), 'exit 0')
  exe(join(fake, 'node'), `[ "$1" = -v ] && { echo ${pathNodeVersion}; exit 0; }\necho "path node ran: $*" >>"$HOME/path-node-ran"`)
  return { home, daemon, fake }
}

function poll({ home, fake }) {
  return spawnSync(ZSH, [POLL], {
    env: { HOME: home, PATH: `${fake}:/usr/bin:/bin:/usr/sbin:/sbin` },
    encoding: 'utf8',
  })
}

const pollLog = (daemon) => (existsSync(join(daemon, 'logs/poll.log')) ? readFileSync(join(daemon, 'logs/poll.log'), 'utf8') : '')
const lanes = (daemon) => (existsSync(join(daemon, 'lanes')) ? readdirSync(join(daemon, 'lanes')) : [])

async function waitFor(fn, ms = 10000) {
  const end = Date.now() + ms
  for (;;) {
    const v = fn()
    if (v) return v
    if (Date.now() > end) return v
    await sleep(50)
  }
}

describe('poll.sh node resolution', () => {
  test('a node on PATH older than 22 logs one error line, exits non-zero and takes no lane', () => {
    const ctx = setup({ pending: 2, pathNodeVersion: 'v14.21.3' })
    const r = poll(ctx)
    assert.equal(r.status, 1, r.stderr)
    const log = pollLog(ctx.daemon)
    const errors = log.split('\n').filter((l) => l.includes('ERROR:'))
    assert.equal(errors.length, 1, log)
    assert.ok(
      errors[0].endsWith(
        `ERROR: node '${join(ctx.fake, 'node')}' is v14.21.3; bin/run-once.mjs needs node >= 22 (set NODE_BIN in .env) — not spawning drain.md`,
      ),
      errors[0],
    )
    assert.doesNotMatch(log, /spawned/)
    assert.deepEqual(lanes(ctx.daemon), [])
    assert.equal(existsSync(join(ctx.home, 'path-node-ran')), false)
  })

  test('a too-old NODE_BIN is reported by its path and never spawned (heartbeat path)', () => {
    const ctx = setup({ pathNodeVersion: 'v22.9.0' })
    exe(join(ctx.home, 'old-node'), '[ "$1" = -v ] && { echo v18.0.0; exit 0; }\ntouch "$HOME/old-node-ran"')
    writeFileSync(join(ctx.daemon, '.env'), `NODE_BIN=${join(ctx.home, 'old-node')}\n`, { flag: 'a' })
    const r = poll(ctx)
    assert.equal(r.status, 1)
    assert.match(pollLog(ctx.daemon), new RegExp(`ERROR: node '${join(ctx.home, 'old-node')}' is v18\\.0\\.0; .* — not spawning heartbeat\\.md`))
    assert.deepEqual(lanes(ctx.daemon), [])
    assert.equal(existsSync(join(ctx.home, 'old-node-ran')), false)
    assert.equal(existsSync(join(ctx.daemon, 'last-heartbeat')), false)
  })

  test('no node at all is a loud error too', () => {
    const ctx = setup({ pending: 1 })
    // A PATH with the fakes and the coreutils poll.sh uses, but no node.
    const nonode = join(ctx.home, 'nonode')
    mkdirSync(nonode)
    for (const f of ['curl', 'pgrep', 'python3']) symlinkSync(join(ctx.fake, f), join(nonode, f))
    for (const tool of ['date', 'mkdir', 'rm', 'cat', 'ls', 'wc', 'tr', 'seq', 'find', 'stat', 'touch', 'grep']) {
      const p = spawnSync('sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).stdout.trim()
      if (p) symlinkSync(p, join(nonode, tool))
    }
    const r = spawnSync(ZSH, [POLL], { env: { HOME: ctx.home, PATH: nonode }, encoding: 'utf8' })
    assert.equal(r.status, 1, r.stderr)
    assert.deepEqual(lanes(ctx.daemon), [])
    assert.match(pollLog(ctx.daemon), /ERROR: node 'node' is vunknown; bin\/run-once\.mjs needs node >= 22 \(set NODE_BIN in \.env\) — not spawning drain\.md/)
  })

  test('NODE_BIN from .env is used over node on PATH', async () => {
    const ctx = setup({ pathNodeVersion: 'v22.9.0' })
    const good = join(ctx.home, 'my-node')
    exe(good, '[ "$1" = -v ] && { echo v22.11.0; exit 0; }\necho "$@" >"$HOME/my-node-args"')
    writeFileSync(join(ctx.daemon, '.env'), `NODE_BIN=${good}\n`, { flag: 'a' })
    const r = poll(ctx)
    assert.equal(r.status, 0, r.stderr)
    assert.match(pollLog(ctx.daemon), /spawned heartbeat\.md in lane 1/)
    const args = await waitFor(() => existsSync(join(ctx.home, 'my-node-args')) && readFileSync(join(ctx.home, 'my-node-args'), 'utf8'))
    assert.ok(args, 'NODE_BIN was not run')
    assert.match(args, new RegExp(`^${join(ctx.daemon, 'bin/run-once.mjs')} --prompt prompts/heartbeat\\.md --log runs/\\S+\\.log`))
    assert.equal(existsSync(join(ctx.home, 'path-node-ran')), false)
  })

  test("a crashing run-once leaves its error in runs/<ts>.log", async () => {
    const ctx = setup()
    writeFileSync(join(ctx.daemon, '.env'), `NODE_BIN=${process.execPath}\n`, { flag: 'a' })
    writeFileSync(join(ctx.daemon, 'bin/run-once.mjs'), "throw new Error('run-once exploded on startup')\n")
    const r = poll(ctx)
    assert.equal(r.status, 0, r.stderr)
    const runLog = pollLog(ctx.daemon).match(/log (runs\/\S+\.log)\)/)?.[1]
    assert.ok(runLog, pollLog(ctx.daemon))
    const text = await waitFor(() => {
      const p = join(ctx.daemon, runLog)
      const t = existsSync(p) ? readFileSync(p, 'utf8') : ''
      return t.includes('run-once exploded on startup') && t
    })
    assert.ok(text, `no crash output in ${runLog}`)
  })
})
