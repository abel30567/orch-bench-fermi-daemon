// DMN-23: pi adapter eval mode. pi runs in a sandbox HOME whose mcp.json holds
// only the localhost eval worker; the owner's real ~/.pi/agent is never used
// except for auth.json, which is copied in and deleted when the attempt ends.
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as pi from '../harness/pi.mjs'
import { isLocalUrl } from '../evals/lib/net.mjs'
import { runAttempt } from '../evals/lib/runner.mjs'

const tmp = () => mkdtempSync(join(tmpdir(), 'dmn23-'))
const FAKE = join(dirname(fileURLToPath(import.meta.url)), 'conformance/fake-pi.mjs')
const bin = join(tmp(), 'pi')
writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${FAKE}" "$@"\n`)
chmodSync(bin, 0o755)

const PROD = { mcpServers: { fermi: { type: 'http', url: 'https://fermi.example.com/mcp' } } }
const AUTH = JSON.stringify({ anthropic: { type: 'oauth', access: 'sk-ant-oat-real', refresh: 'r', expires: 1 } })
const EVAL = (url = 'http://127.0.0.1:9/mcp') => ({ mcpServers: { fermi: { type: 'http', url } } })

// A stand-in for the owner's real HOME: production mcp.json (unreadable, so any
// read of it fails) and a logged-in auth.json. PI_CODING_AGENT_DIR points at it
// too, as an owner override would.
let realHome, saved
before(() => {
  saved = { HOME: process.env.HOME, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR }
  realHome = tmp()
  const agent = join(realHome, '.pi', 'agent')
  mkdirSync(agent, { recursive: true })
  writeFileSync(join(agent, 'mcp.json'), JSON.stringify(PROD))
  chmodSync(join(agent, 'mcp.json'), 0o000)
  writeFileSync(join(agent, 'auth.json'), AUTH)
  process.env.HOME = realHome
  process.env.PI_CODING_AGENT_DIR = agent
})
after(() => {
  chmodSync(join(realHome, '.pi', 'agent', 'mcp.json'), 0o600)
  for (const [k, v] of Object.entries(saved)) v == null ? delete process.env[k] : (process.env[k] = v)
})

const evalOpts = (extra = {}) => {
  const dir = tmp()
  const cfg = join(dir, 'mcp.json')
  writeFileSync(cfg, JSON.stringify(EVAL()))
  return { bin, model: 'm', cwd: dir, env: { FAKE_DIR: dir }, mcpConfig: cfg, sandboxHome: join(dir, 'home'), ...extra }
}
const seen = (o) => JSON.parse(readFileSync(join(o.cwd, 'agent-dir.json'), 'utf8'))
const sandboxAuth = (o) => join(o.sandboxHome, '.pi', 'agent', 'auth.json')

describe('AC1: eval mode runs pi with HOME=<sandboxHome> and only the eval worker', () => {
  test('pi sees the sandbox HOME and agent dir; its mcp.json is the localhost eval worker only', async () => {
    const o = evalOpts()
    const { done } = pi.runOnce({ ...o, prompt: 'agent-dir' })
    const { outcome } = await done
    assert.equal(outcome?.ok, true, JSON.stringify(outcome))
    const s = seen(o)
    assert.equal(s.home, o.sandboxHome)
    assert.equal(s.agentDir, join(o.sandboxHome, '.pi', 'agent'))
    const mcp = JSON.parse(s.mcp)
    assert.deepEqual(mcp, { mcpServers: { fermi: { url: 'http://127.0.0.1:9/mcp' } } })
    for (const srv of Object.values(mcp.mcpServers)) assert.ok(isLocalUrl(srv.url))
    assert.doesNotMatch(s.mcp, /fermi\.example\.com/)
    assert.equal(s.auth, AUTH, 'pi can log in from the sandbox auth.json')
  })

  test('the real mcp.json is never read (it is unreadable, and the run still succeeds)', async () => {
    assert.throws(() => readFileSync(join(realHome, '.pi', 'agent', 'mcp.json')), /EACCES/)
    const o = evalOpts()
    const { outcome } = await pi.runOnce({ ...o, prompt: 'agent-dir' }).done
    assert.equal(outcome?.ok, true)
    assert.notEqual(seen(o).agentDir, process.env.PI_CODING_AGENT_DIR)
  })

  test('piMcpConfig translates an object, JSON text or a file path', () => {
    const want = { mcpServers: { fermi: { url: 'http://localhost:1/mcp', headers: { a: 'b' } } } }
    const cfg = { mcpServers: { fermi: { type: 'http', url: 'http://localhost:1/mcp', headers: { a: 'b' } } } }
    const file = join(tmp(), 'c.json')
    writeFileSync(file, JSON.stringify(cfg))
    for (const c of [cfg, JSON.stringify(cfg), file]) assert.deepEqual(pi.piMcpConfig(c), want)
  })

  test('mcpConfig without sandboxHome refuses to start', () => {
    assert.throws(() => pi.runOnce({ ...evalOpts(), sandboxHome: undefined, prompt: 'turn' }), /mcpConfig without sandboxHome/)
  })

  test('sandboxHome equal to the real HOME refuses to start', () => {
    assert.throws(() => pi.runOnce({ ...evalOpts(), sandboxHome: realHome, prompt: 'turn' }), /sandboxHome is the real HOME/)
    assert.equal(readFileSync(join(realHome, '.pi', 'agent', 'auth.json'), 'utf8'), AUTH)
  })

  test('the eval runner gives pi a sandbox HOME holding only its local MCP proxy, and removes it', async () => {
    let opts
    const harness = {
      name: 'pi',
      runOnce: (o) => ((opts = o), pi.runOnce({ ...o, bin, prompt: 'agent-dir', env: { ...o.env, FAKE_DIR: o.cwd } })),
    }
    const s = { name: 'pi-eval', inbound: { channel: 'sl', sender: 'U0EVALOWNER', chat: 'D0EVAL', text: 'hi' }, expect: [] }
    const r = await runAttempt({ scenario: s, attempt: 1, harness, timeoutMs: 10_000, outDir: tmp() })
    assert.equal(r.pass, true, JSON.stringify(r.failed))
    assert.ok(opts.sandboxHome)
    const v = seen(opts)
    assert.equal(v.home, opts.sandboxHome)
    const urls = Object.values(JSON.parse(v.mcp).mcpServers).map((x) => x.url)
    assert.equal(urls.length, 1)
    assert.ok(isLocalUrl(urls[0]), urls[0])
    assert.equal(existsSync(opts.sandboxHome), false, 'the sandbox HOME is removed with the attempt')
  })
})

describe('AC2: the sandbox auth.json is removed after the attempt', () => {
  test('runOnce: gone once done resolves; the real auth.json is untouched', async () => {
    const o = evalOpts()
    await pi.runOnce({ ...o, prompt: 'agent-dir' }).done
    assert.equal(seen(o).auth, AUTH, 'it existed during the run')
    assert.equal(existsSync(sandboxAuth(o)), false)
    assert.equal(readFileSync(join(realHome, '.pi', 'agent', 'auth.json'), 'utf8'), AUTH)
  })

  test('startSession: gone after close, and after a crash', async () => {
    for (const end of ['close', 'crash']) {
      const o = evalOpts()
      const s = pi.startSession(o)
      assert.equal(existsSync(sandboxAuth(o)), true)
      const exited = new Promise((r) => s.events.on('exit', r))
      if (end === 'close') s.close('SIGTERM')
      else s.send('crash')
      await exited
      await new Promise((r) => setTimeout(r, 50)) // 'close' follows 'exit' once stdio drains
      assert.equal(existsSync(sandboxAuth(o)), false, end)
    }
  })
})

describe('AC3: a non-localhost MCP server refuses to start', () => {
  for (const [what, cfg] of [
    ['a production URL', PROD],
    ['a mix of local and remote', { mcpServers: { ...EVAL().mcpServers, other: { url: 'http://10.0.0.5/mcp' } } }],
    ['a url-less (stdio) server', { mcpServers: { fermi: { command: 'npx', args: ['fermi-mcp'] } } }],
  ]) {
    test(what, () => {
      assert.throws(() => pi.piMcpConfig(cfg), /refusing to start: non-localhost/)
      const o = evalOpts({ mcpConfig: JSON.stringify(cfg) })
      assert.throws(() => pi.runOnce({ ...o, prompt: 'turn' }), /refusing to start: non-localhost/)
      assert.equal(existsSync(o.sandboxHome), false, 'nothing is written, no pi is spawned')
    })
  }
})
