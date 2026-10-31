// poll.sh's cold path end to end: the real script (zsh) in a throwaway
// $HOME/fermi-daemon, with a PATH of stubs and only the system tools it needs,
// so a `node` on PATH is always one the test put there.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, chmodSync, symlinkSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ROOT } from './run-worker.mjs'

const POLL = join(ROOT, 'poll.sh')
const SYSTEM_TOOLS = ['cat', 'date', 'find', 'grep', 'ls', 'mkdir', 'nohup', 'rm', 'seq', 'sleep', 'stat', 'tr', 'wc']
const which = (tool) => spawnSync('/bin/sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).stdout.trim()
const ZSH = which('zsh')

const stub = (path, body) => {
  writeFileSync(path, `#!/bin/sh\n${body}\n`)
  chmodSync(path, 0o755)
}

// A fake node: answers --version and records any other invocation in `marker`.
const fakeNode = (path, version, marker) =>
  stub(path, `[ "$1" = --version ] && { echo ${version}; exit 0; }\necho "$@" >>"${marker}"`)

function setup({ pending = 1, warmWorkerUp = false, env = '' } = {}) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'poll-cold-')))
  const daemon = join(home, 'fermi-daemon')
  const path = join(home, 'path')
  mkdirSync(daemon)
  mkdirSync(path)
  writeFileSync(join(daemon, '.env'), `FERMI_URL=http://fermi.invalid\nFERMI_BEARER_TOKEN=test-token\n${env}\n`)
  for (const tool of SYSTEM_TOOLS) symlinkSync(which(tool), join(path, tool))
  stub(join(path, 'pgrep'), `exit ${warmWorkerUp ? 0 : 1}`)
  stub(join(path, 'curl'), `echo '{"pending":${pending}}'`)
  stub(join(path, 'python3'), `echo "$@" >>"${join(home, 'narrator')}"`)
  const readdir = (dir) => (existsSync(join(daemon, dir)) ? readdirSync(join(daemon, dir)) : [])
  return {
    home,
    daemon,
    path,
    spawned: join(home, 'spawned'),
    narrator: join(home, 'narrator'),
    poll: () => spawnSync(ZSH, [POLL], { env: { HOME: home, PATH: path }, encoding: 'utf8', timeout: 20000 }),
    log: () => (existsSync(join(daemon, 'logs/poll.log')) ? readFileSync(join(daemon, 'logs/poll.log'), 'utf8') : ''),
    lanes: () => readdir('lanes'),
    runs: () => readdir('runs'),
  }
}

function assertRefused(s, r, prompt) {
  assert.equal(r.status, 1, r.stderr)
  const lines = s.log().trimEnd().split('\n')
  assert.equal(lines.length, 1, s.log())
  assert.ok(lines[0].endsWith(`bin/run-once.mjs needs node >= 22 (set NODE_BIN in .env) — not spawning ${prompt}`), lines[0])
  assert.deepEqual(s.lanes(), [])
  assert.deepEqual(s.runs(), [])
  assert.equal(existsSync(s.spawned), false, 'run-once must not start')
  assert.equal(existsSync(s.narrator), false, 'narrator must not start')
}

// poll.sh detaches run-once, so its effects land after poll.sh has exited.
function waitFor(check) {
  const lock = new Int32Array(new SharedArrayBuffer(4))
  for (let i = 0; i < 200 && !check(); i++) Atomics.wait(lock, 0, 0, 50)
  return check()
}

describe('poll.sh cold path', { skip: ZSH ? false : 'zsh not installed' }, () => {
  test('a fake node v14 on PATH logs one error line and takes no lane', () => {
    const s = setup({ pending: 3 })
    fakeNode(join(s.path, 'node'), 'v14.21.3', s.spawned)
    assertRefused(s, s.poll(), 'drain.md')
  })

  test('node v21 is refused, v22 is the floor', () => {
    const old = setup()
    fakeNode(join(old.path, 'node'), 'v21.7.3', old.spawned)
    assertRefused(old, old.poll(), 'drain.md')

    const ok = setup()
    fakeNode(join(ok.path, 'node'), 'v22.0.0', ok.spawned)
    assert.equal(ok.poll().status, 0)
    assert.equal(waitFor(() => existsSync(ok.spawned)), true)
    assert.doesNotMatch(ok.log(), /not spawning/)
  })

  test('no node at all logs the error line and takes no lane', () => {
    const s = setup()
    assertRefused(s, s.poll(), 'drain.md')
  })

  test('a heartbeat refused for node names its prompt and stays due', () => {
    const s = setup({ pending: 0 })
    fakeNode(join(s.path, 'node'), 'v14.21.3', s.spawned)
    assertRefused(s, s.poll(), 'heartbeat.md')
    assert.equal(existsSync(join(s.daemon, 'last-heartbeat')), false)
  })

  test('NODE_BIN from .env wins over the node on PATH', () => {
    const s = setup({ env: 'NODE_BIN="$HOME/node22"' })
    const onPath = join(s.home, 'path-node-ran')
    fakeNode(join(s.path, 'node'), 'v14.21.3', onPath)
    fakeNode(join(s.home, 'node22'), 'v22.22.2', s.spawned)
    assert.equal(s.poll().status, 0)
    assert.equal(waitFor(() => existsSync(s.spawned)), true)
    assert.match(readFileSync(s.spawned, 'utf8'), /bin\/run-once\.mjs --prompt prompts\/drain\.md/)
    assert.equal(existsSync(onPath), false)
    assert.match(s.log(), /spawned drain\.md in lane 1/)
  })

  test('a too-old NODE_BIN is refused even with a good node on PATH', () => {
    const s = setup({ env: 'NODE_BIN="$HOME/node14"' })
    fakeNode(join(s.path, 'node'), 'v22.22.2', s.spawned)
    fakeNode(join(s.home, 'node14'), 'v14.21.3', s.spawned)
    assertRefused(s, s.poll(), 'drain.md')
  })

  test('an empty NODE_BIN (as in .env.example) falls back to PATH', () => {
    const s = setup({ env: 'NODE_BIN=                  # comment' })
    fakeNode(join(s.path, 'node'), 'v22.22.2', s.spawned)
    assert.equal(s.poll().status, 0)
    assert.equal(waitFor(() => existsSync(s.spawned)), true)
  })

  test('a crashing run-once leaves its error in runs/<ts>.log', () => {
    const s = setup()
    // The real run-once: there is no prompts/ here, so it crashes reading the
    // prompt before reaching a harness, with the uncaught error on stderr only.
    for (const dir of ['bin', 'harness', 'lib']) cpSync(join(ROOT, dir), join(s.daemon, dir), { recursive: true })
    stub(join(s.path, 'node'), `exec "${process.execPath}" "$@"`)
    assert.equal(s.poll().status, 0)
    assert.equal(s.runs().length, 1)
    const run = join(s.daemon, 'runs', s.runs()[0])
    assert.equal(waitFor(() => /ENOENT.*prompts\/drain\.md/s.test(readFileSync(run, 'utf8'))), true, readFileSync(run, 'utf8'))
    assert.equal(waitFor(() => s.lanes().length === 0), true)
  })

  test('a live warm worker needs no node check: exit 0, nothing logged', () => {
    const s = setup({ warmWorkerUp: true })
    fakeNode(join(s.path, 'node'), 'v14.21.3', s.spawned)
    assert.equal(s.poll().status, 0)
    assert.equal(s.log(), '')
    assert.deepEqual(s.lanes(), [])
  })
})
