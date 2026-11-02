// poll.sh cold path (DMN-7 ruling): node resolution + version gate, and
// run-once's own stdout/stderr landing in the run log.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ROOT } from './run-worker.mjs'

const POLL = join(ROOT, 'poll.sh')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function exe(path, body) {
  writeFileSync(path, `#!/bin/sh\n${body}\n`)
  chmodSync(path, 0o755)
  return path
}

// A fake node that reports `version` for -v and records any other invocation.
const fakeNode = (path, version) =>
  exe(path, `if [ "$1" = "-v" ] || [ "$1" = "--version" ]; then echo v${version}; exit 0; fi\necho "$@" >>"$(dirname "$0")/invocations"`)

// Daemon home under a temp HOME, with stubs on PATH: curl reports one pending
// task, pgrep finds no warm worker, python3 (narrator) is a no-op. PATH holds
// only the stub dir and system dirs, so `command -v node` finds `pathNode`.
function setup({ env = '', pathNode } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'poll-'))
  const daemon = join(home, 'fermi-daemon')
  const stubs = join(home, 'stubs')
  for (const d of ['bin', 'prompts', 'logs', 'runs']) mkdirSync(join(daemon, d), { recursive: true })
  mkdirSync(stubs)
  writeFileSync(join(daemon, '.env'), `FERMI_URL=http://127.0.0.1:9\nFERMI_BEARER_TOKEN=t\n${env}`)
  writeFileSync(join(daemon, 'prompts/drain.md'), 'drain\n')
  exe(join(stubs, 'curl'), `echo '{"pending": 1}'`)
  exe(join(stubs, 'pgrep'), 'exit 1')
  exe(join(stubs, 'python3'), 'exit 0')
  if (pathNode) fakeNode(join(stubs, 'node'), pathNode)
  return { home, daemon, stubs }
}

function poll({ home, stubs }) {
  return spawnSync('/bin/zsh', [POLL], {
    env: { HOME: home, PATH: `${stubs}:/usr/bin:/bin:/usr/sbin:/sbin`, MAX_CONCURRENT: '1' },
    encoding: 'utf8',
  })
}

const pollLog = (daemon) => {
  const p = join(daemon, 'logs/poll.log')
  return existsSync(p) ? readFileSync(p, 'utf8') : ''
}
const lanes = (daemon) => (existsSync(join(daemon, 'lanes')) ? readdirSync(join(daemon, 'lanes')) : [])

describe('poll.sh node resolution', () => {
  test('node v14 on PATH: one clear error line in poll.log, non-zero exit, no lane, no spawn', () => {
    const s = setup({ pathNode: '14.21.3' })
    const r = poll(s)
    assert.notEqual(r.status, 0)
    const errors = pollLog(s.daemon).split('\n').filter((l) => l.includes('ERROR'))
    assert.equal(errors.length, 1, pollLog(s.daemon))
    assert.ok(
      errors[0].endsWith(
        `ERROR: node '${join(s.stubs, 'node')}' is v14.21.3; bin/run-once.mjs needs node >= 22 (set NODE_BIN in .env) — not spawning drain.md`,
      ),
      errors[0],
    )
    assert.doesNotMatch(pollLog(s.daemon), /spawned/)
    assert.deepEqual(lanes(s.daemon), [])
    assert.deepEqual(readdirSync(join(s.daemon, 'runs')), [])
    assert.ok(!existsSync(join(s.stubs, 'invocations')))
  })

  test('no node at all: error line, no lane', () => {
    const s = setup()
    const r = poll(s)
    assert.notEqual(r.status, 0)
    assert.match(pollLog(s.daemon), /ERROR: node '.*' is v\?; bin\/run-once\.mjs needs node >= 22 .* not spawning drain\.md/)
    assert.deepEqual(lanes(s.daemon), [])
  })

  test('NODE_BIN from .env is honoured over PATH', () => {
    const s = setup({ pathNode: '14.0.0' })
    const good = join(s.home, 'node22')
    mkdirSync(good)
    fakeNode(join(good, 'node'), '22.3.0')
    writeFileSync(join(s.daemon, '.env'), `NODE_BIN=${join(good, 'node')}\n`, { flag: 'a' })
    const r = poll(s)
    assert.equal(r.status, 0, r.stderr)
    assert.doesNotMatch(pollLog(s.daemon), /ERROR/)
    assert.match(pollLog(s.daemon), /spawned drain\.md in lane 1/)
    assert.deepEqual(lanes(s.daemon), ['1'])
    assert.ok(!existsSync(join(s.stubs, 'invocations')), 'PATH node not used')
  })

  test('NODE_BIN too old: error names NODE_BIN', () => {
    const s = setup({ pathNode: '22.3.0' })
    const old = fakeNode(join(s.home, 'old-node'), '20.11.0')
    writeFileSync(join(s.daemon, '.env'), `NODE_BIN=${old}\n`, { flag: 'a' })
    const r = poll(s)
    assert.notEqual(r.status, 0)
    assert.match(pollLog(s.daemon), new RegExp(`ERROR: node '${old}' is v20\\.11\\.0;`))
    assert.deepEqual(lanes(s.daemon), [])
  })
})

describe('poll.sh run-once output', () => {
  test('a crashing run-once leaves its error in runs/<ts>.log', async () => {
    const s = setup()
    writeFileSync(join(s.daemon, '.env'), `NODE_BIN=${process.execPath}\n`, { flag: 'a' })
    writeFileSync(join(s.daemon, 'bin/run-once.mjs'), "throw new Error('run-once exploded')\n")
    const r = poll(s)
    assert.equal(r.status, 0, r.stderr)
    let runs = []
    let log = ''
    for (let i = 0; i < 100 && !/run-once exploded/.test(log); i++) {
      await sleep(50)
      runs = readdirSync(join(s.daemon, 'runs'))
      log = runs.length ? readFileSync(join(s.daemon, 'runs', runs[0]), 'utf8') : ''
    }
    assert.equal(runs.length, 1)
    assert.match(runs[0], /^\d{8}-\d{6}-\d+-\d+\.log$/)
    assert.match(log, /Error: run-once exploded/)
  })
})
