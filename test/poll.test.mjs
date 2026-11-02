import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ROOT } from './run-worker.mjs'

const POLL = join(ROOT, 'poll.sh')
const which = (cmd) => {
  try {
    return execFileSync('/bin/sh', ['-c', `command -v ${cmd}`], { encoding: 'utf8' }).trim()
  } catch {
    return ''
  }
}
const ZSH = which('zsh')
// The only real tools poll.sh's cold path needs; PATH holds nothing else, so
// no real node, curl, pgrep or python3 is reachable.
const TOOLS = ['date', 'mkdir', 'rm', 'seq', 'ls', 'wc', 'tr', 'cat', 'find', 'nohup', 'grep', 'stat', 'touch']

// Committed stand-ins (test/fixtures/poll-bin), symlinked rather than written
// per test: a freshly written executable is slow to first exec on macOS.
const FAKES = join(ROOT, 'test/fixtures/poll-bin')
// A node stand-in at `path` that reports `version` and records its argv.
const fakeNode = (path, version) => {
  symlinkSync(join(FAKES, 'node'), path)
  writeFileSync(`${path}.version`, `${version}\n`)
  return path
}

// Runs poll.sh with HOME=<tmp> (daemon home <tmp>/fermi-daemon), the warm
// worker down and one pending task, so it takes the cold-spawn fallback.
function runPoll({ env = '', node, setup } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'poll-'))
  const daemon = join(home, 'fermi-daemon')
  const bin = join(home, 'bin')
  for (const d of ['logs', 'runs', 'prompts', 'bin']) mkdirSync(join(daemon, d), { recursive: true })
  mkdirSync(bin)
  writeFileSync(join(daemon, '.env'), `FERMI_URL=http://127.0.0.1:9\nFERMI_BEARER_TOKEN=test\n${env}`)
  writeFileSync(join(daemon, 'prompts/drain.md'), 'drain the queue\n')
  writeFileSync(join(daemon, 'bin/run-once.mjs'), '')
  for (const t of TOOLS) symlinkSync(which(t), join(bin, t))
  for (const t of ['pgrep', 'curl', 'python3']) symlinkSync(join(FAKES, t), join(bin, t))
  if (node) fakeNode(join(bin, 'node'), node)
  setup?.({ home, daemon, bin })
  const r = spawnSync(ZSH, [POLL], { env: { HOME: home, PATH: bin }, encoding: 'utf8' })
  const pollLog = existsSync(join(daemon, 'logs/poll.log')) ? readFileSync(join(daemon, 'logs/poll.log'), 'utf8') : ''
  return { ...r, home, daemon, bin, pollLog, lanes: readdirSync(join(daemon, 'lanes')) }
}

// The spawn is detached: wait for its run log to contain `re`.
async function runLog(daemon, re) {
  for (const t0 = Date.now(); Date.now() - t0 < 10_000; await new Promise((r) => setTimeout(r, 50))) {
    const [f] = readdirSync(join(daemon, 'runs')).filter((n) => n.endsWith('.log'))
    const text = f ? readFileSync(join(daemon, 'runs', f), 'utf8') : ''
    if (re.test(text)) return text
  }
  assert.fail(`run log never matched ${re}`)
}

describe('poll.sh cold path: node resolution', { skip: !ZSH && 'zsh not installed' }, () => {
  test('node v14 on PATH: one error line in poll.log, exit non-zero, no lane, no spawn', () => {
    const r = runPoll({ node: '14.21.3' })
    assert.notEqual(r.status, 0)
    const errors = r.pollLog.split('\n').filter((l) => l.includes('ERROR'))
    assert.equal(errors.length, 1, r.pollLog)
    assert.ok(
      errors[0].endsWith(
        `ERROR: node '${join(r.bin, 'node')}' is v14.21.3; bin/run-once.mjs needs node >= 22 (set NODE_BIN in .env) — not spawning drain.md`,
      ),
      errors[0],
    )
    assert.doesNotMatch(r.pollLog, /spawned/)
    assert.deepEqual(r.lanes, [])
    assert.ok(!existsSync(join(r.bin, 'node.argv')), 'node was not spawned')
    assert.deepEqual(readdirSync(join(r.daemon, 'runs')), [])
  })

  test('no node at all: error line, exit non-zero, no lane', () => {
    const r = runPoll()
    assert.notEqual(r.status, 0)
    assert.match(r.pollLog, /ERROR: node .* is v\?; bin\/run-once\.mjs needs node >= 22 \(set NODE_BIN in \.env\) — not spawning drain\.md/)
    assert.deepEqual(r.lanes, [])
  })

  test('NODE_BIN from .env wins over an old node on PATH', async () => {
    let good
    const r = runPoll({
      node: '14.21.3',
      setup: ({ home }) => (good = fakeNode(join(home, 'node22'), '22.12.0')),
      env: 'NODE_BIN="$HOME/node22"\n',
    })
    assert.equal(r.status, 0, r.stderr)
    assert.doesNotMatch(r.pollLog, /ERROR/)
    assert.match(r.pollLog, /spawned drain\.md in lane 1/)
    await runLog(r.daemon, /fake node 22\.12\.0 ran/)
    const argv = readFileSync(`${good}.argv`, 'utf8').trim().split('\n')
    assert.equal(argv[0], join(r.daemon, 'bin/run-once.mjs'))
    assert.ok(!existsSync(join(r.bin, 'node.argv')), 'PATH node not used')
  })

  test('NODE_BIN too old: the error names NODE_BIN even with a good node on PATH', () => {
    const r = runPoll({
      node: '22.12.0',
      setup: ({ home }) => fakeNode(join(home, 'old-node'), '20.18.0'),
      env: 'NODE_BIN="$HOME/old-node"\n',
    })
    assert.notEqual(r.status, 0)
    assert.match(r.pollLog, /ERROR: node '.*\/old-node' is v20\.18\.0; .* — not spawning drain\.md/)
    assert.deepEqual(r.lanes, [])
  })

  test('a crashing run-once leaves its error in runs/<ts>.log', async () => {
    const r = runPoll({
      env: `NODE_BIN='${process.execPath}'\n`,
      setup: ({ daemon }) => writeFileSync(join(daemon, 'bin/run-once.mjs'), "throw new Error('boom: run-once crashed')\n"),
    })
    assert.equal(r.status, 0, r.stderr)
    await runLog(r.daemon, /Error: boom: run-once crashed/)
    assert.match(r.pollLog, /spawned drain\.md in lane 1 \(pid \d+, log runs\/[^)]+\.log\)/)
  })
})
