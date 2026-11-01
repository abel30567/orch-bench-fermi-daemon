// The conformance suite (./suite.mjs) for the codex adapter, against ./fake-codex.mjs,
// plus early exits: a codex that exits before reading its prompt used to crash the runner
// with an uncaught `write EPIPE` on its stdin (the bug DMN-32 fixed for pi). The fake exits
// before reading stdin (FAKE_EXIT_EARLY) and the prompt is larger than a pipe buffer, so the
// write always fails with EPIPE: the race is hit on every run, not only on fast runners.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { once } from 'node:events'
import { runConformance } from './suite.mjs'
import * as codex from '../../harness/codex.mjs'
import * as claude from '../../harness/claude-code.mjs'

const tmp = () => mkdtempSync(join(tmpdir(), 'dmn-codex-'))
const bin = join(tmp(), 'codex')
const fake = join(dirname(fileURLToPath(import.meta.url)), 'fake-codex.mjs')
writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${fake}" "$@"\n`)
chmodSync(bin, 0o755)
const sleeper = join(tmp(), 'codex') // reads its prompt, then never ends
writeFileSync(sleeper, '#!/bin/sh\ncat > /dev/null\nexec sleep 30\n')
chmodSync(sleeper, 0o755)

runConformance(() => import('../../harness/codex.mjs'), { name: 'codex', options: { bin } }, {
  expectedFail: {
    credential_isolation:
      'SWAP-GATE BLOCKER: codex reads its credential from CODEX_HOME/auth.json or OPENAI_API_KEY; no fd handoff, so the adapter refuses tokenFd (see harness/codex.mjs)',
  },
})

const BIG = 'x'.repeat(1 << 20) // larger than any pipe buffer: the write is still pending when the fake exits
const EARLY = { FAKE_EXIT_EARLY: '3' }
const codexHomes = (root) => readdirSync(root).filter((f) => f.startsWith('codex-home-'))

describe('codex exiting early is a crash turn, never an uncaught exception', () => {
  test('runOnce: codex exits non-zero before reading its prompt', async () => {
    const res = await codex.runOnce({ bin, cwd: tmp(), prompt: BIG, env: EARLY }).done
    assert.equal(res.code, 3)
    assert.equal(res.outcome?.type, 'turn_end')
    assert.equal(res.outcome.ok, false)
    assert.equal(res.outcome.kind, 'crash')
    assert.match(res.outcome.detail, /exited \(3\)/)
    assert.match(res.stderr, /exiting before reading stdin/)
    assert.equal(res.events.filter((e) => e.type === 'turn_end').length, 1)
  })

  test('startSession: codex exits before reading the first request', async () => {
    const s = codex.startSession({ bin, cwd: tmp(), env: EARLY })
    const ended = new Promise((r) => s.events.on('event', (ev) => ev.type === 'turn_end' && r(ev)))
    const exited = once(s.events, 'exit')
    assert.equal(s.send(BIG), true)
    const end = await ended
    assert.equal(end.ok, false)
    assert.equal(end.kind, 'crash')
    await exited
    assert.equal(s.alive, false)
    assert.equal(s.send('again'), false, 'a dead session takes no turn')
  })

  test('a missing binary is a crash turn too', async () => {
    const res = await codex.runOnce({ bin: join(tmp(), 'no-such-codex'), prompt: 'x' }).done
    assert.equal(res.outcome?.kind, 'crash')
    assert.match(res.stderr, /codex adapter: .*ENOENT/)
  })

  test('a codex the caller kills did not crash', async () => {
    const run = codex.runOnce({ bin: sleeper, cwd: tmp(), prompt: 'x' })
    setTimeout(() => run.close('SIGTERM'), 300)
    const res = await run.done
    assert.equal(res.outcome, null)
  })

  test('per-run CODEX_HOME is removed on every exit path', async () => {
    const root = tmp()
    const sandbox = { root, env: {}, wrap: (b, a) => [b, a] }
    const mcpConfig = { mcpServers: {} }
    const o = { bin, cwd: tmp(), mcpConfig, sandbox }
    // a normal run, a failed turn, an early exit (EPIPE on the prompt), a kill, a spawn failure
    await codex.runOnce({ ...o, prompt: 'turn' }).done
    await codex.runOnce({ ...o, prompt: 'error-auth' }).done
    const early = await codex.runOnce({ ...o, prompt: BIG, env: EARLY }).done
    assert.equal(early.outcome?.kind, 'crash')
    const home = /CODEX_HOME=(\S+)\)/.exec(early.stderr)?.[1]
    assert.ok(home && home.startsWith(root), early.stderr)
    assert.equal(existsSync(home), false)
    const killed = codex.runOnce({ ...o, bin: sleeper, prompt: 'x' })
    setTimeout(() => killed.close('SIGKILL'), 300)
    await killed.done
    await codex.runOnce({ ...o, bin: join(tmp(), 'no-such-codex'), prompt: 'x' }).done
    const s = codex.startSession({ ...o, env: EARLY })
    const crashed = new Promise((r) => s.events.on('event', (ev) => ev.type === 'turn_end' && r(ev))) // on 'close', after the cleanup
    s.send(BIG)
    assert.equal((await crashed).kind, 'crash')
    assert.deepEqual(codexHomes(root), [])
  })
})

describe('claude-code exiting early never throws an uncaught EPIPE', () => {
  const early = join(tmp(), 'claude')
  writeFileSync(early, '#!/bin/sh\necho "claude: exiting early" >&2; exit 3\n')
  chmodSync(early, 0o755)

  test('runOnce', async () => {
    const res = await claude.runOnce({ bin: early, prompt: BIG }).done
    assert.equal(res.code, 3)
    assert.match(res.stderr, /exiting early/)
  })

  test('startSession', async () => {
    const s = claude.startSession({ bin: early })
    const exited = once(s.events, 'exit')
    s.send(BIG)
    await exited
    await new Promise((r) => setTimeout(r, 50))
    assert.equal(s.alive, false)
  })
})
