// The conformance suite (./suite.mjs) for the codex adapter, against ./fake-codex.mjs,
// plus early exits: a codex that exits before reading its stdin used to crash the
// caller with an unhandled `write EPIPE`. The fakes below exit without reading stdin
// and the prompt is larger than a pipe buffer, so the write always fails.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { once } from 'node:events'
import * as codex from '../../harness/codex.mjs'
import { runConformance } from './suite.mjs'

const tmp = () => mkdtempSync(join(tmpdir(), 'dmn-codex-'))
const script = (body) => {
  const bin = join(tmp(), 'codex')
  writeFileSync(bin, `#!/bin/sh\n${body}\n`)
  chmodSync(bin, 0o755)
  return bin
}
const fake = join(dirname(fileURLToPath(import.meta.url)), 'fake-codex.mjs')
const bin = script(`exec "${process.execPath}" "${fake}" "$@"`)

runConformance(() => import('../../harness/codex.mjs'), { name: 'codex', options: { bin } }, {
  expectedFail: {
    credential_isolation:
      'SWAP-GATE BLOCKER: codex reads its credential from CODEX_HOME/auth.json or OPENAI_API_KEY; no fd handoff, so the adapter refuses tokenFd (see harness/codex.mjs)',
  },
})

const BIG = 'x'.repeat(1 << 20)
// Prints its CODEX_HOME, then exits without reading stdin.
const EARLY = script('echo "codex: home=$CODEX_HOME bad config" >&2; exit 3')
const MCP = { mcpServers: { fermi: { url: 'http://127.0.0.1:1/mcp' } } }
const homeOf = (stderr) => /home=(\S+)/.exec(stderr)?.[1]

describe('codex exiting early is a crash turn, never an uncaught exception', () => {
  test('runOnce: codex exits non-zero', async () => {
    const res = await codex.runOnce({ bin: EARLY, prompt: BIG }).done
    assert.equal(res.code, 3)
    assert.equal(res.outcome?.type, 'turn_end')
    assert.equal(res.outcome.ok, false)
    assert.equal(res.outcome.kind, 'crash')
    assert.match(res.outcome.detail, /exited \(3\)/)
    assert.match(res.stderr, /bad config/)
    assert.equal(res.events.filter((e) => e.type === 'turn_end').length, 1)
  })

  test('runOnce: a missing binary is a crash turn', async () => {
    const res = await codex.runOnce({ bin: join(tmp(), 'no-such-codex'), prompt: BIG }).done
    assert.equal(res.outcome?.kind, 'crash')
    assert.match(res.stderr, /codex adapter: .*ENOENT/)
  })

  test('runOnce: a codex the caller kills did not crash', async () => {
    const run = codex.runOnce({ bin: script('echo started >&2; exec sleep 30'), prompt: 'x' })
    run.events.once('stderr', () => run.close('SIGTERM'))
    const res = await run.done
    assert.equal(res.outcome, null)
  })

  test('startSession: codex exits before initialize', async () => {
    const s = codex.startSession({ bin: EARLY })
    const ended = new Promise((r) => s.events.on('event', (ev) => ev.type === 'turn_end' && r(ev)))
    const exited = once(s.events, 'exit')
    s.send(BIG)
    const end = await ended
    assert.equal(end.ok, false)
    await exited
    await new Promise((r) => setTimeout(r, 50))
    assert.equal(s.alive, false)
    assert.equal(s.send('again'), false, 'a dead session takes no turn')
  })

  test('startSession: codex crashing mid-turn ends the turn as crash', async () => {
    const s = codex.startSession({ bin, cwd: tmp() })
    const ended = new Promise((r) => s.events.on('event', (ev) => ev.type === 'turn_end' && r(ev)))
    s.send('crash')
    const end = await ended
    assert.equal(end.ok, false)
    assert.equal(end.kind, 'crash')
  })

  test('per-run CODEX_HOME is removed on every exit path', async () => {
    // early non-zero exit
    const early = await codex.runOnce({ bin: EARLY, prompt: BIG, mcpConfig: MCP }).done
    const h1 = homeOf(early.stderr)
    assert.ok(h1, early.stderr)
    assert.equal(existsSync(h1), false)

    // a normal run and a crash mid-turn
    for (const prompt of ['turn', 'crash']) {
      const dir = tmp()
      const r = await codex.runOnce({ bin: script(`echo "home=$CODEX_HOME" >&2; exec "${process.execPath}" "${fake}" "$@"`), prompt, cwd: dir, env: { FAKE_DIR: dir }, mcpConfig: MCP }).done
      const h = homeOf(r.stderr)
      assert.ok(h, r.stderr)
      assert.equal(existsSync(h), false, prompt)
    }

    // killed by the caller
    const run = codex.runOnce({ bin: script('echo "home=$CODEX_HOME" >&2; exec sleep 30'), prompt: 'x', mcpConfig: MCP })
    let err = ''
    run.events.on('stderr', (s) => {
      err += s
      if (homeOf(err)) run.close('SIGKILL')
    })
    await run.done
    assert.ok(homeOf(err), err)
    assert.equal(existsSync(homeOf(err)), false)

    // a session that exits early
    const s = codex.startSession({ bin: EARLY, mcpConfig: MCP })
    let serr = ''
    s.events.on('stderr', (x) => (serr += x))
    s.send(BIG)
    await once(s.events, 'exit')
    await new Promise((r) => setTimeout(r, 50))
    assert.ok(homeOf(serr), serr)
    assert.equal(existsSync(homeOf(serr)), false)
  })
})
