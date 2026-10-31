// pr-95: a codex (or claude) that exits before reading its stdin used to crash the process
// with an uncaught `write EPIPE` on the prompt write. Deterministic: the fakes never read
// stdin and the prompt is larger than the pipe buffer, so the write always fails.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import * as codex from '../harness/codex.mjs'
import * as claude from '../harness/claude-code.mjs'

const tmp = () => mkdtempSync(join(tmpdir(), 'pr95-'))
const script = (name, body) => {
  const bin = join(tmp(), name)
  writeFileSync(bin, `#!/bin/sh\n${body}\n`)
  chmodSync(bin, 0o755)
  return bin
}
const BIG = 'x'.repeat(1 << 20)
// Records its CODEX_HOME, then exits without reading stdin.
const EARLY = script('codex', 'printf %s "$CODEX_HOME" > "$FAKE_DIR/home"; echo "codex: bad config (early)" >&2; exit 3')
const homes = (dir) => readdirSync(dir).filter((f) => f.startsWith('codex-home-'))

describe('codex runOnce: an early exit is a crash turn, never an uncaught exception', () => {
  test('exits before reading stdin → turn_end { ok: false, kind: crash }, stderr captured', async () => {
    const dir = tmp()
    const res = await codex.runOnce({ bin: EARLY, prompt: BIG, env: { FAKE_DIR: dir } }).done
    assert.equal(res.code, 3)
    assert.equal(res.outcome?.type, 'turn_end')
    assert.equal(res.outcome.ok, false)
    assert.equal(res.outcome.kind, 'crash')
    assert.match(res.outcome.detail, /exited \(3\)/)
    assert.match(res.stderr, /bad config \(early\)/)
  })

  test('the per-run CODEX_HOME is removed after an early exit', async () => {
    const dir = tmp()
    const root = tmp()
    const sandbox = { root, env: { FAKE_DIR: dir }, wrap: (bin, args) => [bin, args] }
    const res = await codex.runOnce({ bin: EARLY, prompt: BIG, mcpConfig: { mcpServers: {} }, sandbox }).done
    assert.equal(res.outcome?.kind, 'crash')
    const home = readFileSync(join(dir, 'home'), 'utf8')
    assert.ok(home.startsWith(join(root, 'codex-home-')), home)
    assert.equal(existsSync(home), false)
    assert.deepEqual(homes(root), [])
  })

  test('a missing binary is a crash turn and leaves no CODEX_HOME', async () => {
    const root = tmp()
    const sandbox = { root, env: {}, wrap: (bin, args) => [bin, args] }
    const res = await codex.runOnce({ bin: join(tmp(), 'no-such-codex'), prompt: BIG, mcpConfig: { mcpServers: {} }, sandbox }).done
    assert.equal(res.outcome?.kind, 'crash')
    assert.match(res.stderr, /codex adapter: .*ENOENT/)
    assert.deepEqual(homes(root), [])
  })

  test('a codex the caller closes did not crash', async () => {
    const run = codex.runOnce({ bin: script('codex', 'cat >/dev/null; sleep 30'), prompt: 'x' })
    setTimeout(() => run.close('SIGTERM'), 100)
    const res = await run.done
    assert.equal(res.outcome, null)
  })

  test('startSession: codex exits before initialize → a dead session, no uncaught error', async () => {
    const s = codex.startSession({ bin: EARLY, env: { FAKE_DIR: tmp() } })
    const exited = once(s.events, 'exit')
    const ended = new Promise((r) => s.events.on('event', (ev) => ev.type === 'turn_end' && r(ev)))
    s.send(BIG)
    const [code] = await exited
    assert.equal(code, 3)
    const end = await ended
    assert.equal(end.ok, false)
    assert.equal(s.alive, false)
  })
})

describe('claude-code runOnce: an early exit is never an uncaught EPIPE', () => {
  test('exits before reading stdin → done resolves with its code and stderr', async () => {
    const bin = script('claude', 'echo "claude: early" >&2; exit 5')
    const res = await claude.runOnce({ bin, prompt: BIG }).done
    assert.equal(res.code, 5)
    assert.match(res.stderr, /claude: early/)
  })
})
