import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, chmodSync, cpSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ROOT } from './run-worker.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const exe = (path, body) => {
  writeFileSync(path, `#!/bin/sh\n${body}\n`)
  chmodSync(path, 0o755)
  return path
}
// A fake node reporting `version`; any real invocation records its argv.
const fakeNode = (dir, name, version) =>
  exe(join(dir, name), `if [ "$1" = --version ]; then echo v${version}; exit 0; fi\necho "$@" >>"${dir}/${name}.argv"`)

// Runs poll.sh with HOME=<tmp> (daemon home <tmp>/fermi-daemon), fake curl
// reporting 0 pending and fake pgrep reporting the warm worker down, so the
// heartbeat fallback spawn is the only spawn attempted.
function runPoll({ env = '', pathNode, runOnce } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'poll-'))
  const daemon = join(home, 'fermi-daemon')
  const fakeBin = join(home, 'fakebin')
  mkdirSync(join(daemon, 'bin'), { recursive: true })
  mkdirSync(join(daemon, 'prompts'))
  mkdirSync(fakeBin)
  cpSync(join(ROOT, 'poll.sh'), join(daemon, 'poll.sh'))
  writeFileSync(join(daemon, 'bin/run-once.mjs'), runOnce ?? '')
  writeFileSync(join(daemon, 'prompts/heartbeat.md'), 'check in\n')
  writeFileSync(join(daemon, '.env'), `FERMI_URL=http://127.0.0.1:9\nFERMI_BEARER_TOKEN=t\n${env}`)
  exe(join(fakeBin, 'curl'), 'echo \'{"pending":0}\'')
  exe(join(fakeBin, 'pgrep'), 'exit 1')
  if (pathNode) fakeNode(fakeBin, 'node', pathNode)
  const PATH = `${fakeBin}:/usr/bin:/bin:/usr/sbin:/sbin`
  const r = spawnSync('zsh', [join(daemon, 'poll.sh')], { env: { HOME: home, PATH }, encoding: 'utf8' })
  const pollLog = existsSync(join(daemon, 'logs/poll.log')) ? readFileSync(join(daemon, 'logs/poll.log'), 'utf8') : ''
  return { home, daemon, fakeBin, status: r.status, pollLog }
}

describe('poll.sh cold path node resolution', () => {
  test('AC1: node v14 on PATH logs the error line, exits non-zero, claims no lane', () => {
    const r = runPoll({ pathNode: '14.21.3' })
    const node = join(r.fakeBin, 'node')
    assert.notEqual(r.status, 0)
    assert.ok(
      r.pollLog.includes(
        `ERROR: node '${node}' is v14.21.3; bin/run-once.mjs needs node >= 22 (set NODE_BIN in .env) — not spawning heartbeat.md`,
      ),
      r.pollLog,
    )
    assert.equal(r.pollLog.match(/ERROR/g).length, 1, r.pollLog)
    assert.deepEqual(readdirSync(join(r.daemon, 'lanes')), [])
    assert.ok(!existsSync(join(r.fakeBin, 'node.argv')))
  })

  test('AC1: missing node also fails loudly', () => {
    const r = runPoll({})
    assert.notEqual(r.status, 0)
    assert.match(r.pollLog, /ERROR: node .* needs node >= 22 \(set NODE_BIN in \.env\) — not spawning heartbeat\.md/)
    assert.deepEqual(readdirSync(join(r.daemon, 'lanes')), [])
  })

  test('AC2: NODE_BIN from .env is honoured over PATH node', async () => {
    const tools = mkdtempSync(join(tmpdir(), 'nodebin-'))
    const good = fakeNode(tools, 'node22', '22.4.0')
    const r = runPoll({ env: `NODE_BIN=${good}\n`, pathNode: '14.21.3' })
    assert.equal(r.status, 0, r.pollLog)
    assert.match(r.pollLog, /spawned heartbeat\.md in lane 1/)
    assert.doesNotMatch(r.pollLog, /ERROR/)
    for (let i = 0; i < 50 && !existsSync(join(tools, 'node22.argv')); i++) await sleep(100)
    const argv = readFileSync(join(tools, 'node22.argv'), 'utf8')
    assert.match(argv, /bin\/run-once\.mjs --prompt prompts\/heartbeat\.md/)
    assert.ok(!existsSync(join(r.fakeBin, 'node.argv')))
  })

  test('AC3: a crashing run-once leaves its error in runs/<ts>.log', async () => {
    const r = runPoll({
      env: `NODE_BIN=${process.execPath}\n`,
      runOnce: "throw new Error('run-once exploded')\n",
    })
    assert.equal(r.status, 0, r.pollLog)
    const logName = r.pollLog.match(/log (runs\/\S+\.log)\)/)?.[1]
    assert.ok(logName, r.pollLog)
    const path = join(r.daemon, logName)
    let log = ''
    for (let i = 0; i < 50 && !log.includes('run-once exploded'); i++) {
      await sleep(100)
      log = existsSync(path) ? readFileSync(path, 'utf8') : ''
    }
    assert.match(log, /Error: run-once exploded/)
  })
})
