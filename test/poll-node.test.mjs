// poll.sh cold path: node resolution ($NODE_BIN, else PATH), the >= 22 guard,
// and run-once's own stdout/stderr landing in runs/<ts>.log. Runs the real
// poll.sh in a throwaway HOME with fake curl/pgrep (no network, warm worker
// reported down) and fake node binaries.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, chmodSync, symlinkSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ROOT } from './run-worker.mjs'

const hasZsh = spawnSync('zsh', ['-c', 'true']).status === 0

function exe(path, body) {
  writeFileSync(path, `#!/bin/sh\n${body}\n`)
  chmodSync(path, 0o755)
}

// A fake node: `-v` prints `version`; anything else is recorded in calls.log
// and (if `real`) handed to the real node.
function fakeNode(path, version, { real = false } = {}) {
  exe(
    path,
    `if [ "$1" = "-v" ]; then echo v${version}; exit 0; fi\n` +
      `echo "${path} $*" >> "$(dirname "$0")/calls.log"\n` +
      (real ? `exec "${process.execPath}" "$@"` : 'exit 0'),
  )
}

function setup({ env = '' } = {}) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'dmn7-poll-')))
  const daemon = join(home, 'fermi-daemon')
  for (const d of ['prompts', 'runs', 'logs', 'lanes']) mkdirSync(join(daemon, d), { recursive: true })
  for (const d of ['bin', 'harness', 'lib']) symlinkSync(join(ROOT, d), join(daemon, d))
  writeFileSync(join(daemon, 'prompts/drain.md'), 'test prompt\n')
  writeFileSync(join(daemon, '.env'), `FERMI_URL=http://127.0.0.1:9\nFERMI_BEARER_TOKEN=test\n${env}`)
  const fakes = join(home, 'fakebin')
  mkdirSync(fakes)
  exe(join(fakes, 'curl'), `echo '{"pending":1}'`)
  exe(join(fakes, 'pgrep'), 'exit 1') // warm worker is down
  return { home, daemon, fakes }
}

function poll({ home, fakes }, extraEnv = {}) {
  return spawnSync('zsh', [join(ROOT, 'poll.sh')], {
    env: { HOME: home, PATH: `${fakes}:${process.env.PATH}`, MAX_CONCURRENT: '5', MAX_RUNS_PER_HOUR: '0', ...extraEnv },
    encoding: 'utf8',
  })
}

const why = (ctx, r) => `exit ${r.status}\nstderr: ${r.stderr}\npoll.log: ${read(join(ctx.daemon, 'logs/poll.log'))}`

const read = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : '')

async function waitFor(fn, ms = 10000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const v = fn()
    if (v) return v
    await new Promise((r) => setTimeout(r, 50))
  }
  return fn()
}

describe('poll.sh cold-path node resolution', { skip: !hasZsh && 'zsh not installed' }, () => {
  test('node v14 on PATH: one clear poll.log error, non-zero exit, no lane, no spawn', () => {
    const ctx = setup()
    fakeNode(join(ctx.fakes, 'node'), '14.21.3')
    const r = poll(ctx)
    assert.notEqual(r.status, 0, why(ctx, r))
    const log = read(join(ctx.daemon, 'logs/poll.log'))
    const errors = log.split('\n').filter((l) => l.includes('ERROR:'))
    assert.equal(errors.length, 1, log)
    assert.ok(
      errors[0].endsWith(
        `ERROR: node '${join(ctx.fakes, 'node')}' is v14.21.3; bin/run-once.mjs needs node >= 22 (set NODE_BIN in .env) — not spawning drain.md`,
      ),
      errors[0],
    )
    assert.doesNotMatch(log, /spawned/)
    assert.deepEqual(readdirSync(join(ctx.daemon, 'lanes')), [])
    assert.deepEqual(readdirSync(join(ctx.daemon, 'runs')), [])
    assert.equal(read(join(ctx.fakes, 'calls.log')), '')
  })

  test('missing node: error line, non-zero exit, no lane', () => {
    const ctx = setup({ env: `NODE_BIN=${'/nonexistent/node'}\n` })
    const r = poll(ctx)
    assert.notEqual(r.status, 0, why(ctx, r))
    const log = read(join(ctx.daemon, 'logs/poll.log'))
    assert.match(log, /ERROR: node '\/nonexistent\/node' is v.*needs node >= 22 \(set NODE_BIN in \.env\) — not spawning drain\.md/)
    assert.deepEqual(readdirSync(join(ctx.daemon, 'lanes')), [])
  })

  test('NODE_BIN from .env is honoured over the node on PATH', async () => {
    const good = join(mkdtempSync(join(tmpdir(), 'dmn7-nodebin-')), 'node22')
    fakeNode(good, '22.12.0')
    const ctx = setup({ env: `NODE_BIN=${good}\n` })
    fakeNode(join(ctx.fakes, 'node'), '14.21.3')
    const r = poll(ctx)
    assert.equal(r.status, 0, why(ctx, r))
    const log = read(join(ctx.daemon, 'logs/poll.log'))
    assert.doesNotMatch(log, /ERROR/)
    assert.match(log, /spawned drain\.md in lane /)
    const calls = await waitFor(() => read(join(good, '../calls.log')))
    assert.match(calls, /node22 .*bin\/run-once\.mjs --prompt prompts\/drain\.md/)
    assert.equal(read(join(ctx.fakes, 'calls.log')), '')
  })

  test("a crashing run-once leaves its error in runs/<ts>.log", async () => {
    const ctx = setup()
    fakeNode(join(ctx.fakes, 'node'), '22.12.0', { real: true })
    // An unknown harness makes run-once throw at startup (uncaught, to stderr).
    const r = poll(ctx, { HARNESS: 'no-such-harness' })
    assert.equal(r.status, 0, why(ctx, r))
    const runs = join(ctx.daemon, 'runs')
    const text = await waitFor(() => {
      const f = readdirSync(runs).find((n) => n.endsWith('.log'))
      const t = f && read(join(runs, f))
      return t && t.includes('unknown HARNESS') && t
    })
    assert.ok(text, `runs/: ${readdirSync(runs).join(', ')}`)
    assert.match(text, /unknown HARNESS "no-such-harness"/)
  })
})
