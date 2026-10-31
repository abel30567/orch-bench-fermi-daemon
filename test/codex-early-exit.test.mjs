// pr-95: a codex (or claude) that exits before reading its stdin used to crash the runner
// with an unhandled `write EPIPE` (the DMN-32 bug, fixed for pi). The fakes here exit
// without reading stdin and the prompt is larger than the pipe buffer, so the write always
// fails: the race CI hit on fast runners is hit on every run. An early exit is now a failed
// turn with the harness's stderr, and the per-run CODEX_HOME is removed on every path.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import * as codex from '../harness/codex.mjs'
import * as claude from '../harness/claude-code.mjs'
import { runAttempt } from '../evals/lib/runner.mjs'

const tmp = () => mkdtempSync(join(tmpdir(), 'pr95-'))
const script = (name, body) => {
  const bin = join(tmp(), name)
  writeFileSync(bin, `#!/bin/sh\n${body}\n`)
  chmodSync(bin, 0o755)
  return bin
}
// Exits without reading stdin; reports its CODEX_HOME on stderr.
const BEFORE = script('codex', 'echo "codex: cannot start (home=$CODEX_HOME)" >&2; exit 3')
// Reads part of the prompt, then exits.
const AFTER = script('codex', 'head -c 10 > /dev/null; echo "codex: died after the prompt" >&2; exit 4')
const BIG = 'x'.repeat(1 << 20)
const MCP = { mcpServers: {} }
// A pass-through sandbox: the per-run CODEX_HOME is made in `root`, so a leftover is visible.
const passSandbox = () => ({ root: tmp(), env: { PATH: process.env.PATH }, wrap: (bin, args) => [bin, args] })

describe('codex exiting early is a failed turn, never an uncaught exception', () => {
  for (const [when, bin, code, msg] of [
    ['before reading the prompt', BEFORE, 3, /cannot start/],
    ['after reading part of the prompt', AFTER, 4, /died after the prompt/],
  ]) {
    test(`runOnce: ${when}`, async () => {
      const res = await codex.runOnce({ bin, prompt: BIG, mcpConfig: MCP }).done
      assert.equal(res.code, code)
      assert.equal(res.outcome?.type, 'turn_end')
      assert.equal(res.outcome.ok, false)
      assert.equal(res.outcome.kind, 'crash')
      assert.match(res.outcome.detail, new RegExp(`exited \\(${code}\\)`))
      assert.match(res.stderr, msg)
    })

    test(`startSession: ${when}`, async () => {
      const s = codex.startSession({ bin, mcpConfig: MCP })
      const ended = new Promise((r) => s.events.on('event', (ev) => ev.type === 'turn_end' && r(ev)))
      const closed = once(s.events, 'exit')
      s.send(BIG)
      const end = await ended
      assert.equal(end.ok, false)
      await closed
      await new Promise((r) => setImmediate(r))
      assert.equal(s.alive, false)
      assert.equal(s.send('again'), false, 'a dead session takes no turn')
    })

    test(`through the eval runner: ${when}`, async () => {
      const outDir = tmp()
      const harness = { name: codex.name, runOnce: (o) => codex.runOnce({ ...o, bin }) }
      const scenario = { name: `codex-early-exit-${code}`, inbound: { channel: 'sl', sender: 'U0', chat: 'D0', text: 'hi' }, expect: [] }
      const r = await runAttempt({ scenario, attempt: 1, harness, timeoutMs: 10_000, outDir })
      assert.equal(r.pass, false)
      assert.ok(r.errorKinds.includes('crash'), JSON.stringify(r))
      assert.ok(!r.errorKinds.includes('timeout'), JSON.stringify(r))
      assert.match(readFileSync(join(outDir, scenario.name, '1', 'stderr.log'), 'utf8'), msg)
    })
  }

  test('a missing binary is a crash turn too', async () => {
    const res = await codex.runOnce({ bin: join(tmp(), 'no-such-codex'), prompt: 'x' }).done
    assert.equal(res.outcome?.kind, 'crash')
    assert.match(res.stderr, /codex adapter: .*ENOENT/)
  })

  test('a codex the caller kills did not crash', async () => {
    const run = codex.runOnce({ bin: script('codex', 'cat > /dev/null; sleep 30'), prompt: 'x' })
    setTimeout(() => run.close('SIGTERM'), 100)
    const res = await run.done
    assert.equal(res.outcome, null)
  })
})

describe('the per-run CODEX_HOME is removed on every exit path', () => {
  const paths = {
    'exit before reading stdin': { bin: BEFORE, prompt: BIG },
    'exit after reading the prompt': { bin: AFTER, prompt: BIG },
    'missing binary': { bin: join(tmp(), 'no-such-codex'), prompt: 'x' },
    'killed by the caller': { bin: script('codex', 'cat > /dev/null; sleep 30'), prompt: 'x', kill: true },
  }
  for (const [path, { bin, prompt, kill }] of Object.entries(paths)) {
    test(`runOnce: ${path}`, async () => {
      const sandbox = passSandbox()
      const run = codex.runOnce({ bin, prompt, mcpConfig: MCP, sandbox })
      if (kill) setTimeout(() => run.close('SIGTERM'), 100)
      const res = await run.done
      assert.deepEqual(readdirSync(sandbox.root), [], res.stderr)
    })
  }

  test('startSession: exit before reading stdin', async () => {
    const sandbox = passSandbox()
    const s = codex.startSession({ bin: BEFORE, mcpConfig: MCP, sandbox })
    let stderr = ''
    s.events.on('stderr', (d) => (stderr += d))
    s.send(BIG)
    await once(s.events, 'exit')
    await new Promise((r) => setTimeout(r, 50)) // 'close' follows 'exit'
    const home = /home=(\S+)\)/.exec(stderr)?.[1]
    assert.ok(home, stderr)
    assert.equal(existsSync(home), false)
    assert.deepEqual(readdirSync(sandbox.root), [])
  })
})

describe('claude-code exiting before reading stdin is never an uncaught exception', () => {
  const bin = script('claude', 'echo "claude: cannot start" >&2; exit 3')

  test('runOnce', async () => {
    const res = await claude.runOnce({ bin, prompt: BIG }).done
    assert.equal(res.code, 3)
    assert.match(res.stderr, /cannot start/)
  })

  test('startSession', async () => {
    const s = claude.startSession({ bin })
    const exited = once(s.events, 'exit')
    s.send(BIG)
    assert.deepEqual(await exited, [3])
    await new Promise((r) => setTimeout(r, 50))
    assert.equal(s.alive, false)
  })
})
