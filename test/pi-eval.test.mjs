// pi adapter eval mode: mcpConfig + sandboxHome run pi in a throwaway HOME that
// sees only the local eval worker (harness/pi.mjs), against the conformance fake pi.
import { test, describe, after } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ROOT } from './run-worker.mjs'
import * as pi from '../harness/pi.mjs'
import { runAttempt } from '../evals/lib/runner.mjs'

const tmp = () => mkdtempSync(join(tmpdir(), 'pi-eval-'))
const bin = join(tmp(), 'pi')
writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${join(ROOT, 'test/conformance/fake-pi.mjs')}" "$@"\n`)
chmodSync(bin, 0o755)

// The owner's real HOME: an agent dir whose mcp.json points at production Fermi.
// It is made unreadable, so any read of it (by the adapter or pi) would fail.
const REAL_HOME = tmp()
const REAL_AGENT = join(REAL_HOME, '.pi', 'agent')
const REAL_MCP = join(REAL_AGENT, 'mcp.json')
const AUTH = '{"anthropic":{"type":"oauth","access":"sk-ant-oat-fake"}}'
mkdirSync(REAL_AGENT, { recursive: true })
writeFileSync(REAL_MCP, JSON.stringify({ mcpServers: { fermi: { url: 'https://fermi.example.workers.dev/mcp' } } }))
chmodSync(REAL_MCP, 0o000)
writeFileSync(join(REAL_AGENT, 'auth.json'), AUTH)
const savedHome = process.env.HOME
process.env.HOME = REAL_HOME
delete process.env.PI_CODING_AGENT_DIR
after(() => {
  process.env.HOME = savedHome
  chmodSync(REAL_MCP, 0o600)
})

const LOCAL = 'http://127.0.0.1:8787/mcp'
const config = (servers) => {
  const f = join(tmp(), 'mcp.json')
  writeFileSync(f, JSON.stringify({ mcpServers: servers }))
  return f
}
const evalOpts = (extra = {}) => {
  const fakeDir = tmp()
  return { bin, prompt: 'sandbox', cwd: fakeDir, env: { FAKE_DIR: fakeDir }, mcpConfig: config({ fermi: { type: 'http', url: LOCAL } }), sandboxHome: tmp(), ...extra }
}
const piEnv = (o) => JSON.parse(readFileSync(join(o.env.FAKE_DIR, 'pi-env.json'), 'utf8'))

describe('piMcpConfig', () => {
  test('translates Claude Code mcpServers to pi mcp.json', () => {
    const c = { mcpServers: { fermi: { type: 'http', url: LOCAL, headers: { authorization: 'Bearer x' } }, b: { type: 'http', url: 'http://localhost:1/mcp' } } }
    const want = { mcpServers: { fermi: { url: LOCAL, headers: { authorization: 'Bearer x' } }, b: { url: 'http://localhost:1/mcp' } } }
    assert.deepEqual(pi.piMcpConfig(c), want)
    assert.deepEqual(pi.piMcpConfig(JSON.stringify(c)), want)
    const f = config(c.mcpServers)
    assert.deepEqual(pi.piMcpConfig(f), want)
  })
  test('a non-localhost or url-less server is refused', () => {
    assert.throws(() => pi.piMcpConfig({ mcpServers: { fermi: { url: 'https://fermi.example.workers.dev/mcp' } } }), /refusing to start: non-localhost.*fermi=https:\/\/fermi\.example/)
    assert.throws(() => pi.piMcpConfig({ mcpServers: { x: { command: 'npx', args: ['mcp-remote'] } } }), /refusing to start: non-localhost.*x=\(no url\)/)
    assert.throws(() => pi.piMcpConfig({ mcpServers: { x: { url: 'http://127.0.0.1.evil.com/mcp' } } }), /refusing to start: non-localhost/)
  })
})

describe('AC1: eval mode runs pi in the sandbox HOME with only the eval worker', () => {
  test('HOME, agent dir, mcp.json; the real mcp.json is never read', async () => {
    const o = evalOpts()
    const { outcome } = await pi.runOnce(o).done
    assert.equal(outcome?.ok, true)
    const seen = piEnv(o)
    assert.equal(seen.HOME, o.sandboxHome)
    assert.equal(seen.PI_CODING_AGENT_DIR, join(o.sandboxHome, '.pi', 'agent'))
    assert.deepEqual(JSON.parse(seen.mcp), { mcpServers: { fermi: { url: LOCAL } } })
    assert.doesNotMatch(seen.mcp, /workers\.dev/)
    assert.equal(seen.auth, AUTH, 'pi can log in from the copied auth.json')
  })
  test('the sandbox overrides HOME and PI_CODING_AGENT_DIR from opts.env', async () => {
    const o = evalOpts()
    o.env = { ...o.env, HOME: REAL_HOME, PI_CODING_AGENT_DIR: REAL_AGENT }
    await pi.runOnce(o).done
    assert.equal(piEnv(o).HOME, o.sandboxHome)
    assert.equal(piEnv(o).PI_CODING_AGENT_DIR, join(o.sandboxHome, '.pi', 'agent'))
  })
  test('mcpConfig without sandboxHome is refused', () => {
    assert.throws(() => pi.runOnce(evalOpts({ sandboxHome: undefined })), /mcpConfig without sandboxHome/)
    assert.throws(() => pi.startSession(evalOpts({ sandboxHome: undefined })), /mcpConfig without sandboxHome/)
  })
})

describe('AC2: the sandbox auth.json is removed after the attempt', () => {
  test('runOnce', async () => {
    const o = evalOpts()
    await pi.runOnce(o).done
    assert.equal(existsSync(join(o.sandboxHome, '.pi/agent/auth.json')), false)
    assert.equal(readFileSync(join(REAL_AGENT, 'auth.json'), 'utf8'), AUTH, 'the real auth.json is untouched')
  })
  test('startSession, closed mid-session', async () => {
    const o = evalOpts()
    const s = pi.startSession(o)
    const auth = join(o.sandboxHome, '.pi/agent/auth.json')
    assert.equal(readFileSync(auth, 'utf8'), AUTH)
    const exited = new Promise((r) => s.events.on('exit', r))
    s.close('SIGTERM')
    await exited
    assert.equal(existsSync(auth), false)
  })
})

describe('AC3: a non-localhost MCP URL refuses to start', () => {
  for (const [label, server] of [
    ['remote url', { type: 'http', url: 'https://fermi.example.workers.dev/mcp' }],
    ['no url', { command: 'npx', args: ['mcp-remote', 'https://fermi.example.workers.dev/mcp'] }],
  ])
    test(label, () => {
      const o = evalOpts({ mcpConfig: config({ fermi: { type: 'http', url: LOCAL }, prod: server }) })
      assert.throws(() => pi.runOnce(o), /refusing to start: non-localhost/)
      assert.throws(() => pi.startSession(o), /refusing to start: non-localhost/)
      assert.equal(existsSync(join(o.sandboxHome, '.pi')), false, 'nothing written, pi not started')
      assert.equal(existsSync(join(o.env.FAKE_DIR, 'pi-env.json')), false)
    })
})

test('the eval runner gives pi a throwaway sandbox HOME with the proxy as its only server', async () => {
  const fakeDir = tmp()
  let opts
  const harness = { ...pi, runOnce: (o) => pi.runOnce((opts = { ...o, bin, prompt: 'sandbox', env: { ...o.env, FAKE_DIR: fakeDir } })) }
  const scenario = {
    name: 'pi-sandbox',
    fixtures: { bindings: [{ channel: 'sl', sender_id: 'U0EVALOWNER' }] },
    inbound: { channel: 'sl', sender: 'U0EVALOWNER', chat: 'D0EVAL', text: 'hi' },
    expect: [],
  }
  const outDir = tmp()
  const r = await runAttempt({ scenario, attempt: 1, harness, timeoutMs: 10_000, outDir })
  assert.equal(r.pass, true, JSON.stringify(r.failed))
  assert.ok(opts.sandboxHome)
  const seen = piEnv(opts)
  assert.equal(seen.HOME, opts.sandboxHome)
  const servers = JSON.parse(seen.mcp).mcpServers
  assert.deepEqual(Object.keys(servers), ['fermi'])
  assert.match(servers.fermi.url, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/)
  assert.equal(existsSync(opts.sandboxHome), false, 'the sandbox HOME is removed with the attempt')
  rmSync(outDir, { recursive: true, force: true })
})
