import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, chmodSync, copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ROOT } from './run-worker.mjs'

const sh = (path, body) => {
  writeFileSync(path, `#!/bin/sh\n${body}\n`)
  chmodSync(path, 0o755)
}

// A throwaway $HOME/fermi-daemon running the real poll.sh. PATH holds only
// fakes plus system dirs: pgrep says the warm worker is down, curl reports an
// empty queue (so poll.sh takes the heartbeat fallback), and `node` is a fake
// that reports `pathNodeVersion`.
function runPoll({ env = '', pathNodeVersion = 'v14.21.3', runOnce } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'poll-'))
  const daemon = join(home, 'fermi-daemon')
  const fakebin = join(home, 'fakebin')
  for (const d of ['bin', 'prompts']) mkdirSync(join(daemon, d), { recursive: true })
  mkdirSync(fakebin)
  copyFileSync(join(ROOT, 'poll.sh'), join(daemon, 'poll.sh'))
  writeFileSync(join(daemon, 'prompts/heartbeat.md'), 'check in\n')
  writeFileSync(join(daemon, 'bin/run-once.mjs'), runOnce ?? 'process.exit(0)\n')
  writeFileSync(join(daemon, '.env'), `FERMI_URL=http://127.0.0.1:9\nFERMI_BEARER_TOKEN=x\n${env}`)
  sh(join(fakebin, 'pgrep'), 'exit 1')
  sh(join(fakebin, 'curl'), `echo '{"pending":0}'`)
  sh(join(fakebin, 'node'), `echo ${pathNodeVersion}; echo "$@" >> "${home}/path-node.log"`)
  const r = spawnSync('/bin/zsh', [join(daemon, 'poll.sh')], {
    env: { HOME: home, PATH: `${fakebin}:/usr/bin:/bin:/usr/sbin:/sbin` },
    encoding: 'utf8',
  })
  const read = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : '')
  return {
    home,
    daemon,
    status: r.status,
    pollLog: read(join(daemon, 'logs/poll.log')),
    lanes: existsSync(join(daemon, 'lanes')) ? readdirSync(join(daemon, 'lanes')) : [],
    pathNodeCalls: read(join(home, 'path-node.log')),
  }
}

async function waitFor(fn, ms = 10000) {
  const end = Date.now() + ms
  for (;;) {
    const v = fn()
    if (v || Date.now() > end) return v
    await new Promise((r) => setTimeout(r, 50))
  }
}

const runLogs = (daemon) =>
  existsSync(join(daemon, 'runs')) ? readdirSync(join(daemon, 'runs')).map((f) => join(daemon, 'runs', f)) : []

describe('poll.sh cold path node resolution', () => {
  test('node v14 on PATH: one ERROR line in poll.log, non-zero exit, no lane', () => {
    const r = runPoll()
    assert.notEqual(r.status, 0)
    const errors = r.pollLog.split('\n').filter((l) => l.includes('ERROR'))
    assert.equal(errors.length, 1, r.pollLog)
    const node = join(r.home, 'fakebin/node')
    assert.ok(
      errors[0].endsWith(
        `ERROR: node '${node}' is v14.21.3; bin/run-once.mjs needs node >= 22 (set NODE_BIN in .env) — not spawning heartbeat.md`,
      ),
      errors[0],
    )
    assert.doesNotMatch(r.pollLog, /spawned/)
    assert.deepEqual(r.lanes, [])
    assert.deepEqual(runLogs(r.daemon), [])
  })

  test('a missing NODE_BIN fails loudly even when PATH node is new enough', () => {
    const r = runPoll({ pathNodeVersion: 'v22.1.0', env: `NODE_BIN=/nonexistent/old-node\n` })
    assert.notEqual(r.status, 0)
    assert.match(r.pollLog, /ERROR: node '\/nonexistent\/old-node' is v\?; .* not spawning heartbeat\.md/)
    assert.deepEqual(r.lanes, [])
  })

  test('NODE_BIN is honoured over an old node on PATH', async () => {
    const home = mkdtempSync(join(tmpdir(), 'nodebin-'))
    const marker = join(home, 'node-bin.log')
    const nodeBin = join(home, 'node22')
    sh(nodeBin, `echo "$@" >> "${marker}"\nexec "${process.execPath}" "$@"`)
    const r = runPoll({ env: `NODE_BIN=${nodeBin}\n` })
    assert.equal(r.status, 0, r.pollLog)
    assert.doesNotMatch(r.pollLog, /ERROR/)
    assert.match(r.pollLog, /spawned heartbeat\.md in lane 1/)
    const log = await waitFor(() => existsSync(marker) && readFileSync(marker, 'utf8').includes('run-once.mjs') && readFileSync(marker, 'utf8'))
    assert.match(log, /--version/)
    assert.match(log, /bin\/run-once\.mjs --prompt prompts\/heartbeat\.md/)
    assert.equal(r.pathNodeCalls, '')
  })

  test("a crashing run-once leaves its error in runs/<ts>.log", async () => {
    const r = runPoll({
      env: `NODE_BIN=${process.execPath}\n`,
      runOnce: `throw new Error('run-once exploded on startup')\n`,
    })
    assert.equal(r.status, 0, r.pollLog)
    const ts = r.pollLog.match(/log (runs\/[^)]+\.log)\)/)?.[1]
    assert.ok(ts, r.pollLog)
    const log = await waitFor(() => {
      const s = existsSync(join(r.daemon, ts)) ? readFileSync(join(r.daemon, ts), 'utf8') : ''
      return s.includes('run-once exploded on startup') && s
    })
    assert.ok(log, 'crash not captured in run log')
    assert.match(log, /Error: run-once exploded on startup/)
  })
})
