import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, chmodSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { ROOT } from './run-worker.mjs'

const hasZsh = spawnSync('zsh', ['-c', 'true']).status === 0

const script = (path, body) => {
  writeFileSync(path, `#!/bin/sh\n${body}\n`)
  chmodSync(path, 0o755)
  return path
}

// Runs poll.sh against a throwaway $HOME/fermi-daemon with the warm worker
// "down" (fake pgrep) and one pending task (fake curl), so it takes the cold
// drain path. `env` lines are appended to .env; `node` (if given) is the
// `node` found on PATH.
function runPoll({ env = '', node } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'poll-node-'))
  const daemon = join(home, 'fermi-daemon')
  for (const d of ['logs', 'runs', 'prompts', 'fakebin']) mkdirSync(join(daemon, d), { recursive: true })
  for (const d of ['bin', 'harness', 'lib']) symlinkSync(join(ROOT, d), join(daemon, d))
  const fakebin = join(daemon, 'fakebin')
  script(join(fakebin, 'pgrep'), 'exit 1')
  script(join(fakebin, 'curl'), 'echo \'{"pending": 1}\'')
  script(join(fakebin, 'python3'), 'exit 0')
  script(join(fakebin, 'node'), node ?? `exec "${process.execPath}" "$@"`)
  writeFileSync(join(daemon, '.env'), `FERMI_URL=http://127.0.0.1:9\nFERMI_BEARER_TOKEN=t\n${env}\n`)
  const r = spawnSync('zsh', [join(ROOT, 'poll.sh')], {
    env: { HOME: home, PATH: `${fakebin}:/usr/bin:/bin:/usr/sbin:/sbin` },
    encoding: 'utf8',
  })
  const pollLog = existsSync(join(daemon, 'logs/poll.log')) ? readFileSync(join(daemon, 'logs/poll.log'), 'utf8') : ''
  return { ...r, daemon, fakebin, pollLog }
}

const lanes = (daemon) => (existsSync(join(daemon, 'lanes')) ? readdirSync(join(daemon, 'lanes')) : [])

describe('poll.sh cold path node check', { skip: !hasZsh && 'zsh not installed' }, () => {
  test('AC1: a node v14 on PATH logs the error line and spawns no lane', () => {
    const { status, daemon, fakebin, pollLog } = runPoll({ node: 'echo v14.21.3' })
    assert.notEqual(status, 0)
    assert.match(
      pollLog,
      new RegExp(
        `ERROR: node '${join(fakebin, 'node')}' is v14\\.21\\.3; bin/run-once\\.mjs needs node >= 22 \\(set NODE_BIN in \\.env\\) — not spawning drain\\.md\\n$`,
      ),
    )
    assert.doesNotMatch(pollLog, /spawned/)
    assert.deepEqual(lanes(daemon), [])
    assert.deepEqual(readdirSync(join(daemon, 'runs')), [])
  })

  test('AC2: NODE_BIN overrides the node on PATH', async () => {
    const home = mkdtempSync(join(tmpdir(), 'poll-nodebin-'))
    const old = script(join(home, 'node14'), 'echo v14.0.0')
    const bad = runPoll({ env: `NODE_BIN=${old}` })
    assert.notEqual(bad.status, 0)
    assert.match(bad.pollLog, new RegExp(`ERROR: node '${old}' is v14\\.0\\.0; .* not spawning drain\\.md`))
    assert.deepEqual(lanes(bad.daemon), [])

    // A good NODE_BIN is the one that runs bin/run-once.mjs, even with node v14 on PATH.
    const marker = join(home, 'used')
    const good = script(join(home, 'node-good'), `[ "$1" = --version ] || echo "$@" >>"${marker}"\nexec "${process.execPath}" "$@"`)
    const ok = runPoll({ env: `NODE_BIN=${good}`, node: 'echo v14.21.3' })
    assert.equal(ok.status, 0, ok.pollLog)
    assert.match(ok.pollLog, /spawned drain\.md in lane 1/)
    for (let i = 0; i < 100 && !existsSync(marker); i++) await sleep(100)
    assert.match(readFileSync(marker, 'utf8'), /bin\/run-once\.mjs --prompt prompts\/drain\.md/)
  })

  test('AC3: a crashing run-once leaves its error in runs/<ts>.log', async () => {
    // No prompts/drain.md: run-once throws ENOENT after opening its log.
    const { status, daemon, pollLog } = runPoll()
    assert.equal(status, 0, pollLog)
    const logName = pollLog.match(/log runs\/(\S+\.log)\)/)?.[1]
    assert.ok(logName, pollLog)
    const path = join(daemon, 'runs', logName)
    let log = ''
    for (let i = 0; i < 100 && !/ENOENT/.test(log); i++) {
      await sleep(100)
      log = existsSync(path) ? readFileSync(path, 'utf8') : ''
    }
    assert.match(log, /ENOENT.*prompts\/drain\.md/)
  })
})
