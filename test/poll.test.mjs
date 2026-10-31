// poll.sh cold path: the real script in a throwaway HOME with fake curl (one
// pending task), pgrep (warm worker down), python3 (narrator) and node on PATH.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, chmodSync, copyFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { ROOT } from './run-worker.mjs'

function script(path, body) {
  writeFileSync(path, `#!/bin/sh\n${body}\n`)
  chmodSync(path, 0o755)
}

// Builds the fake HOME; `runOnce` is the body of the daemon's bin/run-once.mjs.
function setup({ env = '', runOnce = '' } = {}) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'pr50-')))
  const daemon = join(home, 'fermi-daemon')
  for (const d of ['bin', 'prompts', 'logs', 'runs']) mkdirSync(join(daemon, d), { recursive: true })
  copyFileSync(join(ROOT, 'poll.sh'), join(daemon, 'poll.sh'))
  writeFileSync(join(daemon, '.env'), `FERMI_URL=http://127.0.0.1:9\nFERMI_BEARER_TOKEN=test\n${env}`)
  writeFileSync(join(daemon, 'bin/run-once.mjs'), runOnce)
  writeFileSync(join(daemon, 'prompts/drain.md'), 'drain\n')
  const fake = join(home, 'fakebin')
  mkdirSync(fake)
  script(join(fake, 'curl'), `echo '{"pending": 1}'`)
  script(join(fake, 'pgrep'), 'exit 1')
  script(join(fake, 'python3'), 'exit 0')
  script(join(fake, 'node'), `echo v14.21.3`)
  return { home, daemon, fake }
}

function poll({ home, daemon, fake }) {
  return spawnSync('zsh', [join(daemon, 'poll.sh')], {
    env: { HOME: home, PATH: `${fake}:/usr/bin:/bin:/usr/sbin:/sbin` },
    encoding: 'utf8',
  })
}

const pollLog = (daemon) => readFileSync(join(daemon, 'logs/poll.log'), 'utf8')
const lanes = (daemon) => (existsSync(join(daemon, 'lanes')) ? readdirSync(join(daemon, 'lanes')) : [])

async function waitFor(fn, ms = 10000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(50)) {
    const v = fn()
    if (v) return v
  }
  return fn()
}

test('a node older than 22 logs the error line, exits non-zero and spawns no lane', () => {
  const t = setup()
  const r = poll(t)
  assert.notEqual(r.status, 0)
  const errors = pollLog(t.daemon).split('\n').filter((l) => l.includes('ERROR'))
  assert.equal(errors.length, 1)
  assert.match(
    errors[0],
    new RegExp(`ERROR: node '${t.fake}/node' is v14\\.21\\.3; bin/run-once\\.mjs needs node >= 22 \\(set NODE_BIN in \\.env\\) — not spawning drain\\.md$`),
  )
  assert.doesNotMatch(pollLog(t.daemon), /spawned/)
  assert.deepEqual(lanes(t.daemon), [])
  assert.deepEqual(readdirSync(join(t.daemon, 'runs')), [])
})

test('NODE_BIN from .env is used instead of the node on PATH', async () => {
  const t = setup()
  const wrapper = join(t.home, 'node22')
  const marker = join(t.home, 'node22.args')
  script(wrapper, `[ "$1" = --version ] || echo "$@" >"${marker}"\nexec "${process.execPath}" "$@"`)
  writeFileSync(join(t.daemon, '.env'), `${readFileSync(join(t.daemon, '.env'), 'utf8')}NODE_BIN=${wrapper}\n`)
  const r = poll(t)
  assert.equal(r.status, 0, r.stderr)
  assert.doesNotMatch(pollLog(t.daemon), /ERROR/)
  assert.match(pollLog(t.daemon), /spawned drain\.md in lane 1/)
  const args = await waitFor(() => existsSync(marker) && readFileSync(marker, 'utf8'))
  assert.match(args, /bin\/run-once\.mjs --prompt prompts\/drain\.md --log runs\/\S+\.log/)
})

test("a crashing run-once leaves its error in the run's log", async () => {
  const t = setup({ env: `NODE_BIN=${process.execPath}\n`, runOnce: `throw new Error('run-once exploded')\n` })
  const r = poll(t)
  assert.equal(r.status, 0, r.stderr)
  const logName = pollLog(t.daemon).match(/log runs\/(\S+\.log)\)/)[1]
  const out = await waitFor(() => {
    const p = join(t.daemon, 'runs', logName)
    const s = existsSync(p) && readFileSync(p, 'utf8')
    return s && s.includes('run-once exploded') && s
  })
  assert.ok(out, `runs/${logName} should contain the crash`)
  assert.match(out, /Error: run-once exploded/)
})
