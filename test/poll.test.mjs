// poll.sh's cold path: node resolution ($NODE_BIN, else PATH), the >= 22 gate,
// and run-once's stdout/stderr landing in the run log.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, chmodSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ROOT } from './run-worker.mjs'

const POLL = join(ROOT, 'poll.sh')

// A fake node: answers --version with `version`, records any other argv to `$HOME/<name>.spawned`.
function fakeNode(path, version, name) {
  writeFileSync(
    path,
    `#!/bin/sh\nif [ "$1" = --version ]; then echo ${version}; exit 0; fi\necho "$@" >>"$HOME/${name}.spawned"\n`,
  )
  chmodSync(path, 0o755)
}

// A daemon home under a fresh $HOME with no warm worker (pgrep fails) and no
// pending tasks (curl returns 0), so poll.sh falls through to a heartbeat spawn.
function daemon({ env = '', pathNode, prompt = true } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'poll-'))
  const dh = join(home, 'fermi-daemon')
  for (const d of ['logs', 'runs', 'prompts']) mkdirSync(join(dh, d), { recursive: true })
  if (prompt) writeFileSync(join(dh, 'prompts/heartbeat.md'), 'check in\n')
  writeFileSync(join(dh, '.env'), `FERMI_URL=http://127.0.0.1:9\nFERMI_BEARER_TOKEN=t\n${env}`)
  const fakebin = join(home, 'fakebin')
  mkdirSync(fakebin)
  writeFileSync(join(fakebin, 'pgrep'), '#!/bin/sh\nexit 1\n')
  writeFileSync(join(fakebin, 'curl'), '#!/bin/sh\necho \'{"pending":0}\'\n')
  chmodSync(join(fakebin, 'pgrep'), 0o755)
  chmodSync(join(fakebin, 'curl'), 0o755)
  if (pathNode) fakeNode(join(fakebin, 'node'), pathNode, 'path-node')
  return { home, dh }
}

function poll({ home, dh }) {
  const r = spawnSync('zsh', [POLL], {
    env: { HOME: home, PATH: `${join(home, 'fakebin')}:/usr/bin:/bin` },
    encoding: 'utf8',
  })
  const pollLog = existsSync(join(dh, 'logs/poll.log')) ? readFileSync(join(dh, 'logs/poll.log'), 'utf8') : ''
  const lanes = existsSync(join(dh, 'lanes')) ? readdirSync(join(dh, 'lanes')) : []
  return { status: r.status, stderr: r.stderr, pollLog, lanes }
}

async function waitFor(pred, ms = 10_000) {
  for (const t0 = Date.now(); !pred(); ) {
    if (Date.now() - t0 > ms) return false
    await new Promise((res) => setTimeout(res, 50))
  }
  return true
}

describe('poll.sh cold path: node resolution', () => {
  test('node v14 on PATH: one clear error line in poll.log, non-zero exit, no lane, no spawn', () => {
    const d = daemon({ pathNode: 'v14.21.3' })
    const r = poll(d)
    assert.notEqual(r.status, 0, r.stderr)
    const errors = r.pollLog.split('\n').filter((l) => l.includes('ERROR'))
    assert.equal(errors.length, 1, r.pollLog)
    assert.ok(
      errors[0].endsWith(
        `ERROR: node '${join(d.home, 'fakebin/node')}' is v14.21.3; bin/run-once.mjs needs node >= 22 (set NODE_BIN in .env) — not spawning heartbeat.md`,
      ),
      errors[0],
    )
    assert.doesNotMatch(r.pollLog, /spawned/)
    assert.deepEqual(r.lanes, [])
    assert.ok(!existsSync(join(d.home, 'path-node.spawned')))
    assert.ok(!existsSync(join(d.dh, 'last-heartbeat')))
  })

  test('NODE_BIN wins over PATH: a v22 NODE_BIN is spawned even with v14 on PATH', async () => {
    const d = daemon({ pathNode: 'v14.21.3' })
    const nodeBin = join(d.home, 'node22')
    fakeNode(nodeBin, 'v22.3.0', 'node-bin')
    writeFileSync(join(d.dh, '.env'), `NODE_BIN=${nodeBin}\n`, { flag: 'a' })
    const r = poll(d)
    assert.equal(r.status, 0, r.stderr)
    assert.doesNotMatch(r.pollLog, /ERROR/)
    assert.match(r.pollLog, /spawned heartbeat\.md in lane 1/)
    const spawned = join(d.home, 'node-bin.spawned')
    assert.ok(await waitFor(() => existsSync(spawned)), 'NODE_BIN was not spawned')
    assert.match(readFileSync(spawned, 'utf8'), /fermi-daemon\/bin\/run-once\.mjs --prompt prompts\/heartbeat\.md/)
    assert.ok(!existsSync(join(d.home, 'path-node.spawned')))
  })

  test('NODE_BIN wins over PATH: a v14 NODE_BIN is refused even with v22 on PATH', () => {
    const d = daemon({ pathNode: 'v22.3.0' })
    const nodeBin = join(d.home, 'node14')
    fakeNode(nodeBin, 'v14.21.3', 'node-bin')
    writeFileSync(join(d.dh, '.env'), `NODE_BIN=${nodeBin}\n`, { flag: 'a' })
    const r = poll(d)
    assert.notEqual(r.status, 0)
    assert.match(r.pollLog, new RegExp(`ERROR: node '${nodeBin}' is v14\\.21\\.3; .* not spawning heartbeat\\.md`))
    assert.deepEqual(r.lanes, [])
  })

  test('a NODE_BIN that does not exist fails loudly too', () => {
    const d = daemon()
    writeFileSync(join(d.dh, '.env'), `NODE_BIN=${join(d.home, 'nope')}\n`, { flag: 'a' })
    const r = poll(d)
    assert.notEqual(r.status, 0)
    assert.match(r.pollLog, /ERROR: node '.*\/nope' is vunknown; bin\/run-once\.mjs needs node >= 22/)
    assert.deepEqual(r.lanes, [])
  })
})

describe('poll.sh cold path: run-once output', () => {
  test('a crashing run-once leaves its error in runs/<ts>.log', async () => {
    // No prompt file: the real run-once crashes with an uncaught ENOENT on stderr.
    const d = daemon({ env: `NODE_BIN=${process.execPath}\n`, prompt: false })
    symlinkSync(join(ROOT, 'bin'), join(d.dh, 'bin'))
    const r = poll(d)
    assert.equal(r.status, 0, r.stderr)
    const runLog = r.pollLog.match(/log (runs\/\S+\.log)\)/)?.[1]
    assert.ok(runLog, r.pollLog)
    const path = join(d.dh, runLog)
    const crashed = () => existsSync(path) && /ENOENT/.test(readFileSync(path, 'utf8'))
    assert.ok(await waitFor(crashed), `no crash in ${runLog}: ${existsSync(path) && readFileSync(path, 'utf8')}`)
    assert.match(readFileSync(path, 'utf8'), /prompts\/heartbeat\.md/)
  })
})
