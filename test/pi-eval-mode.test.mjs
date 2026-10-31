// pi adapter eval mode: pi only ever sees the local eval worker. The fake pi
// (conformance/fake-pi.mjs) resolves its config the way pi does and records it.
import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { piMcpConfig, runOnce, startSession } from '../harness/pi.mjs'
import { runAttempt } from '../evals/lib/runner.mjs'
import { supervise } from '../harness/supervise.mjs'

const FAKE = join(dirname(fileURLToPath(import.meta.url)), 'conformance/fake-pi.mjs')
const LOCAL = 'http://127.0.0.1:9/mcp'
const PROD = 'https://fermi.example.workers.dev/mcp'
const LOGIN = '{"anthropic":{"type":"oauth","refresh":"fake"}}'
const local = { mcpServers: { fermi: { type: 'http', url: LOCAL } } }

let root, realHome, sandboxHome, bin, probe, opts

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dmn-pi-eval-'))
  realHome = join(root, 'real')
  sandboxHome = join(root, 'sandbox')
  probe = join(root, 'probe.json')
  mkdirSync(join(realHome, '.pi/agent'), { recursive: true })
  writeFileSync(join(realHome, '.pi/agent/mcp.json'), JSON.stringify({ mcpServers: { fermi: { url: PROD } } }))
  writeFileSync(join(realHome, '.pi/agent/auth.json'), LOGIN)
  bin = join(root, 'pi')
  writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${FAKE}" "$@"\n`)
  chmodSync(bin, 0o755)
  opts = { bin, cwd: root, sandboxHome, mcpConfig: local, env: { HOME: realHome, FAKE_DIR: root, FAKE_PROBE: probe } }
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

const seen = () => JSON.parse(readFileSync(probe, 'utf8'))
const sandboxAuth = () => join(sandboxHome, '.pi/agent/auth.json')
const realFiles = () => ['mcp.json', 'auth.json'].map((f) => readFileSync(join(realHome, '.pi/agent', f), 'utf8'))

describe('piMcpConfig', () => {
  test('keeps the servers and only their url', () => {
    assert.deepEqual(piMcpConfig(local), { mcpServers: { fermi: { url: LOCAL } } })
    assert.deepEqual(piMcpConfig({ mcpServers: {} }), { mcpServers: {} })
  })

  test('reads a file path or inline JSON, the runner\'s shapes', () => {
    const file = join(root, 'runner-mcp.json')
    writeFileSync(file, JSON.stringify(local))
    assert.deepEqual(piMcpConfig(file), piMcpConfig(local))
    assert.deepEqual(piMcpConfig(JSON.stringify(local)), piMcpConfig(local))
  })

  test('refuses any non-localhost, look-alike or url-less server', () => {
    for (const s of [
      { url: PROD },
      { url: 'http://localhost.example.com/mcp' },
      { url: 'http://127.0.0.1@example.com/mcp' },
      { url: 'ftp://127.0.0.1/mcp' },
      { command: 'npx', args: ['some-mcp'] },
      null,
    ])
      assert.throws(() => piMcpConfig({ mcpServers: { fermi: { url: LOCAL }, other: s } }), /refusing to start: non-localhost/, JSON.stringify(s))
  })
})

describe('eval mode', () => {
  test('pi runs in the sandbox with only the eval worker; the real mcp.json is not read', async () => {
    const before = realFiles()
    const { outcome } = await runOnce({ ...opts, prompt: 'turn' }).done
    assert.equal(outcome.ok, true)
    const s = seen()
    assert.equal(s.home, sandboxHome)
    assert.equal(s.agentDir, join(sandboxHome, '.pi/agent'))
    assert.deepEqual(JSON.parse(s.mcp), { mcpServers: { fermi: { url: LOCAL } } })
    assert.ok(!s.mcp.includes('example'), 'nothing from the real mcp.json')
    assert.deepEqual(realFiles(), before)
  })

  test('an unreadable real mcp.json makes no difference: the adapter never opens it', async () => {
    const real = join(realHome, '.pi/agent/mcp.json')
    rmSync(real)
    mkdirSync(real) // reading this path throws EISDIR
    const { outcome } = await runOnce({ ...opts, prompt: 'turn' }).done
    assert.equal(outcome.ok, true)
    assert.equal(seen().home, sandboxHome)
  })

  test('HOME and the agent dir cannot be overridden by the caller env or the parent', async () => {
    const parent = process.env.PI_CODING_AGENT_DIR
    process.env.PI_CODING_AGENT_DIR = join(realHome, '.pi/agent')
    try {
      await runOnce({ ...opts, prompt: 'turn', env: { ...opts.env, PI_CODING_AGENT_DIR: join(realHome, '.pi/agent') } }).done
    } finally {
      if (parent === undefined) delete process.env.PI_CODING_AGENT_DIR
      else process.env.PI_CODING_AGENT_DIR = parent
    }
    assert.equal(seen().agentDir, join(sandboxHome, '.pi/agent'))
    assert.deepEqual(JSON.parse(seen().mcp), { mcpServers: { fermi: { url: LOCAL } } })
  })

  test('auth.json is there for the attempt, private, and removed after it; the real one stays', async () => {
    await runOnce({ ...opts, prompt: 'turn' }).done
    assert.equal(seen().auth, LOGIN)
    assert.equal(existsSync(sandboxAuth()), false)
    assert.equal(readFileSync(join(realHome, '.pi/agent/auth.json'), 'utf8'), LOGIN)
  })

  test('the copy is owner-only while pi runs', async () => {
    chmodSync(join(realHome, '.pi/agent/auth.json'), 0o644)
    const s = startSession(opts)
    assert.equal(statSync(sandboxAuth()).mode & 0o777, 0o600)
    s.close('SIGKILL')
    await once(s.events, 'exit')
  })

  test('auth.json is removed after a crash', async () => {
    const r = await runOnce({ ...opts, prompt: 'crash' }).done
    assert.equal(r.code, 1)
    assert.equal(existsSync(sandboxAuth()), false)
  })

  test('auth.json is removed after a session timeout', async () => {
    const s = supervise(startSession(opts), { turnTimeoutMs: 100 })
    const ended = new Promise((r) => s.events.on('event', (ev) => ev.type === 'turn_end' && r(ev)))
    const exited = once(s.events, 'exit')
    s.send('hang')
    assert.equal((await ended).kind, 'timeout')
    await exited
    assert.equal(existsSync(sandboxAuth()), false)
  })

  test('close() removes auth.json at once, even if pi ignores the signal', async () => {
    writeFileSync(bin, `#!/bin/sh\ntrap '' TERM\nread x\n`)
    const run = runOnce({ ...opts, prompt: 'x' })
    assert.equal(existsSync(sandboxAuth()), true)
    run.close('SIGTERM')
    assert.equal(existsSync(sandboxAuth()), false)
    run.close('SIGKILL')
    await run.done
  })

  test('a pi that cannot start leaves no auth.json and does not crash the runner', async () => {
    const r = await runOnce({ ...opts, bin: join(root, 'missing'), prompt: 'turn' }).done
    assert.equal(r.outcome, null)
    assert.equal(existsSync(sandboxAuth()), false)
  })

  test('no real auth.json: pi starts without one', async () => {
    rmSync(join(realHome, '.pi/agent/auth.json'))
    await runOnce({ ...opts, prompt: 'turn' }).done
    assert.equal(seen().auth, null)
  })

  test('a non-localhost MCP config refuses to start: no spawn, nothing written, no login copied', () => {
    for (const start of [startSession, runOnce])
      assert.throws(() => start({ ...opts, mcpConfig: { mcpServers: { fermi: { url: PROD } } } }), /refusing to start: non-localhost/)
    assert.equal(existsSync(probe), false)
    assert.equal(existsSync(sandboxHome), false)
  })

  test('mcpConfig without sandboxHome refuses to start', () => {
    const { sandboxHome: _, ...rest } = opts
    assert.throws(() => runOnce(rest), /mcpConfig without sandboxHome/)
    assert.equal(existsSync(probe), false)
  })

  test('sandboxHome without mcpConfig, or as the real HOME, refuses to start', () => {
    const { mcpConfig: _, ...rest } = opts
    assert.throws(() => runOnce(rest), /sandboxHome without mcpConfig/)
    const before = realFiles()
    assert.throws(() => runOnce({ ...opts, sandboxHome: `${realHome}/` }), /sandboxHome is the real HOME/)
    assert.deepEqual(realFiles(), before)
  })

  test('without the eval options nothing changes: real env, no sandbox', async () => {
    const { sandboxHome: _a, mcpConfig: _b, ...live } = opts
    await runOnce({ ...live, prompt: 'turn' }).done
    assert.equal(seen().home, realHome)
    assert.deepEqual(realFiles().length, 2)
    assert.equal(existsSync(sandboxHome), false)
  })
})

describe('eval runner', () => {
  const scenario = { name: 'one', inbound: { channel: 'sl', sender: 'U0EVALOWNER', chat: 'D0EVAL', text: 'hi', via: 'task' }, fixtures: {}, expect: [] }
  const fakeHarness = (harnessName, seenOpts, onRun = () => {}) => ({
    name: harnessName,
    runOnce(o) {
      Object.assign(seenOpts, o)
      onRun(o)
      const end = { type: 'turn_end', ok: true, kind: 'ok' }
      return { events: { on() {} }, done: Promise.resolve({ code: 0, outcome: end, events: [end] }), close() {} }
    },
  })

  test('pi gets a fresh sandboxHome outside the attempt dir, removed with the attempt', async () => {
    const o = {}
    let during
    const outDir = join(root, 'out')
    await runAttempt({ scenario, attempt: 1, harness: fakeHarness('pi', o, (x) => (during = statSync(x.sandboxHome).isDirectory())), timeoutMs: 1000, outDir })
    assert.equal(during, true)
    assert.ok(!o.sandboxHome.startsWith(outDir), 'never in the kept attempt dir')
    assert.equal(existsSync(o.sandboxHome), false)
    assert.deepEqual(readdirSync(join(outDir, 'one/1')).filter((f) => f === 'auth.json'), [])
  })

  test('the sandbox is removed when pi times out too', async () => {
    const o = {}
    const harness = fakeHarness('pi', o)
    const inner = harness.runOnce
    harness.runOnce = (x) => ({ ...inner(x), done: new Promise(() => {}) })
    const r = await runAttempt({ scenario, attempt: 1, harness, timeoutMs: 20, outDir: join(root, 'out') })
    assert.deepEqual(r.errorKinds, ['timeout'])
    assert.equal(existsSync(o.sandboxHome), false)
  })

  test('other harnesses get no sandboxHome', async () => {
    const o = {}
    await runAttempt({ scenario, attempt: 1, harness: fakeHarness('claude-code', o), timeoutMs: 1000, outDir: join(root, 'out') })
    assert.equal(o.sandboxHome, undefined)
    assert.ok(o.mcpConfig)
  })
})
