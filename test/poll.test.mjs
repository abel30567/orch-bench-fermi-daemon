import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, chmodSync, symlinkSync, copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ROOT } from './run-worker.mjs'

const TOOLS = ['cat', 'date', 'find', 'grep', 'head', 'ls', 'mkdir', 'nohup', 'rm', 'seq', 'sleep', 'stat', 'touch', 'tr', 'wc', 'zsh']

const ENV = 'FERMI_URL=http://fermi.invalid\nFERMI_BEARER_TOKEN=test\n'
const script = (path, body) => {
  writeFileSync(path, `#!/bin/bash\n${body}\n`)
  chmodSync(path, 0o755)
  return path
}
const until = async (cond, ms = 10000) => {
  for (const t0 = Date.now(); !cond(); ) {
    if (Date.now() - t0 > ms) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 20))
  }
}

// A fake node: answers -v, otherwise records that it was spawned as run-once.
const fakeNode = (path, version) =>
  script(path, `[ "$1" = -v ] && { echo ${version}; exit 0; }\necho "${path}" >>"$HOME/spawned"`)

// A throwaway $HOME/fermi-daemon. PATH holds only the system tools poll.sh uses
// plus stubs: curl reports the queue, pgrep says the warm worker is down, and
// python3 stands in for the narrator (the real one would post to the Worker).
const sandbox = ({ pending = 1, env = ENV } = {}) => {
  const home = mkdtempSync(join(tmpdir(), 'poll-'))
  const daemon = join(home, 'fermi-daemon')
  const bin = join(home, 'path')
  const other = join(home, 'other')
  mkdirSync(daemon)
  mkdirSync(bin)
  mkdirSync(other)
  copyFileSync(join(ROOT, 'poll.sh'), join(daemon, 'poll.sh'))
  for (const dir of ['bin', 'lib', 'harness']) symlinkSync(join(ROOT, dir), join(daemon, dir))
  writeFileSync(join(daemon, '.env'), env)
  for (const tool of TOOLS) {
    const real = ['/usr/bin', '/bin'].map((d) => join(d, tool)).find((p) => existsSync(p))
    symlinkSync(real, join(bin, tool))
  }
  script(join(bin, 'curl'), `echo '{"pending": ${pending}}'`)
  script(join(bin, 'pgrep'), 'exit 1')
  script(join(bin, 'python3'), 'echo narrator >>"$HOME/narrated"')
  const poll = () => spawnSync(join(bin, 'zsh'), ['poll.sh'], { cwd: daemon, env: { HOME: home, PATH: bin }, encoding: 'utf8' })
  const pollLog = () => {
    const file = join(daemon, 'logs/poll.log')
    return existsSync(file) ? readFileSync(file, 'utf8') : ''
  }
  const runLogs = () => readdirSync(join(daemon, 'runs')).map((f) => readFileSync(join(daemon, 'runs', f), 'utf8'))
  return { home, daemon, bin, other, poll, pollLog, runLogs }
}

const errorLine = (node, version, prompt) =>
  `ERROR: node '${node}' is v${version}; bin/run-once.mjs needs node >= 22 (set NODE_BIN in .env) — not spawning ${prompt}`

const assertRefused = (s, result, line) => {
  assert.notEqual(result.status, 0, result.stderr)
  const lines = s.pollLog().trimEnd().split('\n')
  assert.equal(lines.length, 1, s.pollLog())
  assert.ok(lines[0].endsWith(' ' + line), lines[0])
  assert.deepEqual(readdirSync(join(s.daemon, 'lanes')), [])
  assert.deepEqual(readdirSync(join(s.daemon, 'runs')), [])
  assert.ok(!existsSync(join(s.home, 'spawned')), 'run-once was spawned')
  assert.ok(!existsSync(join(s.home, 'narrated')), 'narrator was spawned')
}

describe('AC1: a missing or too-old node is refused loudly', { concurrency: true }, () => {
  test('node v14 on PATH: one error line for all pending tasks, no lane, non-zero exit', () => {
    const s = sandbox({ pending: 3 })
    const node = fakeNode(join(s.bin, 'node'), 'v14.21.3')
    assertRefused(s, s.poll(), errorLine(node, '14.21.3', 'drain.md'))
  })

  test('heartbeat sweep is refused the same way and stays due', () => {
    const s = sandbox({ pending: 0 })
    const node = fakeNode(join(s.bin, 'node'), 'v14.21.3')
    assertRefused(s, s.poll(), errorLine(node, '14.21.3', 'heartbeat.md'))
    assert.ok(!existsSync(join(s.daemon, 'last-heartbeat')))
  })

  test('v21 is refused (the boundary)', () => {
    const s = sandbox()
    const node = fakeNode(join(s.bin, 'node'), 'v21.7.3')
    assertRefused(s, s.poll(), errorLine(node, '21.7.3', 'drain.md'))
  })

  test('no node on PATH', () => {
    const s = sandbox()
    assertRefused(s, s.poll(), errorLine('node', 'unknown', 'drain.md'))
  })

  test('NODE_BIN pointing at nothing does not fall back to PATH', () => {
    const missing = '/nonexistent/node'
    const s = sandbox({ env: `${ENV}NODE_BIN=${missing}\n` })
    fakeNode(join(s.bin, 'node'), 'v22.0.0')
    assertRefused(s, s.poll(), errorLine(missing, 'unknown', 'drain.md'))
  })

  test('garbage version output is refused, not evaluated', () => {
    const s = sandbox()
    const node = fakeNode(join(s.bin, 'node'), `'a[$(touch $HOME/spawned)]'`)
    assert.notEqual(s.poll().status, 0)
    assert.match(s.pollLog(), /ERROR: node /)
    assert.ok(s.pollLog().includes(`'${node}'`))
    assert.ok(!existsSync(join(s.home, 'spawned')))
  })

  test('idle poll does not check node at all', () => {
    const s = sandbox({ pending: 0 })
    fakeNode(join(s.bin, 'node'), 'v14.21.3')
    writeFileSync(join(s.daemon, 'last-heartbeat'), '')
    const result = s.poll()
    assert.equal(result.status, 0, result.stderr)
    assert.equal(s.pollLog(), '')
  })
})

describe('AC2: NODE_BIN', { concurrency: true }, () => {
  const spawned = (s) => readFileSync(join(s.home, 'spawned'), 'utf8').trim()

  test('wins over an old node on PATH, and is the node that gets spawned', async () => {
    const s = sandbox()
    const good = join(s.other, 'node22')
    writeFileSync(join(s.daemon, '.env'), `${ENV}NODE_BIN=${good}\n`)
    fakeNode(good, 'v22.0.0')
    fakeNode(join(s.bin, 'node'), 'v14.21.3')
    const result = s.poll()
    assert.equal(result.status, 0, result.stderr)
    await until(() => existsSync(join(s.home, 'spawned')))
    assert.equal(spawned(s), good)
    assert.match(s.pollLog(), /spawned drain\.md in lane 1/)
    assert.doesNotMatch(s.pollLog(), /ERROR/)
  })

  test('an old NODE_BIN is refused even with a good node on PATH', () => {
    const s = sandbox()
    const old = join(s.other, 'node14')
    writeFileSync(join(s.daemon, '.env'), `${ENV}NODE_BIN=${old}\n`)
    fakeNode(old, 'v14.21.3')
    fakeNode(join(s.bin, 'node'), 'v22.0.0')
    assertRefused(s, s.poll(), errorLine(old, '14.21.3', 'drain.md'))
  })

  test('the blank NODE_BIN from .env.example falls back to PATH', async () => {
    const s = sandbox({ env: readFileSync(join(ROOT, '.env.example'), 'utf8') })
    assert.match(readFileSync(join(s.daemon, '.env'), 'utf8'), /^NODE_BIN=/m)
    const node = fakeNode(join(s.bin, 'node'), 'v100.1.0')
    const result = s.poll()
    assert.equal(result.status, 0, result.stderr)
    await until(() => existsSync(join(s.home, 'spawned')))
    assert.equal(spawned(s), node)
  })
})

describe('AC3: run-once output lands in the run log', { concurrency: true }, () => {
  test('a crashing run-once leaves its error in runs/<ts>.log', async () => {
    // Real run-once on the real node, crashing before any harness starts: the
    // sandbox has no prompts/, so reading --prompt throws.
    const s = sandbox({ env: `${ENV}NODE_BIN=${process.execPath}\n` })
    const result = s.poll()
    assert.equal(result.status, 0, result.stderr)
    await until(() => s.runLogs().join('').includes('ENOENT'))
    assert.match(s.runLogs()[0], /prompts\/drain\.md/)
  })

  test('stdout and stderr append alongside what run-once writes to --log itself', async () => {
    const s = sandbox()
    script(
      join(s.bin, 'node'),
      `[ "$1" = -v ] && { echo v22.0.0; exit 0; }
while [ $# -gt 0 ]; do [ "$1" = --log ] && log="$2"; shift; done
echo from-stdout-1
echo from-run-once >>"$log"
echo from-stdout-2
echo from-stderr >&2`,
    )
    assert.equal(s.poll().status, 0)
    await until(() => s.runLogs().join('').includes('from-stderr'))
    assert.deepEqual(s.runLogs()[0].trimEnd().split('\n'), ['from-stdout-1', 'from-run-once', 'from-stdout-2', 'from-stderr'])
  })
})
