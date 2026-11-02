// poll.sh's cold path (DMN-7 ruling): node is resolved from NODE_BIN or PATH,
// a missing/too-old node is a loud poll.log error with no spawn, and
// run-once's own stdout/stderr land in the run's log.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, chmodSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ROOT } from './run-worker.mjs'

const hasZsh = spawnSync('zsh', ['-c', 'true']).status === 0
const exe = (path, body) => {
  writeFileSync(path, `#!/bin/sh\n${body}\n`)
  chmodSync(path, 0o755)
}

// Runs the real poll.sh in a throwaway HOME with one pending task, the warm
// worker down (fake pgrep) and a fake curl. `node` is the PATH node (a fake
// reporting `pathNodeVersion` if given); `dotenv` is extra .env content.
function runPoll({ pathNodeVersion, dotenv = '' } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'dmn7-poll-'))
  const daemon = join(home, 'fermi-daemon')
  const fakeBin = join(home, 'fakebin')
  for (const d of ['logs', 'runs', 'prompts']) mkdirSync(join(daemon, d), { recursive: true })
  mkdirSync(fakeBin)
  symlinkSync(join(ROOT, 'poll.sh'), join(daemon, 'poll.sh'))
  symlinkSync(join(ROOT, 'bin'), join(daemon, 'bin'))
  writeFileSync(join(daemon, '.env'), `FERMI_URL=http://127.0.0.1:9\nFERMI_BEARER_TOKEN=t\n${dotenv}\n`)
  exe(join(fakeBin, 'pgrep'), 'exit 1')
  exe(join(fakeBin, 'curl'), `echo '{"pending": 1}'`)
  exe(join(fakeBin, 'python3'), 'exit 0') // narrator
  if (pathNodeVersion) exe(join(fakeBin, 'node'), `echo v${pathNodeVersion}`)
  else symlinkSync(process.execPath, join(fakeBin, 'node'))
  const r = spawnSync('zsh', [join(daemon, 'poll.sh')], {
    env: { HOME: home, PATH: `${fakeBin}:/usr/bin:/bin` },
    encoding: 'utf8',
  })
  const pollLog = existsSync(join(daemon, 'logs/poll.log')) ? readFileSync(join(daemon, 'logs/poll.log'), 'utf8') : ''
  return { home, daemon, fakeBin, status: r.status, stderr: r.stderr, pollLog }
}

const lanes = (daemon) => (existsSync(join(daemon, 'lanes')) ? readdirSync(join(daemon, 'lanes')) : [])
const runLogs = (daemon) => readdirSync(join(daemon, 'runs')).filter((f) => f.endsWith('.log'))

async function waitFor(fn, ms = 10_000) {
  for (const t0 = Date.now(); !fn(); await new Promise((r) => setTimeout(r, 50))) {
    if (Date.now() - t0 > ms) throw new Error('timed out')
  }
}

describe('poll.sh node resolution', { skip: !hasZsh && 'zsh not installed' }, () => {
  test('AC1: a v14 node on PATH logs the error line, exits non-zero, spawns nothing', () => {
    const r = runPoll({ pathNodeVersion: '14.21.3' })
    assert.notEqual(r.status, 0)
    const node = join(r.fakeBin, 'node')
    const line = `ERROR: node '${node}' is v14.21.3; bin/run-once.mjs needs node >= 22 (set NODE_BIN in .env) — not spawning drain.md\n`
    assert.ok(r.pollLog.endsWith(line), r.pollLog)
    assert.equal(r.pollLog.match(/ERROR:/g).length, 1)
    assert.doesNotMatch(r.pollLog, /spawned/)
    assert.deepEqual(lanes(r.daemon), [])
    assert.deepEqual(runLogs(r.daemon), [])
  })

  test('AC2: NODE_BIN from .env wins over PATH (old NODE_BIN refused)', () => {
    const home = mkdtempSync(join(tmpdir(), 'dmn7-nb-'))
    const old = join(home, 'node14')
    exe(old, 'echo v14.0.0')
    const r = runPoll({ dotenv: `NODE_BIN=${old}` }) // PATH node is the real, new one
    assert.notEqual(r.status, 0)
    assert.ok(r.pollLog.includes(`ERROR: node '${old}' is v14.0.0; `), r.pollLog)
    assert.deepEqual(lanes(r.daemon), [])
  })

  test('AC2: a good NODE_BIN is the node that runs run-once', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dmn7-nb-'))
    const marker = join(home, 'used')
    const good = join(home, 'node-good')
    exe(good, `echo "$@" >>"${marker}"\nexec "${process.execPath}" "$@"`)
    const r = runPoll({ pathNodeVersion: '14.0.0', dotenv: `NODE_BIN=${good}` })
    assert.equal(r.status, 0, r.pollLog + r.stderr)
    assert.doesNotMatch(r.pollLog, /ERROR/)
    assert.match(r.pollLog, /spawned drain\.md in lane 1/)
    await waitFor(() => existsSync(marker) && /run-once\.mjs/.test(readFileSync(marker, 'utf8')))
  })

  test('AC3: a crashing run-once leaves its error in runs/<ts>.log', async () => {
    // No prompts/drain.md: run-once dies with an uncaught ENOENT on stderr.
    const r = runPoll()
    assert.equal(r.status, 0, r.pollLog + r.stderr)
    assert.match(r.pollLog, /spawned drain\.md in lane 1 /)
    await waitFor(() => runLogs(r.daemon).length === 1)
    const logFile = join(r.daemon, 'runs', runLogs(r.daemon)[0])
    await waitFor(() => /ENOENT/.test(readFileSync(logFile, 'utf8')))
    assert.match(readFileSync(logFile, 'utf8'), /ENOENT: no such file or directory, open 'prompts\/drain\.md'/)
  })
})
