import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync, execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, chmodSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ROOT } from './run-worker.mjs'

const ZSH = execFileSync('/bin/sh', ['-c', 'command -v zsh'], { encoding: 'utf8' }).trim()
// poll.sh's real tools. PATH holds only these and the stubs, so no node on the
// host and no warm worker running on the host can reach a test.
const TOOLS = ['cat', 'date', 'find', 'grep', 'ls', 'mkdir', 'nohup', 'rm', 'seq', 'stat', 'touch', 'tr', 'wc']
const toolPaths = TOOLS.map((t) => execFileSync('/bin/sh', ['-c', `command -v ${t}`], { encoding: 'utf8' }).trim())

const script = (path, body) => {
  writeFileSync(path, `#!/bin/bash\n${body}\n`)
  chmodSync(path, 0o755)
  return path
}
const until = async (cond, ms = 5000) => {
  for (const t0 = Date.now(); !cond(); ) {
    if (Date.now() - t0 > ms) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 20))
  }
}

// A fake node that reports `version` and records any other invocation.
const fakeNode = (path, version, spawned) => script(path, `[ "$1" = --version ] && { echo ${version}; exit 0; }\necho "$0" >>"${spawned}"`)

function setup(t, { pending = 1, warm = false, env = '', pathNode = null } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'poll-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const daemon = join(home, 'fermi-daemon')
  const stubs = join(home, 'stubs')
  mkdirSync(daemon)
  mkdirSync(stubs)
  for (const p of toolPaths) symlinkSync(p, join(stubs, p.split('/').pop()))
  const spawned = join(home, 'spawned')
  script(join(stubs, 'pgrep'), `exit ${warm ? 0 : 1}`)
  script(join(stubs, 'curl'), `echo '{"pending":${pending}}'`)
  script(join(stubs, 'python3'), `echo narrator >>"${spawned}"`)
  if (pathNode) fakeNode(join(stubs, 'node'), pathNode, spawned)
  writeFileSync(join(daemon, '.env'), `FERMI_URL=http://fermi.example.invalid\nFERMI_BEARER_TOKEN=test\n${env}\n`)
  const poll = () => spawnSync(ZSH, [join(ROOT, 'poll.sh')], { env: { HOME: home, PATH: stubs }, encoding: 'utf8' })
  const pollLog = () => readFileSync(join(daemon, 'logs/poll.log'), 'utf8')
  const errors = () => pollLog().split('\n').filter((l) => l.includes('ERROR'))
  const spawns = () => (existsSync(spawned) ? readFileSync(spawned, 'utf8').trim().split('\n') : [])
  const lanes = () => readdirSync(join(daemon, 'lanes'))
  return { home, daemon, poll, pollLog, errors, spawns, spawned, lanes }
}

const errorLine = (node, version, prompt) =>
  `ERROR: node '${node}' is v${version}; bin/run-once.mjs needs node >= 22 (set NODE_BIN in .env) — not spawning ${prompt}`

const assertRefused = (s, r, node, version, prompt) => {
  assert.equal(r.status, 1, r.stderr)
  const errors = s.errors()
  assert.equal(errors.length, 1, s.pollLog())
  assert.ok(errors[0].endsWith(' ' + errorLine(node, version, prompt)), errors[0])
  assert.deepEqual(s.lanes(), [])
  assert.deepEqual(s.spawns(), [])
}

describe('AC1: a missing or old node logs one error and spawns nothing', () => {
  test('node v14 on PATH', (t) => {
    const s = setup(t, { pending: 3, pathNode: 'v14.21.3' })
    assertRefused(s, s.poll(), join(s.home, 'stubs/node'), '14.21.3', 'drain.md')
  })

  test('v21 is one major too old', (t) => {
    const s = setup(t, { pathNode: 'v21.7.3' })
    assertRefused(s, s.poll(), join(s.home, 'stubs/node'), '21.7.3', 'drain.md')
  })

  test('no node on PATH and no NODE_BIN', (t) => {
    const s = setup(t)
    assertRefused(s, s.poll(), 'node', 'unknown', 'drain.md')
  })

  test('NODE_BIN pointing at nothing', (t) => {
    const s = setup(t, { env: 'NODE_BIN=/nonexistent/node' })
    assertRefused(s, s.poll(), '/nonexistent/node', 'unknown', 'drain.md')
  })

  test('a node that answers with garbage', (t) => {
    const s = setup(t, { pathNode: 'banana' })
    assertRefused(s, s.poll(), join(s.home, 'stubs/node'), 'unknown', 'drain.md')
  })

  test('the heartbeat path names its prompt and retries next poll', (t) => {
    const s = setup(t, { pending: 0, pathNode: 'v14.21.3' })
    assertRefused(s, s.poll(), join(s.home, 'stubs/node'), '14.21.3', 'heartbeat.md')
    assert.equal(existsSync(join(s.daemon, 'last-heartbeat')), false)
  })

  test('nothing to spawn means nothing to report while the warm worker is up', (t) => {
    const s = setup(t, { warm: true, pending: 3, pathNode: 'v14.21.3' })
    assert.equal(s.poll().status, 0)
    assert.equal(existsSync(join(s.daemon, 'logs/poll.log')), false)
  })
})

describe('AC2: node resolution', () => {
  test('NODE_BIN wins over a good node on PATH', async (t) => {
    const s = setup(t, { pathNode: 'v22.0.0' })
    const bin = fakeNode(join(s.home, 'my node'), 'v24.1.0', s.spawned)
    writeFileSync(join(s.daemon, '.env'), `NODE_BIN="${bin}"\n`, { flag: 'a' })
    assert.equal(s.poll().status, 0)
    await until(() => s.spawns().includes(bin))
    assert.equal(s.spawns().includes(join(s.home, 'stubs/node')), false)
    assert.deepEqual(s.lanes(), ['1'])
  })

  test('a too-old NODE_BIN refuses instead of falling back to PATH', (t) => {
    const s = setup(t, { pathNode: 'v22.0.0' })
    const bin = fakeNode(join(s.home, 'old-node'), 'v14.21.3', s.spawned)
    writeFileSync(join(s.daemon, '.env'), `NODE_BIN=${bin}\n`, { flag: 'a' })
    assertRefused(s, s.poll(), bin, '14.21.3', 'drain.md')
  })

  test('an empty NODE_BIN (as in .env.example) falls back to PATH', async (t) => {
    const s = setup(t, { pathNode: 'v22.0.0', env: 'NODE_BIN=                  # optional' })
    assert.equal(s.poll().status, 0)
    await until(() => s.spawns().includes(join(s.home, 'stubs/node')))
  })
})

describe('AC3: run-once output lands in the run log', () => {
  const runLog = (s) => {
    const logs = existsSync(join(s.daemon, 'runs')) ? readdirSync(join(s.daemon, 'runs')) : []
    return logs.length === 1 ? readFileSync(join(s.daemon, 'runs', logs[0]), 'utf8') : ''
  }

  test('the real run-once crashing (no prompt file) leaves its error', async (t) => {
    const s = setup(t, { env: `NODE_BIN=${process.execPath}` })
    symlinkSync(join(ROOT, 'bin'), join(s.daemon, 'bin'))
    assert.equal(s.poll().status, 0)
    await until(() => runLog(s).includes('ENOENT'))
    assert.match(runLog(s), /prompts\/drain\.md/)
  })

  test('stdout and stderr interleave with what run-once appends itself', async (t) => {
    const s = setup(t, { env: `NODE_BIN=${process.execPath}` })
    mkdirSync(join(s.daemon, 'bin'))
    writeFileSync(
      join(s.daemon, 'bin/run-once.mjs'),
      `import { appendFileSync } from 'node:fs'
       const log = process.argv[process.argv.indexOf('--log') + 1]
       console.log('stdout before')
       appendFileSync(log, 'appended by run-once\\n')
       console.log('stdout after')
       throw new Error('boom from run-once')`,
    )
    assert.equal(s.poll().status, 0)
    await until(() => runLog(s).includes('boom from run-once'))
    const log = runLog(s)
    for (const text of ['stdout before\n', 'appended by run-once\n', 'stdout after\n']) assert.ok(log.includes(text), log)
  })

  test('logs/ and runs/ need not exist yet', async (t) => {
    const s = setup(t, { pathNode: 'v22.0.0' })
    assert.equal(existsSync(join(s.daemon, 'runs')), false)
    s.poll()
    await until(() => s.spawns().length > 0)
    assert.equal(existsSync(join(s.daemon, 'runs')), true)
    assert.match(s.pollLog(), /spawned drain\.md in lane 1/)
  })
})

test('AC2: .env.example documents NODE_BIN', () => {
  assert.match(readFileSync(join(ROOT, '.env.example'), 'utf8'), /^NODE_BIN=\s+#/m)
})
