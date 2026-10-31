// The conformance suite (./suite.mjs) for the codex adapter, against ./fake-codex.mjs,
// then its early exits. FAKE_EARLY_EXIT exits before stdin is read and a prompt larger than
// the pipe buffer cannot fit in it, so the write always fails with EPIPE, on any machine.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { once } from 'node:events'
import * as codex from '../../harness/codex.mjs'
import { runConformance } from './suite.mjs'

const tmp = () => mkdtempSync(join(tmpdir(), 'codex-conf-'))
const script = (body) => {
  const bin = join(tmp(), 'codex')
  writeFileSync(bin, `#!/bin/sh\n${body}\n`)
  chmodSync(bin, 0o755)
  return bin
}
const bin = script(`exec "${process.execPath}" "${join(dirname(fileURLToPath(import.meta.url)), 'fake-codex.mjs')}" "$@"`)
const BIG = 'x'.repeat(1 << 20)
const EARLY = { bin, env: { FAKE_EARLY_EXIT: '3' } }
const MSG = /died before reading stdin/
// Answers initialize and thread/start, then closes its stdin and lingers: the next write fails with EPIPE.
const AFTER_THREAD = script(`read line
echo '{"id":1,"result":{}}'
read line
read line
echo '{"id":2,"result":{"thread":{"id":"t"}}}'
echo "codex: closing stdin" >&2
exec 0<&-
sleep 0.2
exit 5`)
// A turn that has started on `s`: resolves with its turn_end.
const turnEnd = (s) => new Promise((r) => s.events.on('event', (ev) => ev.type === 'turn_end' && r(ev)))

runConformance(() => codex, { name: 'codex', options: { bin } }, {
  expectedFail: {
    credential_isolation:
      'SWAP-GATE BLOCKER: codex takes its credential only from CODEX_HOME/auth.json or OPENAI_API_KEY; no fd handoff, so the adapter refuses tokenFd (see harness/codex.mjs)',
  },
})

describe('codex exiting early is a crash turn, never an uncaught exception', () => {
  test('runOnce: codex exits non-zero', async () => {
    const res = await codex.runOnce({ ...EARLY, prompt: BIG }).done
    assert.equal(res.code, 3)
    assert.equal(res.outcome?.type, 'turn_end')
    assert.equal(res.outcome.ok, false)
    assert.equal(res.outcome.kind, 'crash')
    assert.match(res.outcome.detail, /exited \(3\)/)
    assert.equal(res.outcome, res.events.at(-1))
    assert.match(res.stderr, MSG)
  })

  test('runOnce: a turn.failed before the exit stays the outcome', async () => {
    const res = await codex.runOnce({ bin, prompt: 'error-auth' }).done
    assert.equal(res.code, 1)
    assert.equal(res.outcome.kind, 'auth')
    assert.equal(res.events.filter((e) => e.type === 'turn_end').length, 1)
  })

  test('runOnce: a missing binary is a crash turn too', async () => {
    const res = await codex.runOnce({ bin: join(tmp(), 'no-such-codex'), prompt: 'x' }).done
    assert.equal(res.outcome?.kind, 'crash')
    assert.match(res.stderr, /codex adapter: .*ENOENT/)
  })

  test('runOnce: a codex the caller kills did not crash', async () => {
    const run = codex.runOnce({ bin: script('read line; exec sleep 30'), prompt: 'x\n' })
    setTimeout(() => run.close('SIGTERM'), 100)
    const res = await run.done
    assert.equal(res.outcome, null)
  })

  test('startSession: codex exits before initialize is read', async () => {
    const s = codex.startSession(EARLY)
    const ended = turnEnd(s)
    const exited = once(s.events, 'exit')
    assert.equal(s.send(BIG), true)
    const end = await ended
    assert.equal(end.ok, false)
    assert.equal(end.kind, 'crash')
    assert.match(end.detail, /exited \(3\)/)
    await exited
    assert.equal(s.alive, false)
    assert.equal(s.send('again'), false, 'a dead session takes no turn')
  })

  test('startSession: a write to a stdin codex closed (turn/start)', async () => {
    const s = codex.startSession({ bin: AFTER_THREAD })
    let stderr = ''
    s.events.on('stderr', (d) => (stderr += d))
    const ended = turnEnd(s)
    s.send(BIG)
    const end = await ended
    assert.equal(end.ok, false)
    assert.equal(end.kind, 'crash')
    assert.match(end.detail, /exited \(5\)/)
    assert.match(stderr, /closing stdin/)
  })

  test('startSession: codex dying mid-turn ends the turn without supervise', async () => {
    const s = codex.startSession({ bin })
    const ended = turnEnd(s)
    s.send('crash')
    const end = await ended
    assert.equal(end.kind, 'crash')
    assert.match(end.detail, /exited \(1\)/)
  })

  test('startSession: a codex the caller closes did not crash', async () => {
    const s = codex.startSession({ bin })
    const ends = []
    s.events.on('event', (ev) => ev.type === 'turn_end' && ends.push(ev))
    const text = new Promise((r) => s.events.on('event', (ev) => ev.type === 'text' && r()))
    s.send('hang')
    await text
    const exited = once(s.events, 'exit')
    s.close('SIGTERM')
    await exited
    await new Promise((r) => setTimeout(r, 100))
    assert.deepEqual(ends, [])
  })
})

describe('per-run CODEX_HOME', () => {
  const homes = (root) => readdirSync(root).filter((f) => f.startsWith('codex-home-'))
  // A sandbox whose root holds the CODEX_HOME, spawning `bin` as is: the assertions need no OS sandbox.
  const opts = (root, extra) => ({ mcpConfig: { mcpServers: {} }, sandbox: { root, env: {}, wrap: (b, a) => [b, a] }, ...extra })
  const seen = (root) => assert.deepEqual(homes(root), [], 'no CODEX_HOME left behind')

  test('per-run CODEX_HOME is removed on every exit path', async () => {
    const root = tmp()
    const live = { env: { PATH: process.env.PATH } }
    await codex.runOnce(opts(root, { ...EARLY, env: { ...live.env, ...EARLY.env }, prompt: BIG })).done // early exit
    seen(root)
    await codex.runOnce(opts(root, { bin, ...live, prompt: 'turn' })).done // a clean turn
    seen(root)
    await codex.runOnce(opts(root, { bin, ...live, prompt: 'crash' })).done // a crash mid-turn
    seen(root)
    await codex.runOnce(opts(root, { bin: join(root, 'no-such-codex'), prompt: 'x' })).done // spawn failure
    seen(root)
    const run = codex.runOnce(opts(root, { bin: script('read line; exec sleep 30'), ...live, prompt: 'x\n' }))
    assert.equal(homes(root).length, 1, 'the run has its CODEX_HOME')
    run.close('SIGKILL') // killed by the caller
    await run.done
    seen(root)
    const s = codex.startSession(opts(root, { ...EARLY, env: { ...live.env, ...EARLY.env } })) // a session that dies at once
    await once(s.events, 'exit')
    await new Promise((r) => setTimeout(r, 100))
    seen(root)
  })

  test('an authFile that cannot be copied leaves no CODEX_HOME behind', () => {
    const root = tmp()
    assert.throws(() => codex.runOnce(opts(root, { bin, authFile: join(root, 'missing-auth.json'), prompt: 'x' })), /ENOENT/)
    seen(root)
  })
})
