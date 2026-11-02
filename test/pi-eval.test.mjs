// DMN-23: pi adapter eval mode. pi runs with a sandbox HOME whose mcp.json holds
// only the localhost eval worker; auth.json is copied in and removed afterwards.
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { ROOT } from './run-worker.mjs'
import { piMcpConfig, runOnce, startSession } from '../harness/pi.mjs'
import { runAttempt } from '../evals/lib/runner.mjs'
import * as fake from '../evals/harness/fake.mjs'

const tmp = () => mkdtempSync(join(tmpdir(), 'dmn23-'))
const bin = join(tmp(), 'pi')
writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${join(ROOT, 'test/conformance/fake-pi.mjs')}" "$@"\n`)
chmodSync(bin, 0o755)

const PROD = { mcpServers: { fermi: { url: 'https://fermi.example.com/mcp' }, playwright: { command: 'npx', args: ['@playwright/mcp'] } } }
const EVAL = { mcpServers: { fermi: { type: 'http', url: 'http://127.0.0.1:4321/mcp' } } }
const AUTH = JSON.stringify({ anthropic: { type: 'oauth', access: 'sk-ant-oat-real', refresh: 'r' } })

// A real $HOME whose ~/.pi/agent points at production, as the owner's does.
let realHome
let savedHome
before(() => {
  savedHome = process.env.HOME
  realHome = tmp()
  mkdirSync(join(realHome, '.pi/agent'), { recursive: true })
  writeFileSync(join(realHome, '.pi/agent/mcp.json'), JSON.stringify(PROD))
  writeFileSync(join(realHome, '.pi/agent/auth.json'), AUTH)
  process.env.HOME = realHome
})
after(() => {
  process.env.HOME = savedHome
})

const evalOpts = (extra = {}) => {
  const dir = tmp()
  const mcpConfig = join(dir, 'mcp.json')
  writeFileSync(mcpConfig, JSON.stringify(EVAL))
  return { bin, cwd: dir, env: { FAKE_DIR: dir }, mcpConfig, sandboxHome: join(dir, 'home'), ...extra }
}

describe('AC1: eval mode runs pi with HOME=<sandboxHome> and only the eval worker', () => {
  test('pi sees the sandbox HOME, a localhost-only mcp.json and a copy of auth.json; never the real mcp.json', async () => {
    const o = evalOpts()
    const { code, outcome } = await runOnce({ ...o, prompt: 'pi-home' }).done
    assert.equal(code, 0)
    assert.equal(outcome?.ok, true, JSON.stringify(outcome))
    const seen = JSON.parse(readFileSync(join(o.cwd, 'pi-home.json'), 'utf8'))
    assert.equal(seen.home, o.sandboxHome)
    assert.equal(seen.agentDir, join(o.sandboxHome, '.pi/agent'))
    assert.ok(!seen.mcpPath.startsWith(realHome), seen.mcpPath)
    assert.deepEqual(JSON.parse(seen.mcp), { mcpServers: { fermi: { url: 'http://127.0.0.1:4321/mcp' } } })
    assert.doesNotMatch(seen.mcp, /example\.com|playwright/)
    assert.equal(seen.auth, AUTH) // pi can log in
    assert.equal(readFileSync(join(realHome, '.pi/agent/mcp.json'), 'utf8'), JSON.stringify(PROD)) // untouched
  })

  test('piMcpConfig translates an object, JSON text or a file path', () => {
    const want = { mcpServers: { fermi: { url: 'http://127.0.0.1:4321/mcp' } } }
    assert.deepEqual(piMcpConfig(EVAL), want)
    assert.deepEqual(piMcpConfig(JSON.stringify(EVAL)), want)
    assert.deepEqual(piMcpConfig(evalOpts().mcpConfig), want)
    const headers = { authorization: 'Bearer eval' }
    assert.deepEqual(piMcpConfig({ mcpServers: { f: { type: 'http', url: 'http://localhost:1/mcp', headers } } }), {
      mcpServers: { f: { url: 'http://localhost:1/mcp', headers } },
    })
  })
})

describe('AC2: the sandbox auth.json is removed after the attempt', () => {
  test('runOnce: gone when done resolves; the real one stays', async () => {
    const o = evalOpts()
    await runOnce({ ...o, prompt: 'turn' }).done
    assert.equal(existsSync(join(o.sandboxHome, '.pi/agent/auth.json')), false)
    assert.ok(existsSync(join(o.sandboxHome, '.pi/agent/mcp.json')))
    assert.equal(readFileSync(join(realHome, '.pi/agent/auth.json'), 'utf8'), AUTH)
  })

  test('startSession: gone once the closed session exits', async () => {
    const o = evalOpts()
    const s = startSession({ ...o, model: 'm', systemPrompt: 'p' })
    assert.ok(existsSync(join(o.sandboxHome, '.pi/agent/auth.json')))
    const exited = once(s.events, 'exit')
    s.close('SIGTERM')
    await exited
    await new Promise((r) => setImmediate(r)) // 'close' follows 'exit'
    for (let i = 0; i < 50 && existsSync(join(o.sandboxHome, '.pi/agent/auth.json')); i++) await new Promise((r) => setTimeout(r, 20))
    assert.equal(existsSync(join(o.sandboxHome, '.pi/agent/auth.json')), false)
  })
})

describe('AC3: a non-localhost MCP config refuses to start', () => {
  for (const [what, config] of [
    ['a production URL', PROD],
    ['a remote server next to the eval one', { mcpServers: { ...EVAL.mcpServers, prod: { url: 'https://fermi.example.com/mcp' } } }],
    ['a url-less (stdio) server', { mcpServers: { playwright: { command: 'npx' } } }],
    ['a localhost look-alike', { mcpServers: { fermi: { url: 'http://localhost.example.com/mcp' } } }],
  ]) {
    test(what, () => {
      const o = evalOpts({ mcpConfig: config })
      assert.throws(() => runOnce({ ...o, prompt: 'pi-home' }), /refusing to start: non-localhost/)
      assert.throws(() => piMcpConfig(config), /refusing to start: non-localhost/)
      assert.equal(existsSync(o.sandboxHome), false) // nothing written, nothing copied
      assert.equal(existsSync(join(o.cwd, 'pi-home.json')), false) // pi never ran
    })
  }

  test('mcpConfig without sandboxHome is refused (it would leave pi on the real config)', () => {
    const o = evalOpts({ sandboxHome: undefined })
    assert.throws(() => runOnce({ ...o, prompt: 'pi-home' }), /mcpConfig without sandboxHome/)
  })
})

describe('the eval runner gives pi a temp sandbox HOME', () => {
  const scenario = {
    name: 'unit',
    fixtures: { bindings: [{ channel: 'sl', sender_id: 'U0EVALOWNER' }] },
    inbound: { channel: 'sl', sender: 'U0EVALOWNER', chat: 'D0EVAL', text: 'hi' },
    expect: [{ called: 'task_claim' }],
    fake: { script: [{ tool: 'task_claim', args: { limit: 1, stale_minutes: 25 } }] },
  }
  const attempt = (harness) => runAttempt({ scenario, attempt: 1, harness, timeoutMs: 10_000, outDir: tmp() })

  test('pi: sandboxHome is a fresh dir, removed after the attempt', async () => {
    let seen
    const r = await attempt({ name: 'pi', runOnce: (o) => ((seen = { ...o, empty: readdirSync(o.sandboxHome).length === 0 }), fake.runOnce(o)) })
    assert.equal(r.pass, true, JSON.stringify(r.failed))
    assert.equal(seen.empty, true)
    assert.notEqual(seen.sandboxHome, realHome)
    assert.equal(existsSync(seen.sandboxHome), false)
  })

  test('other harnesses get no sandboxHome', async () => {
    let seen
    await attempt({ name: 'claude-code', runOnce: (o) => ((seen = o), fake.runOnce(o)) })
    assert.equal('sandboxHome' in seen, false)
  })
})
