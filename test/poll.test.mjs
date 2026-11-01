import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ROOT } from './run-worker.mjs'

const POLL = join(ROOT, 'poll.sh')

const exe = (path, body) => {
  writeFileSync(path, `#!/bin/sh\n${body}\n`)
  chmodSync(path, 0o755)
  return path
}

// A fake node: answers `-v` with `version`, otherwise records that it was spawned.
const fakeNode = (path, version) =>
  exe(path, `if [ "$1" = -v ]; then echo v${version}; exit 0; fi\necho "$0 $*" >> "$(dirname "$0")/spawned"`)

// Runs poll.sh in a throwaway HOME with the warm worker "down" (stub pgrep), one
// pending task (stub curl), and no narrator (stub python3). `stubs` puts extra
// executables (e.g. a fake `node`) first on PATH; `env` lines go into .env.
function runPoll({ env = '', stubs = {}, runOnce } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'dmn7-poll-'))
  const daemon = join(home, 'fermi-daemon')
  const stubDir = join(home, 'stubs')
  for (const d of ['logs', 'runs', 'prompts', 'bin']) mkdirSync(join(daemon, d), { recursive: true })
  mkdirSync(stubDir)
  writeFileSync(join(daemon, '.env'), `FERMI_URL=http://127.0.0.1:9\nFERMI_BEARER_TOKEN=t\n${env}\n`)
  writeFileSync(join(daemon, 'prompts/drain.md'), 'drain\n')
  if (runOnce) writeFileSync(join(daemon, 'bin/run-once.mjs'), runOnce)
  exe(join(stubDir, 'pgrep'), 'exit 1')
  exe(join(stubDir, 'curl'), `echo '{"pending":1}'`)
  exe(join(stubDir, 'python3'), 'exit 0')
  for (const [name, body] of Object.entries(stubs)) exe(join(stubDir, name), body)
  const r = spawnSync('zsh', [POLL], {
    // MAX_CONCURRENT 2: poll.sh's live-lane count reads 1 when lanes/ is empty.
    env: { HOME: home, PATH: `${stubDir}:${process.env.PATH}`, MAX_CONCURRENT: '2' },
    stdio: 'ignore',
  })
  const read = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : '')
  return {
    home,
    daemon,
    status: r.status,
    pollLog: read(join(daemon, 'logs/poll.log')),
    lanes: existsSync(join(daemon, 'lanes')) ? readdirSync(join(daemon, 'lanes')) : [],
    runs: readdirSync(join(daemon, 'runs')),
    read,
  }
}

const waitFor = async (fn, ms = 5000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const v = fn()
    if (v) return v
    await new Promise((r) => setTimeout(r, 50))
  }
  return fn()
}

describe('poll.sh cold path node check', () => {
  test('AC1: node v14 on PATH → one poll.log ERROR line, non-zero exit, no lane, no spawn', () => {
    const home = mkdtempSync(join(tmpdir(), 'dmn7-node14-'))
    const node14 = fakeNode(join(home, 'node'), '14.21.3')
    const r = runPoll({ stubs: { node: `exec "${node14}" "$@"` } })
    assert.notEqual(r.status, 0)
    const errors = r.pollLog.split('\n').filter((l) => l.includes('ERROR'))
    assert.equal(errors.length, 1, r.pollLog)
    const nodePath = join(r.home, 'stubs/node')
    assert.ok(
      errors[0].endsWith(
        `ERROR: node '${nodePath}' is v14.21.3; bin/run-once.mjs needs node >= 22 (set NODE_BIN in .env) — not spawning drain.md`,
      ),
      errors[0],
    )
    assert.doesNotMatch(r.pollLog, /spawned/)
    assert.deepEqual(r.lanes, [])
    assert.deepEqual(r.runs, [])
    assert.ok(!existsSync(join(home, 'spawned')), 'node was not spawned')
  })

  test('missing NODE_BIN binary → ERROR line, no lane', () => {
    const r = runPoll({ env: 'NODE_BIN=/nonexistent/node' })
    assert.notEqual(r.status, 0)
    assert.match(r.pollLog, /ERROR: node '\/nonexistent\/node' not found; bin\/run-once\.mjs needs node >= 22 .* not spawning drain\.md/)
    assert.deepEqual(r.lanes, [])
  })

  test('AC2: NODE_BIN is honoured over node on PATH', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dmn7-nodebin-'))
    const node14 = fakeNode(join(home, 'node14'), '14.21.3')
    mkdirSync(join(home, 'good'))
    const node22 = fakeNode(join(home, 'good/node'), '22.3.0')
    const r = runPoll({ env: `NODE_BIN=${node22}`, stubs: { node: `exec "${node14}" "$@"` } })
    assert.equal(r.status, 0, r.pollLog)
    assert.doesNotMatch(r.pollLog, /ERROR/)
    assert.match(r.pollLog, /spawned drain\.md in lane 1/)
    const spawned = await waitFor(() => r.read(join(home, 'good/spawned')))
    assert.match(spawned, new RegExp(`^${node22} ${r.daemon}/bin/run-once\\.mjs --prompt prompts/drain\\.md --log runs/`))
    assert.ok(!existsSync(join(home, 'spawned')), 'PATH node not used')
  })

  test('AC3: a crashing run-once leaves its error in runs/<ts>.log', async () => {
    const r = runPoll({
      env: `NODE_BIN=${process.execPath}`,
      runOnce: `throw new Error('run-once exploded on startup')\n`,
    })
    assert.equal(r.status, 0, r.pollLog)
    const logName = r.pollLog.match(/log runs\/(\S+\.log)\)/)?.[1]
    assert.ok(logName, r.pollLog)
    const log = await waitFor(() => {
      const s = r.read(join(r.daemon, 'runs', logName))
      return /run-once exploded on startup/.test(s) && s
    })
    assert.match(log, /Error: run-once exploded on startup/)
  })
})
