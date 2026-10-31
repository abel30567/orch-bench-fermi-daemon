// poll.sh cold path: node resolution (NODE_BIN / PATH, major >= 22) and
// run-once output capture. Runs the real poll.sh under zsh against a temp
// $HOME/fermi-daemon with fake curl/pgrep/python3 on PATH (no network).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const POLL = join(dirname(fileURLToPath(import.meta.url)), '..', 'poll.sh')
const hasZsh = spawnSync('zsh', ['-c', 'true']).status === 0

function exe(path, body) {
  writeFileSync(path, body)
  chmodSync(path, 0o755)
}

// Daemon home with one pending task and the warm worker reported down.
function setup({ env = '', runOnce = 'process.exit(0)\n' } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'poll-cold-'))
  const d = join(home, 'fermi-daemon')
  for (const sub of ['logs', 'runs', 'prompts', 'bin', 'fakebin', 'oldnode']) mkdirSync(join(d, sub), { recursive: true })
  writeFileSync(join(d, '.env'), `FERMI_URL=http://127.0.0.1:9\nFERMI_BEARER_TOKEN=x\n${env}`)
  writeFileSync(join(d, 'prompts', 'drain.md'), 'drain\n')
  writeFileSync(join(d, 'prompts', 'heartbeat.md'), 'heartbeat\n')
  writeFileSync(join(d, 'bin', 'run-once.mjs'), runOnce)
  exe(join(d, 'fakebin', 'curl'), '#!/bin/sh\necho \'{"pending":1}\'\n')
  exe(join(d, 'fakebin', 'pgrep'), '#!/bin/sh\nexit 1\n')
  exe(join(d, 'fakebin', 'python3'), '#!/bin/sh\nexit 0\n')
  exe(join(d, 'oldnode', 'node'), '#!/bin/sh\n[ "$1" = -v ] && { echo v14.21.3; exit 0; }\necho "old node ran" >&2\nexit 1\n')
  return { home, d }
}

function poll(home, pathDirs) {
  return spawnSync('zsh', [POLL], {
    env: { HOME: home, PATH: [...pathDirs, '/usr/bin', '/bin'].join(':') },
    encoding: 'utf8',
    timeout: 20000,
  })
}

const pollLog = (d) => (existsSync(join(d, 'logs', 'poll.log')) ? readFileSync(join(d, 'logs', 'poll.log'), 'utf8') : '')

async function waitFor(fn, ms = 10000) {
  const end = Date.now() + ms
  for (;;) {
    const v = fn()
    if (v || Date.now() > end) return v
    await new Promise((r) => setTimeout(r, 50))
  }
}

function runLogs(d) {
  return readdirSync(join(d, 'runs'))
    .filter((f) => f.endsWith('.log'))
    .map((f) => readFileSync(join(d, 'runs', f), 'utf8'))
}

test('node v14 on PATH: one ERROR line in poll.log, non-zero exit, no lane', { skip: !hasZsh }, () => {
  const { home, d } = setup()
  try {
    const r = poll(home, [join(d, 'fakebin'), join(d, 'oldnode')])
    assert.notEqual(r.status, 0)
    const oldNode = join(d, 'oldnode', 'node')
    const errors = pollLog(d).split('\n').filter((l) => l.includes('ERROR:'))
    assert.equal(errors.length, 1, pollLog(d))
    assert.ok(
      errors[0].endsWith(
        `ERROR: node '${oldNode}' is v14.21.3; bin/run-once.mjs needs node >= 22 (set NODE_BIN in .env) — not spawning drain.md`,
      ),
      errors[0],
    )
    assert.doesNotMatch(pollLog(d), /spawned/)
    assert.deepEqual(readdirSync(join(d, 'lanes')), [])
    assert.deepEqual(readdirSync(join(d, 'runs')), [])
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('node missing entirely: ERROR line, non-zero exit, no lane', { skip: !hasZsh }, () => {
  const { home, d } = setup()
  try {
    // /usr/bin and /bin are still on PATH; only run this when they have no node.
    if (spawnSync('/bin/sh', ['-c', 'PATH=/usr/bin:/bin command -v node']).status === 0) return
    const r = poll(home, [join(d, 'fakebin')])
    assert.notEqual(r.status, 0)
    assert.match(pollLog(d), /ERROR: node 'node' is vunknown; .* — not spawning drain\.md/)
    assert.deepEqual(readdirSync(join(d, 'lanes')), [])
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('NODE_BIN overrides PATH: a good NODE_BIN spawns despite old node on PATH', { skip: !hasZsh }, async () => {
  const { home, d } = setup({ env: `NODE_BIN=${process.execPath}\n`, runOnce: 'console.log("run-once ran on", process.version)\n' })
  try {
    const r = poll(home, [join(d, 'fakebin'), join(d, 'oldnode')])
    assert.equal(r.status, 0, r.stderr)
    assert.doesNotMatch(pollLog(d), /ERROR/)
    assert.match(pollLog(d), /spawned drain\.md in lane 1/)
    const out = await waitFor(() => runLogs(d).find((l) => l.includes('run-once ran on')))
    assert.ok(out, 'run-once output reached runs/<ts>.log')
    assert.match(out, new RegExp(`run-once ran on ${process.version.replace(/\./g, '\\.')}`))
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('NODE_BIN overrides PATH: an old NODE_BIN is rejected even with good node on PATH', { skip: !hasZsh }, () => {
  const { home, d } = setup()
  const oldNode = join(d, 'oldnode', 'node')
  writeFileSync(join(d, '.env'), readFileSync(join(d, '.env'), 'utf8') + `NODE_BIN=${oldNode}\n`)
  try {
    const r = poll(home, [join(d, 'fakebin'), dirname(process.execPath)])
    assert.notEqual(r.status, 0)
    assert.match(pollLog(d), new RegExp(`ERROR: node '${oldNode.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}' is v14\\.21\\.3;`))
    assert.deepEqual(readdirSync(join(d, 'lanes')), [])
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('a crashing run-once leaves its error in runs/<ts>.log', { skip: !hasZsh }, async () => {
  const { home, d } = setup({ runOnce: 'throw new Error("run-once exploded")\n' })
  try {
    const r = poll(home, [join(d, 'fakebin'), dirname(process.execPath)])
    assert.equal(r.status, 0, r.stderr)
    const m = pollLog(d).match(/log (runs\/[^)]+\.log)\)/)
    assert.ok(m, pollLog(d))
    const out = await waitFor(() => {
      const f = join(d, m[1])
      const s = existsSync(f) ? readFileSync(f, 'utf8') : ''
      return s.includes('run-once exploded') && s
    })
    assert.ok(out, 'crash output reached the run log')
    assert.match(out, /Error: run-once exploded/)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
