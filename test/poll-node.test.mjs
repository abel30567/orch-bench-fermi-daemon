// poll.sh cold path: node resolution (NODE_BIN / PATH), the node >= 22 check
// and run-once's output landing in runs/<ts>.log. Runs the real poll.sh with a
// fake $HOME (so DAEMON_HOME is a temp dir) and fake curl/pgrep/python3 on
// PATH: one pending task, warm worker down, no network.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, chmodSync, copyFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ROOT } from './run-worker.mjs'

const hasZsh = spawnSync('zsh', ['-c', 'true']).status === 0

function exe(path, body) {
  writeFileSync(path, body)
  chmodSync(path, 0o755)
}

// Fake node: answers -v with `version`; any other call records its argv.
function fakeNode(path, version) {
  exe(path, `#!/bin/sh\nif [ "$1" = "-v" ]; then echo "${version}"; exit 0; fi\necho "$@" >>"${path}.calls"\n`)
}

function setup({ nodeBin, runOnce } = {}) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'pr50-')))
  const daemon = join(home, 'fermi-daemon')
  const fakebin = join(home, 'fakebin')
  for (const d of [daemon, fakebin, join(daemon, 'logs'), join(daemon, 'runs'), join(daemon, 'bin'), join(daemon, 'prompts')]) mkdirSync(d, { recursive: true })
  copyFileSync(join(ROOT, 'poll.sh'), join(daemon, 'poll.sh'))
  writeFileSync(join(daemon, 'prompts/drain.md'), 'drain\n')
  writeFileSync(join(daemon, 'bin/run-once.mjs'), runOnce ?? '')
  writeFileSync(
    join(daemon, '.env'),
    `FERMI_URL=http://127.0.0.1:9\nFERMI_BEARER_TOKEN=test\nMAX_CONCURRENT=2\n${nodeBin ? `NODE_BIN=${nodeBin}\n` : ''}`,
  )
  exe(join(fakebin, 'curl'), '#!/bin/sh\necho \'{"pending":1}\'\n')
  exe(join(fakebin, 'pgrep'), '#!/bin/sh\nexit 1\n')
  exe(join(fakebin, 'python3'), '#!/bin/sh\nexit 0\n')
  return { home, daemon, fakebin }
}

function poll({ home, daemon, fakebin }) {
  return spawnSync('zsh', [join(daemon, 'poll.sh')], { env: { HOME: home, PATH: `${fakebin}:/usr/bin:/bin:/usr/sbin:/sbin` }, encoding: 'utf8', timeout: 20_000 })
}

const pollLog = (daemon) => (existsSync(join(daemon, 'logs/poll.log')) ? readFileSync(join(daemon, 'logs/poll.log'), 'utf8') : '')

async function waitFor(fn, ms = 10_000) {
  const end = Date.now() + ms
  for (;;) {
    const v = fn()
    if (v) return v
    if (Date.now() > end) return v
    await new Promise((r) => setTimeout(r, 50))
  }
}

describe('poll.sh cold-path node check', { skip: !hasZsh && 'zsh not installed' }, () => {
  test('node v14 logs the error line, exits non-zero and takes no lane', () => {
    const env = setup()
    const node14 = join(env.home, 'node14')
    fakeNode(node14, 'v14.21.3')
    writeFileSync(join(env.daemon, '.env'), readFileSync(join(env.daemon, '.env'), 'utf8') + `NODE_BIN=${node14}\n`)
    const r = poll(env)
    assert.notEqual(r.status, 0)
    assert.match(
      pollLog(env.daemon),
      new RegExp(`ERROR: node '${node14}' is v14\\.21\\.3; bin/run-once\\.mjs needs node >= 22 \\(set NODE_BIN in \\.env\\) — not spawning drain\\.md\\n`),
    )
    assert.doesNotMatch(pollLog(env.daemon), /spawned/)
    assert.deepEqual(readdirSync(join(env.daemon, 'lanes')), [])
    assert.deepEqual(readdirSync(join(env.daemon, 'runs')), [])
    assert.equal(existsSync(node14 + '.calls'), false)
  })

  test('v14 node on PATH (no NODE_BIN) is refused too', () => {
    const env = setup()
    fakeNode(join(env.fakebin, 'node'), 'v14.21.3')
    const r = poll(env)
    assert.notEqual(r.status, 0)
    assert.match(pollLog(env.daemon), /ERROR: node '.*\/fakebin\/node' is v14\.21\.3; .* not spawning drain\.md/)
    assert.deepEqual(readdirSync(join(env.daemon, 'lanes')), [])
  })

  test('missing node fails loudly', () => {
    const env = setup({ nodeBin: '/nonexistent/node' })
    const r = poll(env)
    assert.notEqual(r.status, 0)
    assert.match(pollLog(env.daemon), /ERROR: node '\/nonexistent\/node' is vunknown; bin\/run-once\.mjs needs node >= 22 .* not spawning drain\.md/)
  })

  test('NODE_BIN is honoured over node on PATH', async () => {
    const env = setup()
    const pathNode = join(env.fakebin, 'node')
    fakeNode(pathNode, 'v14.21.3')
    const node22 = join(env.home, 'node22')
    fakeNode(node22, 'v22.12.0')
    writeFileSync(join(env.daemon, '.env'), readFileSync(join(env.daemon, '.env'), 'utf8') + `NODE_BIN=${node22}\n`)
    const r = poll(env)
    assert.equal(r.status, 0, r.stderr)
    assert.match(pollLog(env.daemon), /spawned drain\.md in lane 1/)
    const calls = await waitFor(() => existsSync(node22 + '.calls') && readFileSync(node22 + '.calls', 'utf8'))
    assert.match(calls, new RegExp(`^${env.daemon}/bin/run-once\\.mjs --prompt prompts/drain\\.md --log runs/\\S+\\.log`))
    assert.equal(existsSync(pathNode + '.calls'), false)
  })

  test('without NODE_BIN, node on PATH is used', async () => {
    const env = setup()
    const pathNode = join(env.fakebin, 'node')
    fakeNode(pathNode, 'v22.12.0')
    const r = poll(env)
    assert.equal(r.status, 0, r.stderr)
    const calls = await waitFor(() => existsSync(pathNode + '.calls') && readFileSync(pathNode + '.calls', 'utf8'))
    assert.match(calls, /bin\/run-once\.mjs --prompt prompts\/drain\.md/)
  })

  test('a crashing run-once leaves its error in runs/<ts>.log', async () => {
    const env = setup({ nodeBin: process.execPath, runOnce: "throw new Error('run-once exploded pr50')\n" })
    const r = poll(env)
    assert.equal(r.status, 0, r.stderr)
    const logs = () => readdirSync(join(env.daemon, 'runs')).filter((f) => f.endsWith('.log'))
    const content = await waitFor(() => {
      const [f] = logs()
      const s = f && readFileSync(join(env.daemon, 'runs', f), 'utf8')
      return s && s.includes('run-once exploded pr50') && s
    })
    assert.ok(content, `runs/ log should contain the crash, got: ${logs().map((f) => readFileSync(join(env.daemon, 'runs', f), 'utf8'))}`)
    assert.match(content, /Error: run-once exploded pr50/)
  })
})
