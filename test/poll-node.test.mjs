// poll.sh's cold path (the fallback when the warm worker is down) must fail
// loudly: it resolves node as $NODE_BIN or `command -v node`, refuses to spawn
// on node < 22 with one poll.log error line, and run-once's own stdout/stderr
// land in runs/<ts>.log. Runs the real poll.sh against a fake daemon home with
// fake curl/pgrep/node on PATH (no network, no real harness).
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, chmodSync, copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ROOT } from './run-worker.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const exe = (path, body) => {
  writeFileSync(path, body)
  chmodSync(path, 0o755)
  return path
}

// A fake ~/fermi-daemon with one pending task and the warm worker down.
function setup({ runOnce } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'pr50-'))
  const d = join(home, 'fermi-daemon')
  for (const sub of ['bin', 'prompts', 'runs', 'logs', 'fakebin']) mkdirSync(join(d, sub), { recursive: true })
  copyFileSync(join(ROOT, 'poll.sh'), join(d, 'poll.sh'))
  writeFileSync(join(d, 'prompts/drain.md'), 'drain\n')
  writeFileSync(join(d, '.env'), `FERMI_URL=http://127.0.0.1:9\nFERMI_BEARER_TOKEN=test\nMAX_CONCURRENT=2\n`) // 2: with no lanes, poll.sh counts `ls -d` of an empty glob as one live lane
  // run-once stand-in: records which node ran it, its args and stdout/stderr.
  writeFileSync(
    join(d, 'bin/run-once.mjs'),
    runOnce ?? `console.log('run-once ran under ' + process.execPath + ' ' + process.argv.slice(2).join(' '))\n`,
  )
  const fb = join(d, 'fakebin')
  exe(join(fb, 'curl'), `#!/bin/sh\necho '{"pending":1}'\n`)
  exe(join(fb, 'pgrep'), '#!/bin/sh\nexit 1\n')
  exe(join(fb, 'python3'), '#!/bin/sh\nexit 0\n') // narrator stand-in
  return { home, d, fb }
}

const fakeNode = (path, version) => exe(path, `#!/bin/sh\n[ "$1" = "-v" ] && { echo ${version}; exit 0; }\necho "fake node ran" >>"$(dirname "$0")/fake-node-ran"\n`)
// A real node >= 22 behind a wrapper, so the test can tell it was the one used.
const realNode = (path) => exe(path, `#!/bin/sh\nexec "${process.execPath}" "$@"\n`)

const SYS_PATH = ['/usr/bin', '/bin', '/usr/sbin', '/sbin']
function poll({ home, fb }) {
  const PATH = [fb, ...SYS_PATH].join(':')
  return spawnSync('zsh', [join(home, 'fermi-daemon/poll.sh')], { env: { HOME: home, PATH }, encoding: 'utf8', timeout: 20000 })
}

const pollLog = (d) => (existsSync(join(d, 'logs/poll.log')) ? readFileSync(join(d, 'logs/poll.log'), 'utf8') : '')
const lanes = (d) => (existsSync(join(d, 'lanes')) ? readdirSync(join(d, 'lanes')) : [])
const runLogs = (d) => readdirSync(join(d, 'runs')).filter((f) => f.endsWith('.log'))
async function waitForRunLog(d, re) {
  for (let i = 0; i < 100; i++) {
    for (const f of runLogs(d)) {
      const s = readFileSync(join(d, 'runs', f), 'utf8')
      if (re.test(s)) return { file: f, text: s }
    }
    await sleep(100)
  }
  assert.fail(`no runs/*.log matching ${re}; runs=${runLogs(d)} poll.log=${pollLog(d)}`)
}

describe('AC1: node too old on PATH fails loudly with no lane', () => {
  test('fake node v14 → one poll.log ERROR line, non-zero exit, no lane, no spawn', () => {
    const t = setup()
    fakeNode(join(t.fb, 'node'), 'v14.21.3')
    const r = poll(t)
    assert.notEqual(r.status, 0, 'poll.sh must exit non-zero')
    const node = join(t.fb, 'node')
    const errs = pollLog(t.d).split('\n').filter((l) => l.includes('ERROR:'))
    assert.equal(errs.length, 1, pollLog(t.d))
    assert.ok(
      errs[0].endsWith(
        `ERROR: node '${node}' is v14.21.3; bin/run-once.mjs needs node >= 22 (set NODE_BIN in .env) — not spawning drain.md`,
      ),
      errs[0],
    )
    assert.doesNotMatch(pollLog(t.d), /spawned/)
    assert.deepEqual(lanes(t.d), [])
    assert.deepEqual(runLogs(t.d), [])
    assert.equal(existsSync(join(t.fb, 'fake-node-ran')), false)
  })

  const sysNode = SYS_PATH.some((p) => existsSync(join(p, 'node')))
  test('no node at all → ERROR line, non-zero exit, no lane', { skip: sysNode && 'a system node is on the test PATH' }, () => {
    const t = setup()
    const r = poll(t)
    assert.notEqual(r.status, 0)
    assert.match(pollLog(t.d), /ERROR: node '.*' is v\?; bin\/run-once\.mjs needs node >= 22 \(set NODE_BIN in \.env\) — not spawning drain\.md/)
    assert.deepEqual(lanes(t.d), [])
  })
})

describe('AC2: NODE_BIN from .env is honoured', () => {
  test('NODE_BIN (node >= 22) wins over an old node on PATH and runs run-once', async () => {
    const t = setup()
    const good = realNode(join(t.home, 'good-node')) // outside PATH
    writeFileSync(join(t.d, '.env'), readFileSync(join(t.d, '.env'), 'utf8') + `NODE_BIN=${good}\n`)
    fakeNode(join(t.fb, 'node'), 'v14.21.3')
    const r = poll(t)
    assert.equal(r.status, 0, r.stderr + pollLog(t.d))
    assert.doesNotMatch(pollLog(t.d), /ERROR/)
    assert.match(pollLog(t.d), /spawned drain\.md in lane 1/)
    await waitForRunLog(t.d, /run-once ran under .* --prompt prompts\/drain\.md --log runs\/\S+\.log --lane /)
    assert.equal(existsSync(join(t.fb, 'fake-node-ran')), false, 'PATH node must not run')
  })

  test('NODE_BIN pointing at an old node is rejected even if PATH node is fine', () => {
    const t = setup()
    const old = fakeNode(join(t.home, 'old-node'), 'v18.19.0')
    writeFileSync(join(t.d, '.env'), readFileSync(join(t.d, '.env'), 'utf8') + `NODE_BIN=${old}\n`)
    realNode(join(t.fb, 'node'))
    const r = poll(t)
    assert.notEqual(r.status, 0)
    assert.match(pollLog(t.d), new RegExp(`ERROR: node '${old}' is v18\\.19\\.0; .* not spawning drain\\.md`))
    assert.deepEqual(lanes(t.d), [])
  })
})

describe('AC3: run-once output goes to the run log, not /dev/null', () => {
  test('a crashing run-once leaves its error in runs/<ts>.log', async () => {
    const t = setup({ runOnce: `throw new Error('run-once-boom-pr50')\n` })
    realNode(join(t.fb, 'node'))
    const r = poll(t)
    assert.equal(r.status, 0, r.stderr + pollLog(t.d))
    const m = pollLog(t.d).match(/log (runs\/\S+\.log)\)/)
    assert.ok(m, pollLog(t.d))
    const { file, text } = await waitForRunLog(t.d, /run-once-boom-pr50/)
    assert.equal(`runs/${file}`, m[1])
    assert.match(text, /Error: run-once-boom-pr50/)
  })
})
