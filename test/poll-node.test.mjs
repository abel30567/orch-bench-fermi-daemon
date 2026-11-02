// poll.sh's cold path must not fail silently (DMN-7 ruling): node is resolved
// as $NODE_BIN (from .env) or `command -v node`, must be >= 22, and run-once's
// own stdout/stderr land in the run's log.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, chmodSync, copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ROOT } from './run-worker.mjs'

const script = (path, body) => {
  writeFileSync(path, `#!/bin/sh\n${body}\n`)
  chmodSync(path, 0o755)
}

// A throwaway $HOME/fermi-daemon with a stub bin/run-once.mjs, and a PATH whose
// curl reports `pending` tasks and whose pgrep says the warm worker is down.
function setup({ pending = 0, env = '', pathNode, runOnce = "console.log('stub run-once', process.argv.slice(2).join(' '))" } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'poll-node-'))
  const daemon = join(home, 'fermi-daemon')
  const fakebin = join(home, 'fakebin')
  for (const d of ['bin', 'prompts', 'logs', 'runs']) mkdirSync(join(daemon, d), { recursive: true })
  mkdirSync(fakebin)
  copyFileSync(join(ROOT, 'poll.sh'), join(daemon, 'poll.sh'))
  writeFileSync(join(daemon, '.env'), `FERMI_URL=http://127.0.0.1:9\nFERMI_BEARER_TOKEN=t\n${env}`)
  writeFileSync(join(daemon, 'bin/run-once.mjs'), runOnce + '\n')
  writeFileSync(join(daemon, 'narrator.py'), '')
  script(join(fakebin, 'curl'), `echo '{"pending":${pending}}'`)
  script(join(fakebin, 'pgrep'), 'exit 1')
  if (pathNode) script(join(fakebin, 'node'), pathNode)
  return { home, daemon, fakebin }
}

function poll(ctx) {
  const r = spawnSync('zsh', [join(ctx.daemon, 'poll.sh')], {
    env: { HOME: ctx.home, PATH: `${ctx.fakebin}:/usr/bin:/bin:/usr/sbin:/sbin` },
    encoding: 'utf8',
  })
  const pollLog = existsSync(join(ctx.daemon, 'logs/poll.log')) ? readFileSync(join(ctx.daemon, 'logs/poll.log'), 'utf8') : ''
  return { status: r.status, stderr: r.stderr, pollLog }
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const lanes = (ctx) => (existsSync(join(ctx.daemon, 'lanes')) ? readdirSync(join(ctx.daemon, 'lanes')) : [])

// run-once is spawned detached; wait for its run log to settle on `pattern`.
async function runLog(ctx, pattern) {
  const runs = join(ctx.daemon, 'runs')
  for (const t0 = Date.now(); Date.now() - t0 < 10_000; await new Promise((r) => setTimeout(r, 50))) {
    const logs = readdirSync(runs).filter((f) => f.endsWith('.log'))
    const text = logs.map((f) => readFileSync(join(runs, f), 'utf8')).join('')
    if (pattern.test(text)) return { logs, text }
  }
  throw new Error(`no run log matching ${pattern}: ${readdirSync(runs)}`)
}

describe('poll.sh node resolution', () => {
  test('AC1: a node v14 on PATH logs one error line, exits non-zero, claims no lane', () => {
    const ctx = setup({ pending: 2, pathNode: 'echo v14.21.3' })
    const r = poll(ctx)
    assert.notEqual(r.status, 0, r.stderr)
    const lines = r.pollLog.trim().split('\n').filter((l) => l.includes('ERROR'))
    assert.equal(lines.length, 1, r.pollLog)
    assert.match(
      lines[0],
      new RegExp(
        `ERROR: node '${esc(join(ctx.fakebin, 'node'))}' is v14\\.21\\.3; bin/run-once\\.mjs needs node >= 22 \\(set NODE_BIN in \\.env\\) — not spawning drain\\.md$`,
      ),
    )
    assert.doesNotMatch(r.pollLog, /spawned/)
    assert.deepEqual(lanes(ctx), [])
    assert.deepEqual(readdirSync(join(ctx.daemon, 'runs')), [])
  })

  test('no node at all is an error too, not a silent no-op', () => {
    const ctx = setup()
    // a PATH with no node on it (the system dirs may have one; shadow them)
    script(join(ctx.fakebin, 'node'), 'exit 127')
    const r = poll(ctx)
    assert.notEqual(r.status, 0)
    assert.match(r.pollLog, /ERROR: node '.*' is vunknown; .* — not spawning heartbeat\.md$/m)
    assert.deepEqual(lanes(ctx), [])
  })

  test('AC2: NODE_BIN in .env wins over the node on PATH', async () => {
    const wrapper = join(mkdtempSync(join(tmpdir(), 'poll-nodebin-')), 'node22')
    script(wrapper, `echo nodebin-used >&2\nexec "${process.execPath}" "$@"`)
    const ctx = setup({ env: `NODE_BIN=${wrapper}\n`, pathNode: 'echo v14.21.3' })
    const r = poll(ctx)
    assert.equal(r.status, 0, r.pollLog + r.stderr)
    assert.doesNotMatch(r.pollLog, /ERROR/)
    assert.match(r.pollLog, /spawned heartbeat\.md in lane 1/)
    const { text } = await runLog(ctx, /stub run-once --prompt prompts\/heartbeat\.md/)
    assert.match(text, /nodebin-used/)
  })

  test('AC2: an old NODE_BIN is reported by its path', () => {
    const old = join(mkdtempSync(join(tmpdir(), 'poll-nodebin-')), 'node14')
    script(old, 'echo v14.21.3')
    const ctx = setup({ env: `NODE_BIN=${old}\n` })
    const r = poll(ctx)
    assert.notEqual(r.status, 0)
    assert.match(r.pollLog, new RegExp(`ERROR: node '${esc(old)}' is v14\\.21\\.3; .* — not spawning heartbeat\\.md$`, 'm'))
    assert.deepEqual(lanes(ctx), [])
  })

  test('AC3: a crashing run-once leaves its error in runs/<ts>.log', async () => {
    const ctx = setup({
      env: `NODE_BIN=${process.execPath}\n`,
      runOnce: "throw new Error('run-once kaboom')",
    })
    const r = poll(ctx)
    assert.equal(r.status, 0, r.pollLog + r.stderr)
    const { logs, text } = await runLog(ctx, /Error: run-once kaboom/)
    assert.equal(logs.length, 1)
    assert.match(logs[0], /^\d{8}-\d{6}-\d+-\d+\.log$/)
    assert.match(r.pollLog, new RegExp(`log runs/${esc(logs[0])}\\)`))
    assert.match(text, /run-once kaboom/)
  })
})
