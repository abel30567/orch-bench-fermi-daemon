import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ROOT } from './run-worker.mjs'

const POLL = join(ROOT, 'poll.sh')

const script = (path, body) => {
  writeFileSync(path, body)
  chmodSync(path, 0o755)
  return path
}

// Runs poll.sh against a fake daemon home ($HOME/fermi-daemon) with one pending
// task, the warm worker down, and a fake bin/run-once.mjs. `bin` holds fakes
// that shadow PATH (curl, pgrep and optionally node).
function runPoll({ env = '', runOnce = "console.log('run-once ran')\n", pathNode } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'dmn7-poll-'))
  const daemon = join(home, 'fermi-daemon')
  for (const d of ['logs', 'runs', 'prompts', 'bin', 'fakebin']) mkdirSync(join(daemon, d), { recursive: true })
  writeFileSync(join(daemon, '.env'), `FERMI_URL=http://127.0.0.1:9\nFERMI_BEARER_TOKEN=t\n${env}`)
  writeFileSync(join(daemon, 'prompts/drain.md'), 'drain\n')
  writeFileSync(join(daemon, 'bin/run-once.mjs'), runOnce)
  const fakebin = join(daemon, 'fakebin')
  script(join(fakebin, 'curl'), `#!/bin/sh\necho '{"pending": 1}'\n`)
  script(join(fakebin, 'pgrep'), '#!/bin/sh\nexit 1\n')
  if (pathNode) script(join(fakebin, 'node'), pathNode)
  const r = spawnSync('zsh', [POLL], {
    env: { PATH: `${fakebin}:${process.env.PATH}`, HOME: home },
    encoding: 'utf8',
    timeout: 20_000,
  })
  const pollLog = existsSync(join(daemon, 'logs/poll.log')) ? readFileSync(join(daemon, 'logs/poll.log'), 'utf8') : ''
  return { daemon, fakebin, status: r.status, pollLog, lanes: readdirSync(join(daemon, 'lanes')) }
}

const NODE14 = '#!/bin/sh\necho v14.21.3\n'

async function waitForRunLog(daemon, re) {
  for (const t0 = Date.now(); Date.now() - t0 < 10_000; await new Promise((r) => setTimeout(r, 50))) {
    for (const f of readdirSync(join(daemon, 'runs'))) {
      const text = readFileSync(join(daemon, 'runs', f), 'utf8')
      if (re.test(text)) return { file: f, text }
    }
  }
  return null
}

describe('poll.sh node resolution', () => {
  test('a node v14 on PATH logs the error line, exits non-zero, spawns no lane', () => {
    const r = runPoll({ pathNode: NODE14 })
    assert.notEqual(r.status, 0)
    const node = join(r.fakebin, 'node')
    const errors = r.pollLog.split('\n').filter((l) => l.includes('ERROR:'))
    assert.equal(errors.length, 1, r.pollLog)
    assert.ok(
      errors[0].endsWith(
        `ERROR: node '${node}' is v14.21.3; bin/run-once.mjs needs node >= 22 (set NODE_BIN in .env) — not spawning drain.md`,
      ),
      errors[0],
    )
    assert.doesNotMatch(r.pollLog, /spawned/)
    assert.deepEqual(r.lanes, [])
    assert.deepEqual(readdirSync(join(r.daemon, 'runs')), [])
  })

  test('NODE_BIN from .env pointing at an old node is checked too', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dmn7-old-'))
    const old = script(join(dir, 'node14'), NODE14)
    const r = runPoll({ env: `NODE_BIN=${old}\n` })
    assert.notEqual(r.status, 0)
    assert.match(r.pollLog, new RegExp(`ERROR: node '${old}' is v14\\.21\\.3; .* — not spawning drain\\.md`))
    assert.deepEqual(r.lanes, [])
  })

  test('NODE_BIN is honoured over an old node on PATH', async () => {
    const r = runPoll({ env: `NODE_BIN=${process.execPath}\n`, pathNode: NODE14 })
    assert.equal(r.status, 0, r.pollLog)
    assert.doesNotMatch(r.pollLog, /ERROR/)
    assert.match(r.pollLog, /spawned drain\.md in lane 1/)
    assert.ok(await waitForRunLog(r.daemon, /run-once ran/), 'run-once ran under NODE_BIN')
  })

  test('a crashing run-once leaves its error in runs/<ts>.log', async () => {
    const r = runPoll({ runOnce: "throw new Error('boom: run-once crashed')\n" })
    assert.equal(r.status, 0, r.pollLog)
    const logFile = r.pollLog.match(/log (runs\/[^)]+\.log)\)/)?.[1]
    assert.ok(logFile, r.pollLog)
    const found = await waitForRunLog(r.daemon, /boom: run-once crashed/)
    assert.ok(found, 'crash is in the run log')
    assert.equal(`runs/${found.file}`, logFile)
  })
})
