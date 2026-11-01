// poll.sh's cold path (warm worker down, one pending task): node resolution
// and version gate, and run-once output landing in the run log.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, chmodSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ROOT } from './run-worker.mjs'

const POLL = join(ROOT, 'poll.sh')

const script = (path, body) => {
  writeFileSync(path, `#!/bin/sh\n${body}\n`)
  chmodSync(path, 0o755)
  return path
}

// A fake node that reports `version` and records each spawn's argv to `record`.
const fakeNode = (path, version, record) =>
  script(path, `if [ "$1" = --version ]; then echo v${version}; exit 0; fi\necho "$@" >>"${record}"`)

// Runs poll.sh in a throwaway HOME with pgrep (warm worker down), curl (one
// pending task) and python3 (the narrator) stubbed, and a v14 `node` first on PATH.
// `nodeBin(home)` → NODE_BIN for .env; `prompt: false` omits prompts/drain.md.
async function runPoll({ nodeBin, prompt = true, setup } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'dmn7-poll-'))
  const daemon = join(home, 'fermi-daemon')
  const stubs = join(home, 'stubs')
  for (const d of ['logs', 'runs', 'prompts']) mkdirSync(join(daemon, d), { recursive: true })
  mkdirSync(stubs)
  if (prompt) writeFileSync(join(daemon, 'prompts/drain.md'), 'drain the queue\n')
  const env = nodeBin ? `NODE_BIN=${nodeBin(home)}\n` : ''
  writeFileSync(join(daemon, '.env'), `FERMI_URL=http://127.0.0.1:9\nFERMI_BEARER_TOKEN=t\n${env}`)
  script(join(stubs, 'pgrep'), 'exit 1')
  script(join(stubs, 'curl'), `echo '{"pending":1}'`)
  script(join(stubs, 'python3'), 'exit 0')
  fakeNode(join(stubs, 'node'), '14.21.3', join(home, 'path-node.log'))
  setup?.({ home, daemon })
  const child = spawn('zsh', [POLL], {
    env: { HOME: home, PATH: `${stubs}:/usr/bin:/bin` },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout.on('data', (d) => (output += d))
  child.stderr.on('data', (d) => (output += d))
  const code = await new Promise((r) => child.on('exit', r))
  const read = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : '')
  return {
    home,
    daemon,
    code,
    output,
    pollLog: read(join(daemon, 'logs/poll.log')),
    lanes: existsSync(join(daemon, 'lanes')) ? readdirSync(join(daemon, 'lanes')) : [],
    runs: readdirSync(join(daemon, 'runs')),
    read,
  }
}

async function waitFor(fn, ms = 10_000) {
  for (const t0 = Date.now(); Date.now() - t0 < ms; await new Promise((r) => setTimeout(r, 50))) {
    const v = fn()
    if (v) return v
  }
  throw new Error('timed out waiting')
}

describe('poll.sh node gate', () => {
  test('node v14 on PATH: one ERROR line in poll.log, non-zero exit, no lane, no spawn', async () => {
    const r = await runPoll()
    assert.notEqual(r.code, 0, r.output)
    const errors = r.pollLog.split('\n').filter((l) => l.includes('ERROR'))
    assert.equal(errors.length, 1, r.pollLog)
    assert.ok(
      errors[0].endsWith(
        `ERROR: node '${join(r.home, 'stubs/node')}' is v14.21.3; bin/run-once.mjs needs node >= 22 (set NODE_BIN in .env) — not spawning drain.md`,
      ),
      errors[0],
    )
    assert.doesNotMatch(r.pollLog, /spawned/)
    assert.deepEqual(r.lanes, [])
    assert.deepEqual(r.runs, [])
    assert.equal(r.read(join(r.home, 'path-node.log')), '')
  })

  test('NODE_BIN from .env is used instead of node on PATH', async () => {
    const r = await runPoll({ nodeBin: (home) => fakeNode(join(home, 'node22'), '22.11.0', join(home, 'node-bin.log')) })
    assert.equal(r.code, 0, r.output + r.pollLog)
    assert.doesNotMatch(r.pollLog, /ERROR/)
    assert.match(r.pollLog, /spawned drain\.md in lane 1/)
    const argv = await waitFor(() => r.read(join(r.home, 'node-bin.log')))
    assert.match(argv, /fermi-daemon\/bin\/run-once\.mjs --prompt prompts\/drain\.md --log runs\/\S+\.log --lane /)
    assert.equal(r.read(join(r.home, 'path-node.log')), '', 'node on PATH not used')
  })

  test('a NODE_BIN that does not run fails loudly too', async () => {
    const r = await runPoll({ nodeBin: (home) => join(home, 'no-such-node') })
    assert.equal(r.code, 1)
    const errors = r.pollLog.split('\n').filter((l) => l.includes('ERROR'))
    assert.equal(errors.length, 1, r.pollLog)
    assert.ok(
      errors[0].endsWith(
        `ERROR: node '${join(r.home, 'no-such-node')}' not found; bin/run-once.mjs needs node >= 22 (set NODE_BIN in .env) — not spawning drain.md`,
      ),
      errors[0],
    )
    assert.deepEqual(r.lanes, [])
  })

  test('a crashing run-once leaves its error in runs/<ts>.log', async () => {
    // The real run-once, but prompts/drain.md is missing: it throws ENOENT.
    const r = await runPoll({
      nodeBin: () => process.execPath,
      prompt: false,
      setup: ({ daemon }) => symlinkSync(join(ROOT, 'bin'), join(daemon, 'bin')),
    })
    assert.equal(r.code, 0, r.output + r.pollLog)
    const logName = r.pollLog.match(/spawned drain\.md in lane 1 \(pid \d+, log (runs\/\S+\.log)\)/)?.[1]
    assert.ok(logName, r.pollLog)
    const log = await waitFor(() => {
      const s = r.read(join(r.daemon, logName))
      return /ENOENT/.test(s) && s
    })
    assert.match(log, /ENOENT[^\n]*prompts\/drain\.md/)
    await waitFor(() => !existsSync(join(r.daemon, 'lanes/1')))
  })
})
