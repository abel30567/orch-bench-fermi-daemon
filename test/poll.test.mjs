import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { ROOT } from './run-worker.mjs'

const exe = (path, body) => {
  writeFileSync(path, `#!/bin/sh\n${body}\n`)
  chmodSync(path, 0o755)
  return path
}
const fakeNode = (dir, version) => exe(join(dir, 'node'), `echo ${version}`)

// Runs poll.sh against a fake daemon home ($HOME/fermi-daemon) with the warm
// worker down and one pending task, so it takes the cold drain path.
// `setup(fake)` may add fakes to the PATH dir and return extra .env lines.
function runPoll({ setup = () => '', runOnce = 'console.log("run-once ok")' } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'poll-'))
  const daemon = join(home, 'fermi-daemon')
  const fake = join(home, 'fakebin')
  for (const d of ['logs', 'runs', 'prompts', 'bin']) mkdirSync(join(daemon, d), { recursive: true })
  mkdirSync(fake)
  writeFileSync(join(daemon, 'prompts/drain.md'), 'drain\n')
  writeFileSync(join(daemon, 'bin/run-once.mjs'), runOnce + '\n')
  writeFileSync(join(daemon, 'narrator.py'), '')
  exe(join(fake, 'pgrep'), 'exit 1') // warm worker down
  exe(join(fake, 'curl'), `echo '{"pending":1}'`)
  exe(join(fake, 'python3'), 'exit 0') // no narrator
  const extraEnv = setup(fake)
  writeFileSync(join(daemon, '.env'), `FERMI_URL=http://x\nFERMI_BEARER_TOKEN=t\n${extraEnv}\n`)
  const r = spawnSync('zsh', [join(ROOT, 'poll.sh')], {
    env: { HOME: home, PATH: `${fake}:/usr/bin:/bin:/usr/sbin:/sbin` },
    encoding: 'utf8',
  })
  const pollLog = () => (existsSync(join(daemon, 'logs/poll.log')) ? readFileSync(join(daemon, 'logs/poll.log'), 'utf8') : '')
  const runLogs = () => readdirSync(join(daemon, 'runs')).map((f) => readFileSync(join(daemon, 'runs', f), 'utf8'))
  const lanes = () => (existsSync(join(daemon, 'lanes')) ? readdirSync(join(daemon, 'lanes')) : [])
  return { status: r.status, pollLog, runLogs, lanes }
}

async function waitFor(fn, ms = 5000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(50)) if (fn()) return
  assert.fail('timed out waiting')
}

describe('poll.sh cold path node resolution', () => {
  test('node v14 on PATH: one poll.log error, non-zero exit, no lane, no run', () => {
    const r = runPoll({ setup: (fake) => (fakeNode(fake, 'v14.21.3'), '') })
    assert.notEqual(r.status, 0)
    const errors = r.pollLog().split('\n').filter((l) => l.includes('ERROR'))
    assert.equal(errors.length, 1, r.pollLog())
    assert.match(
      errors[0],
      /ERROR: node '.*\/fakebin\/node' is v14\.21\.3; bin\/run-once\.mjs needs node >= 22 \(set NODE_BIN in \.env\) — not spawning drain\.md$/,
    )
    assert.doesNotMatch(r.pollLog(), /spawned/)
    assert.deepEqual(r.lanes(), [])
    assert.deepEqual(r.runLogs(), [])
  })

  test('NODE_BIN overrides an old node on PATH', async () => {
    const r = runPoll({ setup: (fake) => (fakeNode(fake, 'v14.21.3'), `NODE_BIN='${process.execPath}'`) })
    assert.equal(r.status, 0, r.pollLog())
    assert.match(r.pollLog(), /spawned drain\.md in lane /)
    assert.doesNotMatch(r.pollLog(), /ERROR/)
    await waitFor(() => r.runLogs().some((l) => l.includes('run-once ok')))
  })

  test('an old NODE_BIN is rejected even with a good node on PATH', () => {
    const r = runPoll({
      setup: (fake) => {
        exe(join(fake, 'node'), `exec "${process.execPath}" "$@"`)
        return `NODE_BIN='${exe(join(fake, 'oldnode'), 'echo v18.0.0')}'`
      },
    })
    assert.notEqual(r.status, 0)
    assert.match(r.pollLog(), /ERROR: node '.*\/oldnode' is v18\.0\.0; .* not spawning drain\.md/)
    assert.deepEqual(r.lanes(), [])
  })

  test('no node at all fails loudly', () => {
    const r = runPoll({ setup: () => `NODE_BIN='/nonexistent/node'` })
    assert.notEqual(r.status, 0)
    assert.match(r.pollLog(), /ERROR: node '\/nonexistent\/node' is vunknown; .* not spawning drain\.md/)
  })

  test('a crashing run-once leaves its error in runs/<ts>.log', async () => {
    const r = runPoll({
      setup: () => `NODE_BIN='${process.execPath}'`,
      runOnce: 'throw new Error("run-once boom")',
    })
    assert.equal(r.status, 0, r.pollLog())
    await waitFor(() => r.runLogs().some((l) => l.includes('run-once boom')))
  })
})
