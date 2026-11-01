import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync, execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, chmodSync, copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { ROOT } from './run-worker.mjs'

let ZSH = null
try {
  ZSH = execFileSync('sh', ['-c', 'command -v zsh'], { encoding: 'utf8' }).trim() || null
} catch {}

const script = (path, body) => {
  writeFileSync(path, `#!/bin/sh\n${body}\n`)
  chmodSync(path, 0o755)
}

// Runs poll.sh in a throwaway $HOME/fermi-daemon with the warm worker "down"
// (fake pgrep) and one pending task (fake curl), so it takes the cold path.
// `fakeNode` puts a node on PATH that reports that version; `env` lands in .env.
function runPoll({ fakeNode, env = {}, runOnce } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'poll-'))
  const daemon = join(home, 'fermi-daemon')
  const fakebin = join(home, 'fakebin')
  for (const d of ['prompts', 'bin', 'logs', 'runs']) mkdirSync(join(daemon, d), { recursive: true })
  mkdirSync(fakebin)
  copyFileSync(join(ROOT, 'poll.sh'), join(daemon, 'poll.sh'))
  writeFileSync(join(daemon, 'prompts/drain.md'), 'drain\n')
  writeFileSync(join(daemon, 'bin/run-once.mjs'), runOnce ?? 'console.log("run-once ok")\n')
  const dotenv = { FERMI_URL: 'http://fermi.invalid', FERMI_BEARER_TOKEN: 't', ...env }
  writeFileSync(join(daemon, '.env'), Object.entries(dotenv).map(([k, v]) => `${k}='${v}'\n`).join(''))
  script(join(fakebin, 'pgrep'), 'exit 1')
  script(join(fakebin, 'curl'), `echo '{"pending":1}'`)
  script(join(fakebin, 'python3'), 'exit 0')
  if (fakeNode) script(join(fakebin, 'node'), `[ "$1" = --version ] && echo ${fakeNode} && exit 0\necho "fake node ran" >>"${home}/fake-node.ran"`)
  const nodeDir = join(process.execPath, '..')
  const r = spawnSync(ZSH, [join(daemon, 'poll.sh')], {
    cwd: home,
    env: { HOME: home, PATH: `${fakebin}:${nodeDir}:/usr/bin:/bin` },
    encoding: 'utf8',
  })
  const read = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : '')
  return {
    home,
    daemon,
    code: r.status,
    pollLog: read(join(daemon, 'logs/poll.log')),
    lanes: existsSync(join(daemon, 'lanes')) ? readdirSync(join(daemon, 'lanes')) : [],
    runs: () => readdirSync(join(daemon, 'runs')).map((f) => read(join(daemon, 'runs', f))),
  }
}

async function waitFor(fn, ms = 10000) {
  const end = Date.now() + ms
  for (;;) {
    const v = fn()
    if (v || Date.now() > end) return v
    await sleep(50)
  }
}

describe('poll.sh cold-path node resolution', { skip: !ZSH && 'zsh not installed' }, () => {
  test('a node older than 22 logs one error line and spawns nothing', () => {
    const r = runPoll({ fakeNode: 'v14.21.3' })
    assert.notEqual(r.code, 0)
    const errors = r.pollLog.split('\n').filter((l) => l.includes('ERROR'))
    assert.equal(errors.length, 1, r.pollLog)
    assert.ok(
      errors[0].endsWith(
        `ERROR: node '${join(r.home, 'fakebin/node')}' is v14.21.3; bin/run-once.mjs needs node >= 22 (set NODE_BIN in .env) — not spawning drain.md`,
      ),
      errors[0],
    )
    assert.doesNotMatch(r.pollLog, /spawned/)
    assert.deepEqual(r.lanes, [])
    assert.deepEqual(r.runs(), [])
    assert.ok(!existsSync(join(r.home, 'fake-node.ran')))
  })

  test('NODE_BIN from .env wins over an old node on PATH', async () => {
    const wrapper = join(mkdtempSync(join(tmpdir(), 'nodebin-')), 'my-node')
    const marker = `${wrapper}.args`
    script(wrapper, `echo "$@" >>"${marker}"\nexec "${process.execPath}" "$@"`)
    const r = runPoll({ fakeNode: 'v14.21.3', env: { NODE_BIN: wrapper } })
    assert.equal(r.code, 0, r.pollLog)
    assert.match(r.pollLog, /spawned drain\.md in lane 1/)
    assert.doesNotMatch(r.pollLog, /ERROR/)
    const args = await waitFor(() => existsSync(marker) && /run-once\.mjs/.test(readFileSync(marker, 'utf8')))
    assert.ok(args, 'run-once was not launched via NODE_BIN')
    assert.ok(!existsSync(join(r.home, 'fake-node.ran')))
  })

  test("a crashing run-once leaves its error in the run's log", async () => {
    const r = runPoll({ runOnce: 'throw new Error("run-once exploded")\n' })
    assert.equal(r.code, 0, r.pollLog)
    assert.match(r.pollLog, /spawned drain\.md .*log runs\/[^)]+\.log/)
    const log = await waitFor(() => r.runs().find((l) => l.includes('run-once exploded')))
    assert.ok(log, `crash not in runs/<ts>.log: ${JSON.stringify(r.runs())}`)
  })
})
