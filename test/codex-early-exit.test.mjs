// pr-95: a codex (or claude) that exits before reading its prompt used to crash the runner
// with an unhandled `write EPIPE` on its stdin, as pi did before DMN-32. The fakes here exit
// without reading stdin and the prompt is larger than the pipe buffer, so the write always
// fails: the race is hit on every run, not only on fast Linux runners.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import * as codex from '../harness/codex.mjs'
import * as claudeCode from '../harness/claude-code.mjs'
import { supervise } from '../harness/supervise.mjs'
import { runAttempt } from '../evals/lib/runner.mjs'

const tmp = () => mkdtempSync(join(tmpdir(), 'pr95-'))
const script = (name, body) => {
  const bin = join(tmp(), name)
  writeFileSync(bin, `#!/bin/sh\n${body}\n`)
  chmodSync(bin, 0o755)
  return bin
}
// Records its CODEX_HOME, then exits without reading stdin.
const fakeCodex = (dir) => script('codex', `echo "$CODEX_HOME" > "${dir}/home"; echo "codex: cannot load config" >&2; exit 3`)
const BIG = 'x'.repeat(1 << 20)
const MCP = { mcpServers: { fermi: { type: 'http', url: 'http://127.0.0.1:1/mcp' } } }

describe('codex exiting before reading its prompt is a failed run, never an uncaught exception', () => {
  test('runOnce: exit code and stderr are reported; CODEX_HOME is removed', async () => {
    const dir = tmp()
    const res = await codex.runOnce({ bin: fakeCodex(dir), prompt: BIG, mcpConfig: MCP }).done
    assert.equal(res.code, 3)
    assert.equal(res.outcome, null)
    assert.match(res.stderr, /cannot load config/)
    const home = readFileSync(join(dir, 'home'), 'utf8').trim()
    assert.match(home, /codex-home-/)
    assert.equal(existsSync(home), false, 'per-run CODEX_HOME removed')
  })

  test('startSession: the in-flight turn ends as a crash; CODEX_HOME is removed', async () => {
    const dir = tmp()
    const s = supervise(codex.startSession({ bin: fakeCodex(dir), mcpConfig: MCP }))
    const ended = new Promise((r) => s.events.on('event', (ev) => ev.type === 'turn_end' && r(ev)))
    const exited = once(s.events, 'exit')
    s.send(BIG)
    const end = await ended
    assert.equal(end.ok, false)
    await exited
    assert.equal(s.alive, false)
    assert.equal(s.send('again'), false, 'a dead session takes no turn')
    await new Promise((r) => setTimeout(r, 50)) // 'close' (the cleanup) follows 'exit'
    const home = readFileSync(join(dir, 'home'), 'utf8').trim()
    assert.equal(existsSync(home), false, 'per-session CODEX_HOME removed')
  })

  test('through the eval runner: a crash with codex stderr in stderr.log', async () => {
    const outDir = tmp()
    const bin = fakeCodex(tmp())
    const harness = { name: codex.name, runOnce: (o) => codex.runOnce({ ...o, bin }) }
    const scenario = { name: 'codex-early-exit', inbound: { channel: 'sl', sender: 'U0', chat: 'D0', text: BIG }, expect: [] }
    const r = await runAttempt({ scenario, attempt: 1, harness, timeoutMs: 10_000, outDir })
    assert.equal(r.pass, false)
    assert.ok(r.errorKinds.includes('crash'), JSON.stringify(r))
    assert.ok(!r.errorKinds.includes('timeout'), JSON.stringify(r))
    assert.match(readFileSync(join(outDir, scenario.name, '1', 'stderr.log'), 'utf8'), /cannot load config/)
  })

  test('a missing binary removes CODEX_HOME too', async () => {
    const root = tmp()
    const sandbox = { root, env: {}, wrap: (bin, args) => [bin, args] }
    const res = await codex.runOnce({ bin: join(root, 'no-such-codex'), prompt: 'x', mcpConfig: MCP, sandbox }).done
    assert.match(res.stderr, /codex adapter: .*ENOENT/)
    assert.deepEqual(readdirSync(root).filter((f) => f.startsWith('codex-home-')), [])
  })
})

describe('claude-code exiting before reading its prompt is a failed run, never an uncaught exception', () => {
  const bin = script('claude', 'echo "claude: not logged in" >&2; exit 5')

  test('runOnce', async () => {
    const res = await claudeCode.runOnce({ bin, prompt: BIG }).done
    assert.equal(res.code, 5)
    assert.equal(res.outcome, null)
    assert.match(res.stderr, /not logged in/)
  })

  test('startSession', async () => {
    const s = supervise(claudeCode.startSession({ bin }))
    const ended = new Promise((r) => s.events.on('event', (ev) => ev.type === 'turn_end' && r(ev)))
    s.send(BIG)
    const end = await ended
    assert.equal(end.ok, false)
    assert.equal(end.kind, 'crash')
  })
})
