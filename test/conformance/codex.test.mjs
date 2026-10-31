// The conformance suite (./suite.mjs) for the codex adapter, against ./fake-codex.mjs,
// plus its early-exit paths: a codex that exits before reading its prompt used to crash
// the caller with an uncaught `write EPIPE` on its stdin (a race on fast Linux runners).
// The fake now exits before reading stdin and the prompt is larger than a pipe buffer,
// so the EPIPE is hit on every run.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { once } from 'node:events'
import { runConformance } from './suite.mjs'
import * as codex from '../../harness/codex.mjs'
import { supervise } from '../../harness/supervise.mjs'

const bin = join(mkdtempSync(join(tmpdir(), 'dmn-codex-bin-')), 'codex')
const fake = join(dirname(fileURLToPath(import.meta.url)), 'fake-codex.mjs')
writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${fake}" "$@"\n`)
chmodSync(bin, 0o755)

runConformance(() => codex, { name: 'codex', options: { bin } }, {
  expectedFail: {
    credential_isolation:
      'SWAP-GATE BLOCKER: codex reads its credential from CODEX_HOME/auth.json or OPENAI_API_KEY; no fd handoff, so the adapter refuses tokenFd (see harness/codex.mjs)',
  },
})

const BIG = 'x'.repeat(1 << 20) // larger than any pipe buffer: the write cannot complete before the exit
const EARLY = { FAKE_EXIT_EARLY: '3' }
const MCP = { mcpServers: {} } // gives the run its own CODEX_HOME

// Run fn with tmpdir() pointing at a fresh dir (where the adapter makes CODEX_HOME); → that dir.
async function inTmp(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'dmn-codex-tmp-'))
  const saved = process.env.TMPDIR
  process.env.TMPDIR = dir
  try {
    await fn(dir)
  } finally {
    process.env.TMPDIR = saved
  }
  return dir
}

describe('codex exiting early is a crash, never an uncaught exception', () => {
  test('runOnce: codex exits non-zero before reading its prompt', async () => {
    const res = await codex.runOnce({ bin, prompt: BIG, env: EARLY }).done
    assert.equal(res.code, 3)
    assert.equal(res.outcome?.type, 'turn_end')
    assert.equal(res.outcome.ok, false)
    assert.equal(res.outcome.kind, 'crash')
    assert.match(res.outcome.detail, /exited \(3\)/)
    assert.equal(res.events.filter((e) => e.type === 'turn_end').length, 1)
    assert.match(res.stderr, /fake codex: exiting early/)
  })

  test('runOnce: codex exits non-zero mid-turn', async () => {
    const res = await codex.runOnce({ bin, prompt: 'crash' }).done
    assert.equal(res.code, 1)
    assert.equal(res.outcome?.kind, 'crash')
    assert.ok(res.events.some((e) => e.type === 'text' && e.text === 'About to crash'))
  })

  test('runOnce: a failed turn keeps its own outcome', async () => {
    const res = await codex.runOnce({ bin, prompt: 'error-auth' }).done
    assert.equal(res.code, 1)
    assert.equal(res.outcome?.kind, 'auth')
    assert.equal(res.events.filter((e) => e.type === 'turn_end').length, 1)
  })

  test('runOnce: a missing binary is a crash', async () => {
    const res = await codex.runOnce({ bin: join(tmpdir(), 'no-such-codex'), prompt: BIG }).done
    assert.equal(res.outcome?.kind, 'crash')
    assert.match(res.stderr, /codex adapter: .*ENOENT/)
  })

  test('runOnce: a codex the caller kills did not crash', async () => {
    const run = codex.runOnce({ bin, prompt: 'hang' })
    setTimeout(() => run.close('SIGTERM'), 300)
    const res = await run.done
    assert.equal(res.outcome, null)
  })

  test('startSession: codex exits before reading its first request', async () => {
    const s = codex.startSession({ bin, env: EARLY })
    const stderr = []
    s.events.on('stderr', (d) => stderr.push(d))
    const [code] = await once(s.events, 'exit')
    assert.equal(code, 3)
    await new Promise((r) => setTimeout(r, 100))
    assert.equal(s.alive, false)
    assert.equal(s.send(BIG), false, 'a dead session takes no turn')
    assert.match(stderr.join(''), /fake codex: exiting early/)
  })

  test('startSession (supervised): a turn sent as codex dies ends as crash', async () => {
    const s = supervise(codex.startSession({ bin, env: EARLY }), {})
    const ended = new Promise((r) => s.events.on('event', (ev) => ev.type === 'turn_end' && r(ev)))
    assert.equal(s.send(BIG), true)
    const end = await ended
    assert.equal(end.ok, false)
    assert.equal(end.kind, 'crash')
  })
})

describe('per-run CODEX_HOME is removed on every exit path', () => {
  const paths = {
    'a completed run': async () => assert.equal((await codex.runOnce({ bin, prompt: 'turn', mcpConfig: MCP }).done).outcome.ok, true),
    'an exit before reading the prompt': async () => {
      const res = await codex.runOnce({ bin, prompt: BIG, mcpConfig: MCP, env: EARLY }).done
      assert.match(res.stderr, /CODEX_HOME=\S*codex-home-/, 'the fake ran with a per-run CODEX_HOME')
      assert.equal(res.outcome.kind, 'crash')
    },
    'a crash mid-turn': async () => assert.equal((await codex.runOnce({ bin, prompt: 'crash', mcpConfig: MCP }).done).outcome.kind, 'crash'),
    'a kill': async () => {
      const run = codex.runOnce({ bin, prompt: 'hang', mcpConfig: MCP })
      setTimeout(() => run.close('SIGKILL'), 300)
      await run.done
    },
    'a missing binary': async () => assert.equal((await codex.runOnce({ bin: join(tmpdir(), 'no-such-codex'), prompt: BIG, mcpConfig: MCP }).done).outcome.kind, 'crash'),
    'a session that exits early': async () => {
      const s = codex.startSession({ bin, mcpConfig: MCP, env: EARLY })
      s.send(BIG)
      await once(s.events, 'exit')
    },
    'a closed session': async () => {
      const s = codex.startSession({ bin, mcpConfig: MCP })
      s.events.on('event', (ev) => ev.type === 'turn_end' && s.close('SIGTERM'))
      s.send('turn')
      await once(s.events, 'exit')
    },
  }
  for (const [title, run] of Object.entries(paths))
    test(title, async () => {
      const dir = await inTmp(run)
      for (const t0 = Date.now(); readdirSync(dir).length && Date.now() - t0 < 2000; ) await new Promise((r) => setTimeout(r, 20))
      assert.deepEqual(readdirSync(dir), [])
    })
})
