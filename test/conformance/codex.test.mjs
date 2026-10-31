// The conformance suite (./suite.mjs) for the codex adapter, against ./fake-codex.mjs,
// then what is codex's own: its args, config.toml, exec stream and per-run CODEX_HOME.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { once } from 'node:events'
import { runConformance } from './suite.mjs'
import * as codex from '../../harness/codex.mjs'
import { supervise } from '../../harness/supervise.mjs'

const tmp = () => mkdtempSync(join(tmpdir(), 'dmn-codex-'))
const script = (body) => {
  const bin = join(tmp(), 'codex')
  writeFileSync(bin, `#!/bin/sh\n${body}\n`)
  chmodSync(bin, 0o755)
  return bin
}
const bin = script(`exec "${process.execPath}" "${join(dirname(fileURLToPath(import.meta.url)), 'fake-codex.mjs')}" "$@"`)

runConformance(() => codex, { name: 'codex', options: { bin } }, {
  expectedFail: {
    credential_isolation:
      'SWAP-GATE BLOCKER: codex takes its credential only from CODEX_HOME/auth.json (readable by its tools) or env; no fd handoff, so the adapter refuses tokenFd (see harness/codex.mjs)',
  },
})

// Exits without reading stdin, so a prompt larger than the pipe buffer always fails with EPIPE.
const BEFORE = script('echo "codex: bad config (before)" >&2; exit 3')
// Reads the first line, then exits.
const AFTER = script('read line; echo "codex: died after the prompt" >&2; exit 4')
// Exits 0 without reporting a turn.
const SILENT = script('exit 0')
const BIG = 'x'.repeat(1 << 20)
const mcpConfig = { mcpServers: {} }

describe('codex args and config', () => {
  test('sessionArgs is app-server', () => {
    assert.deepEqual(codex.sessionArgs(), ['app-server'])
  })

  test('oneShotArgs: prompt on stdin, optional flags', () => {
    assert.deepEqual(codex.oneShotArgs({}), ['exec', '--json', '--skip-git-repo-check', '-'])
    assert.deepEqual(codex.oneShotArgs({ model: 'm', skipPermissions: true }), [
      'exec', '--json', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox', '--model', 'm', '-',
    ])
  })

  test('codexConfig: localhost http servers with headers, connectors off', () => {
    const toml = codex.codexConfig({ mcpServers: { fermi: { url: 'http://127.0.0.1:1/mcp', headers: { 'X-A': 'b' } } } })
    assert.match(toml, /^\[mcp_servers\."fermi"\]$/m)
    assert.match(toml, /^http_headers = \{ "X-A" = "b" \}$/m)
    assert.match(toml, /^apps = false$/m)
  })

  test('codexConfig refuses a remote or url-less server', () => {
    assert.throws(() => codex.codexConfig({ mcpServers: { x: { url: 'https://example.com/mcp' } } }), /refusing non-localhost/)
    assert.throws(() => codex.codexConfig({ mcpServers: { x: { command: 'y' } } }), /has no url/)
  })

  test('tokenFd is refused', () => {
    assert.throws(() => codex.runOnce({ bin, prompt: 'p', tokenFd: 3 }), /unsupported option\(s\) tokenFd/)
  })
})

describe('codex exec stream', () => {
  test('a tool item seen only at completion still gets its tool_call', () => {
    const norm = codex.createExecNormalizer()
    const evs = norm.normalize({ type: 'item.completed', item: { type: 'command_execution', id: 'c', command: 'ls', status: 'completed', exit_code: 0, aggregated_output: 'out' } })
    assert.deepEqual(evs.map((e) => e.type), ['tool_call', 'tool_result'])
    assert.equal(evs[1].content, 'out')
  })

  test('turn.failed classifies its message', () => {
    const [end] = codex.createExecNormalizer().normalize({ type: 'turn.failed', error: { message: 'unexpected status 401 Unauthorized' } })
    assert.equal(end.ok, false)
    assert.equal(end.kind, 'auth')
  })

  test('runOnce: a turn is reported with its usage', async () => {
    const res = await codex.runOnce({ bin, prompt: 'turn' }).done
    assert.equal(res.code, 0, res.stderr)
    assert.equal(res.outcome.ok, true)
    assert.equal(res.events.filter((e) => e.type === 'init').length, 1)
  })
})

describe('codex exiting early is a crash turn, never an uncaught exception', () => {
  for (const [when, fake, code, msg] of [
    ['before reading stdin', BEFORE, 3, /bad config \(before\)/],
    ['after reading stdin', AFTER, 4, /died after the prompt/],
  ]) {
    test(`runOnce: codex exits non-zero ${when}`, async () => {
      const res = await codex.runOnce({ bin: fake, prompt: BIG }).done
      assert.equal(res.code, code)
      assert.equal(res.outcome?.type, 'turn_end')
      assert.equal(res.outcome.ok, false)
      assert.equal(res.outcome.kind, 'crash')
      assert.match(res.outcome.detail, new RegExp(`exited \\(${code}\\)`))
      assert.equal(res.events.filter((e) => e.type === 'turn_end').length, 1)
      assert.match(res.stderr, msg)
    })

    test(`startSession: codex exits ${when}`, async () => {
      const s = codex.startSession({ bin: fake })
      const ended = new Promise((r) => s.events.on('event', (ev) => ev.type === 'turn_end' && r(ev)))
      const exited = once(s.events, 'exit')
      let stderr = ''
      s.events.on('stderr', (d) => (stderr += d))
      assert.equal(s.send(BIG), true)
      const end = await ended
      assert.equal(end.ok, false)
      assert.equal(end.kind, 'crash')
      await exited
      assert.match(stderr, msg)
      assert.equal(s.alive, false)
      assert.equal(s.send('again'), false, 'a dead session takes no turn')
    })
  }

  test('runOnce: exiting 0 without a turn is a crash too', async () => {
    const res = await codex.runOnce({ bin: SILENT, prompt: BIG }).done
    assert.equal(res.code, 0)
    assert.equal(res.outcome?.kind, 'crash')
  })

  test('a reported failure keeps its own kind', async () => {
    const res = await codex.runOnce({ bin, prompt: 'error-auth' }).done
    assert.equal(res.code, 1)
    assert.equal(res.outcome.ok, false)
    assert.equal(res.outcome.kind, 'auth')
  })

  test('a missing binary is a crash turn too', async () => {
    const res = await codex.runOnce({ bin: join(tmp(), 'no-such-codex'), prompt: 'x' }).done
    assert.equal(res.outcome?.kind, 'crash')
    assert.match(res.stderr, /codex adapter: .*ENOENT/)
  })

  test('a session whose binary is missing is dead, and says why', async () => {
    const s = codex.startSession({ bin: join(tmp(), 'no-such-codex') })
    let stderr = ''
    s.events.on('stderr', (d) => (stderr += d))
    await once(s.events, 'exit')
    assert.match(stderr, /codex adapter: .*ENOENT/)
    assert.equal(s.alive, false)
    assert.equal(s.send('x'), false)
  })

  test('supervised: one turn_end, the supervisor\'s crash', async () => {
    const s = supervise(codex.startSession({ bin: BEFORE }))
    const ends = []
    s.events.on('event', (ev) => ev.type === 'turn_end' && ends.push(ev))
    s.send(BIG)
    await once(s.events, 'exit')
    await new Promise((r) => setTimeout(r, 100)) // the adapter's own 'close' comes after 'exit'
    assert.deepEqual(ends.map((e) => e.kind), ['crash'])
  })

  test('a codex the caller kills did not crash', async () => {
    const run = codex.runOnce({ bin: script('read line; sleep 30'), prompt: 'x\n' })
    setTimeout(() => run.close('SIGTERM'), 100)
    const res = await run.done
    assert.equal(res.outcome, null)
  })

  test('a session the caller closes reports no crash', async () => {
    const s = codex.startSession({ bin: script('sleep 30') })
    const ends = []
    s.events.on('event', (ev) => ev.type === 'turn_end' && ends.push(ev))
    s.send('x')
    const exited = once(s.events, 'exit')
    s.close('SIGTERM')
    await exited
    await new Promise((r) => setTimeout(r, 100))
    assert.deepEqual(ends, [])
  })
})

describe('per-run CODEX_HOME', () => {
  const homes = (root) => readdirSync(root).filter((f) => f.startsWith('codex-home-'))
  // A sandbox stand-in: the home is made under `root`, so a leftover can be seen.
  const inRoot = (root) => ({ root, env: {}, wrap: (b, a) => [b, a] })

  test('per-run CODEX_HOME is removed on every exit path', async () => {
    for (const [path, run] of [
      ['clean exit', (root) => codex.runOnce({ bin, prompt: 'turn', mcpConfig, sandbox: inRoot(root) })],
      ['exit before reading stdin', (root) => codex.runOnce({ bin: BEFORE, prompt: BIG, mcpConfig, sandbox: inRoot(root) })],
      ['exit after reading stdin', (root) => codex.runOnce({ bin: AFTER, prompt: BIG, mcpConfig, sandbox: inRoot(root) })],
      ['spawn failure', (root) => codex.runOnce({ bin: join(root, 'no-such-codex'), prompt: 'x', mcpConfig, sandbox: inRoot(root) })],
      ['killed', (root) => {
        const r = codex.runOnce({ bin: script('read line; sleep 30'), prompt: 'x\n', mcpConfig, sandbox: inRoot(root) })
        setTimeout(() => r.close('SIGKILL'), 100)
        return r
      }],
    ]) {
      const root = tmp()
      await run(root).done
      assert.deepEqual(homes(root), [], path)
    }
  })

  test('a session\'s CODEX_HOME is removed when codex dies before reading stdin', async () => {
    const root = tmp()
    const s = codex.startSession({ bin: BEFORE, mcpConfig, sandbox: inRoot(root) })
    const ended = new Promise((r) => s.events.on('event', (ev) => ev.type === 'turn_end' && r(ev)))
    s.send(BIG)
    assert.equal((await ended).kind, 'crash')
    assert.deepEqual(homes(root), [])
  })

  test('removed when the auth file cannot be copied, before any spawn', () => {
    const root = tmp()
    assert.throws(() => codex.runOnce({ bin, prompt: 'p', mcpConfig, authFile: join(root, 'missing.json'), sandbox: inRoot(root) }), /ENOENT/)
    assert.deepEqual(homes(root), [])
    assert.equal(existsSync(join(root, 'missing.json')), false)
  })
})
