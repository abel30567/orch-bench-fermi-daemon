// poll.sh's cold path (warm worker down): node resolution and run logging.
// Runs the real poll.sh under zsh against a throwaway $HOME/fermi-daemon with a
// fake bin/run-once.mjs, a pgrep that never sees the warm worker, and an
// unreachable FERMI_URL (0 pending -> the heartbeat fallback spawn).
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync, execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ROOT } from './run-worker.mjs'

const POLL = join(ROOT, 'poll.sh')
const ZSH = (() => {
  try {
    return execFileSync('sh', ['-c', 'command -v zsh'], { encoding: 'utf8' }).trim()
  } catch {
    return ''
  }
})()

const RUN_ONCE_OK = `import { appendFileSync } from 'node:fs'
appendFileSync('ran.log', JSON.stringify(process.argv.slice(2)) + '\\n')
`
const RUN_ONCE_CRASH = `throw new Error('kaboom: run-once crashed before opening --log')\n`

const script = (path, body) => {
  writeFileSync(path, `#!/bin/sh\n${body}\n`)
  chmodSync(path, 0o755)
  return path
}

function daemonHome({ env = '', runOnce = RUN_ONCE_OK } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'poll-'))
  const dir = join(home, 'fermi-daemon')
  for (const d of ['prompts', 'bin', 'logs', 'runs']) mkdirSync(join(dir, d), { recursive: true })
  writeFileSync(join(dir, '.env'), `FERMI_URL=http://127.0.0.1:1\nFERMI_BEARER_TOKEN=t\n${env}`)
  writeFileSync(join(dir, 'prompts/heartbeat.md'), 'check in\n')
  writeFileSync(join(dir, 'prompts/drain.md'), 'drain\n')
  writeFileSync(join(dir, 'bin/run-once.mjs'), runOnce)
  const fakebin = join(home, 'fakebin')
  mkdirSync(fakebin)
  script(join(fakebin, 'pgrep'), 'exit 1') // warm worker is down
  return { home, dir, fakebin }
}

const fakeNode = (path, version) =>
  script(path, `[ "$1" = --version ] && { echo v${version}; exit 0; }\necho "fake node v${version} ran: $*" >>"$HOME/fake-node.log"\nexit 1`)

function poll({ home, fakebin }) {
  const r = spawnSync(ZSH, [POLL], {
    env: { HOME: home, PATH: `${fakebin}:/usr/bin:/bin:/usr/sbin:/sbin` },
    encoding: 'utf8',
    timeout: 20_000,
  })
  return r.status
}

const read = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : '')
const lanes = (dir) => (existsSync(join(dir, 'lanes')) ? readdirSync(join(dir, 'lanes')) : [])
const runLogs = (dir) => readdirSync(join(dir, 'runs')).filter((f) => f.endsWith('.log'))

async function until(fn, ms = 10_000) {
  for (const t0 = Date.now(); !fn(); ) {
    if (Date.now() - t0 > ms) throw new Error('timed out waiting')
    await new Promise((r) => setTimeout(r, 25))
  }
}

const errorLine = (node, version) =>
  `ERROR: node '${node}' is v${version}; bin/run-once.mjs needs node >= 22 (set NODE_BIN in .env) — not spawning heartbeat.md`

describe('poll.sh cold path: node resolution', { skip: !ZSH && 'zsh not installed' }, () => {
  test('a node v14 on PATH: one error line in poll.log, non-zero exit, no lane, no spawn', () => {
    const h = daemonHome()
    const node = fakeNode(join(h.fakebin, 'node'), '14.21.3')
    const code = poll(h)
    assert.notEqual(code, 0)
    const log = read(join(h.dir, 'logs/poll.log'))
    const errors = log.split('\n').filter((l) => l.includes('ERROR'))
    assert.equal(errors.length, 1, log)
    assert.match(errors[0], /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d /)
    assert.ok(errors[0].endsWith(errorLine(node, '14.21.3')), errors[0])
    assert.ok(!/spawned/.test(log), log)
    assert.deepEqual(lanes(h.dir), [])
    assert.deepEqual(runLogs(h.dir), [])
    assert.equal(read(join(h.home, 'fake-node.log')), '')
    assert.ok(!existsSync(join(h.dir, 'ran.log')))
    assert.ok(!existsSync(join(h.dir, 'last-heartbeat')), 'heartbeat retried on the next poll')
  })

  test('a NODE_BIN that does not exist: error line, no spawn', () => {
    const h = daemonHome({ env: 'NODE_BIN=/nonexistent/node\n' })
    assert.notEqual(poll(h), 0)
    const log = read(join(h.dir, 'logs/poll.log'))
    assert.ok(log.includes(errorLine('/nonexistent/node', '?')), log)
    assert.deepEqual(lanes(h.dir), [])
  })

  test('NODE_BIN from .env is honoured over an old node on PATH', async () => {
    const h = daemonHome()
    fakeNode(join(h.fakebin, 'node'), '14.21.3')
    const good = script(join(h.home, 'node22'), `[ "$1" = --version ] || echo "$*" >>"$HOME/node-bin.log"\nexec "${process.execPath}" "$@"`)
    writeFileSync(join(h.dir, '.env'), `NODE_BIN=${good}\n`, { flag: 'a' })
    assert.equal(poll(h), 0)
    await until(() => existsSync(join(h.dir, 'ran.log')))
    const log = read(join(h.dir, 'logs/poll.log'))
    assert.ok(!log.includes('ERROR'), log)
    assert.match(log, /spawned heartbeat\.md in lane 1/)
    assert.match(read(join(h.home, 'node-bin.log')), /bin\/run-once\.mjs --prompt prompts\/heartbeat\.md/)
    assert.equal(read(join(h.home, 'fake-node.log')), '')
    const argv = JSON.parse(read(join(h.dir, 'ran.log')))
    assert.deepEqual(argv.slice(argv.indexOf('--session'), argv.indexOf('--session') + 2), ['--session', 'session.id'])
  })

  test('a crashing run-once leaves its error in runs/<ts>.log', async () => {
    const h = daemonHome({ env: `NODE_BIN=${process.execPath}\n`, runOnce: RUN_ONCE_CRASH })
    assert.equal(poll(h), 0)
    const log = read(join(h.dir, 'logs/poll.log'))
    const runLog = log.match(/log (runs\/[^)]+\.log)\)/)?.[1]
    assert.ok(runLog, log)
    await until(() => /kaboom: run-once crashed/.test(read(join(h.dir, runLog))))
    assert.deepEqual(runLogs(h.dir), [runLog.slice('runs/'.length)])
  })
})
