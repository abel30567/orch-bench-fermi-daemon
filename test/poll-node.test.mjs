// poll.sh cold path: node resolution (NODE_BIN / PATH, >= 22) and run-once
// output capture. Runs poll.sh against a throwaway HOME with fake curl/pgrep,
// so it never touches the network or a real daemon home.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, chmodSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'

const POLL = join(dirname(fileURLToPath(import.meta.url)), '..', 'poll.sh')
const hasZsh = spawnSync('zsh', ['-c', 'true']).status === 0

function exe(path, body) {
  writeFileSync(path, body)
  chmodSync(path, 0o755)
}

// Fake daemon home + fake bin dir. pgrep always "finds nothing" (warm worker
// down) and curl reports 0 pending, so poll.sh takes the heartbeat fallback.
function setup({ env = '', runOnce = 'process.exit(0)\n' } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'poll-node-'))
  const d = join(home, 'fermi-daemon')
  for (const sub of ['logs', 'runs', 'prompts', 'bin']) mkdirSync(join(d, sub), { recursive: true })
  writeFileSync(join(d, '.env'), `FERMI_URL=http://127.0.0.1:9\nFERMI_BEARER_TOKEN=x\n${env}`)
  writeFileSync(join(d, 'prompts', 'heartbeat.md'), 'hi\n')
  writeFileSync(join(d, 'bin', 'run-once.mjs'), runOnce)
  const fake = join(home, 'fakebin')
  mkdirSync(fake)
  exe(join(fake, 'pgrep'), '#!/bin/sh\nexit 1\n')
  exe(join(fake, 'curl'), '#!/bin/sh\necho \'{"pending":0}\'\n')
  return { home, d, fake }
}

function poll({ home, fake }, pathPrefix = []) {
  return spawnSync('zsh', [POLL], {
    env: { HOME: home, PATH: [...pathPrefix, fake, process.env.PATH].join(':') },
    encoding: 'utf8',
  })
}

const pollLog = (d) => (existsSync(join(d, 'logs', 'poll.log')) ? readFileSync(join(d, 'logs', 'poll.log'), 'utf8') : '')
const lanes = (d) => (existsSync(join(d, 'lanes')) ? readdirSync(join(d, 'lanes')) : [])

async function waitFor(fn, ms = 10000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const v = fn()
    if (v) return v
    await sleep(50)
  }
  return fn()
}

test('a node older than 22 logs one error line, exits non-zero and spawns nothing', { skip: !hasZsh && 'zsh not installed' }, () => {
  const ctx = setup()
  const old = join(ctx.home, 'oldbin')
  mkdirSync(old)
  exe(join(old, 'node'), '#!/bin/sh\necho v14.21.3\n')
  try {
    const r = poll(ctx, [old])
    assert.notEqual(r.status, 0)
    const lines = pollLog(ctx.d).trim().split('\n').filter((l) => l.includes('ERROR'))
    assert.equal(lines.length, 1)
    assert.match(
      lines[0],
      new RegExp(
        `ERROR: node '${join(old, 'node')}' is v14\\.21\\.3; bin/run-once\\.mjs needs node >= 22 \\(set NODE_BIN in \\.env\\) — not spawning heartbeat\\.md$`,
      ),
    )
    assert.doesNotMatch(pollLog(ctx.d), /spawned/)
    assert.deepEqual(lanes(ctx.d), [])
    assert.deepEqual(readdirSync(join(ctx.d, 'runs')), [])
  } finally {
    rmSync(ctx.home, { recursive: true, force: true })
  }
})

test('a missing node fails loudly too', { skip: !hasZsh && 'zsh not installed' }, () => {
  const ctx = setup({ env: `NODE_BIN=/nonexistent/node\n` })
  try {
    const r = poll(ctx)
    assert.notEqual(r.status, 0)
    assert.match(pollLog(ctx.d), /ERROR: node '\/nonexistent\/node' is vunknown; .* not spawning heartbeat\.md/)
    assert.deepEqual(lanes(ctx.d), [])
  } finally {
    rmSync(ctx.home, { recursive: true, force: true })
  }
})

test('NODE_BIN from .env wins over the node on PATH', { skip: !hasZsh && 'zsh not installed' }, async () => {
  const ctx = setup({ env: '' })
  const old = join(ctx.home, 'oldbin')
  mkdirSync(old)
  exe(join(old, 'node'), '#!/bin/sh\necho v14.21.3\n')
  const marker = join(ctx.home, 'used-node-bin')
  const wrapper = join(ctx.home, 'node22')
  exe(wrapper, `#!/bin/sh\n[ "$1" = -v ] || touch '${marker}'\nexec '${process.execPath}' "$@"\n`)
  writeFileSync(join(ctx.d, '.env'), readFileSync(join(ctx.d, '.env'), 'utf8') + `NODE_BIN=${wrapper}\n`)
  try {
    const r = poll(ctx, [old])
    assert.equal(r.status, 0, r.stderr)
    assert.doesNotMatch(pollLog(ctx.d), /ERROR/)
    assert.match(pollLog(ctx.d), /spawned heartbeat\.md in lane 1/)
    assert.ok(await waitFor(() => existsSync(marker)), 'run-once was not started with NODE_BIN')
  } finally {
    rmSync(ctx.home, { recursive: true, force: true })
  }
})

test("a crashing run-once leaves its error in runs/<ts>.log", { skip: !hasZsh && 'zsh not installed' }, async () => {
  const ctx = setup({
    env: `NODE_BIN=${process.execPath}\n`,
    runOnce: "throw new Error('run-once exploded on purpose')\n",
  })
  try {
    const r = poll(ctx)
    assert.equal(r.status, 0, r.stderr)
    const runs = await waitFor(() => readdirSync(join(ctx.d, 'runs')).filter((f) => f.endsWith('.log')))
    assert.equal(runs.length, 1)
    const log = await waitFor(() => {
      const s = readFileSync(join(ctx.d, 'runs', runs[0]), 'utf8')
      return s.includes('run-once exploded on purpose') && s
    })
    assert.ok(log, 'run-once stderr did not reach the run log')
  } finally {
    rmSync(ctx.home, { recursive: true, force: true })
  }
})
