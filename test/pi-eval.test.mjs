// pi adapter eval mode: a sandboxed HOME whose mcp.json holds only the local eval worker.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ROOT } from './run-worker.mjs'
import { piMcpConfig, runOnce, startSession } from '../harness/pi.mjs'
import { runAttempt } from '../evals/lib/runner.mjs'
import * as fake from '../evals/harness/fake.mjs'

const tmp = () => mkdtempSync(join(tmpdir(), 'pi-eval-'))
const bin = join(tmp(), 'pi')
writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${join(ROOT, 'test/conformance/fake-pi.mjs')}" "$@"\n`)
chmodSync(bin, 0o755)

const LOCAL = 'http://127.0.0.1:43123/mcp'
const AUTH = JSON.stringify({ anthropic: { type: 'oauth', access: 'sk-ant-oat-real' } })

// A "real" HOME holding the owner's pi config: mcp.json points at production
// Fermi and is unreadable, so any attempt to read it fails loudly.
function realHome() {
  const home = tmp()
  const agent = join(home, '.pi/agent')
  mkdirSync(agent, { recursive: true })
  writeFileSync(join(agent, 'mcp.json'), JSON.stringify({ mcpServers: { fermi: { url: 'https://fermi.example.com/mcp' } } }))
  chmodSync(join(agent, 'mcp.json'), 0o000)
  writeFileSync(join(agent, 'auth.json'), AUTH)
  return home
}

function evalOpts(extra = {}) {
  const work = tmp()
  const mcpConfig = join(work, 'mcp.json')
  writeFileSync(mcpConfig, JSON.stringify({ mcpServers: { fermi: { type: 'http', url: LOCAL } } }))
  const home = realHome()
  return { home, work, sandboxHome: join(tmp(), 'home'), opts: { bin, cwd: work, mcpConfig, env: { HOME: home, FAKE_DIR: work }, ...extra } }
}

describe('piMcpConfig', () => {
  test("translates the runner's config (object, JSON text or path) to pi's mcp.json", () => {
    const cfg = { mcpServers: { fermi: { type: 'http', url: LOCAL, headers: { 'x-a': '1' } } } }
    const want = { mcpServers: { fermi: { url: LOCAL, headers: { 'x-a': '1' } } } }
    assert.deepEqual(piMcpConfig(cfg), want)
    assert.deepEqual(piMcpConfig(JSON.stringify(cfg)), want)
    const f = join(tmp(), 'mcp.json')
    writeFileSync(f, JSON.stringify(cfg))
    assert.deepEqual(piMcpConfig(f), want)
  })

  test('AC3: a non-localhost or url-less server refuses to start', () => {
    for (const s of [{ url: 'https://fermi.example.com/mcp' }, { url: 'http://10.0.0.5:8787/mcp' }, { command: 'npx', args: ['fermi'] }, { url: 'file:///x' }])
      assert.throws(() => piMcpConfig({ mcpServers: { fermi: { type: 'http', url: LOCAL }, other: s } }), /refusing to start: non-localhost/)
  })
})

describe('eval mode', () => {
  test('AC1: pi runs with HOME=<sandboxHome>; its mcp.json holds only the eval worker; the real one is never read', async () => {
    const { home, work, sandboxHome, opts } = evalOpts()
    const r = await runOnce({ ...opts, sandboxHome, prompt: 'turn' }).done
    assert.equal(r.outcome?.ok, true, r.stderr)
    const seen = JSON.parse(readFileSync(join(work, 'pi-config.json'), 'utf8'))
    assert.equal(seen.home, sandboxHome)
    assert.equal(seen.agentDir, join(sandboxHome, '.pi/agent'))
    assert.deepEqual(JSON.parse(seen.mcp), { mcpServers: { fermi: { url: LOCAL } } })
    assert.doesNotMatch(seen.mcp, /example\.com/)
    assert.equal(seen.auth, AUTH, 'pi can log in from the sandbox copy')
    // the real config is untouched (and was unreadable throughout)
    assert.equal(readFileSync(join(home, '.pi/agent/auth.json'), 'utf8'), AUTH)
  })

  test('AC2: the sandbox auth.json is removed after a one-shot attempt', async () => {
    const { sandboxHome, opts } = evalOpts()
    await runOnce({ ...opts, sandboxHome, prompt: 'turn' }).done
    assert.equal(existsSync(join(sandboxHome, '.pi/agent/auth.json')), false)
    assert.ok(existsSync(join(sandboxHome, '.pi/agent/mcp.json')))
  })

  test('AC2: the sandbox auth.json is removed when a session ends', async () => {
    const { work, sandboxHome, opts } = evalOpts()
    const s = startSession({ ...opts, sandboxHome })
    const auth = join(sandboxHome, '.pi/agent/auth.json')
    assert.ok(existsSync(auth))
    for (const t0 = Date.now(); !existsSync(join(work, 'pi-config.json')); ) {
      assert.ok(Date.now() - t0 < 5000, 'pi never started')
      await new Promise((r) => setTimeout(r, 20))
    }
    assert.equal(JSON.parse(readFileSync(join(work, 'pi-config.json'), 'utf8')).auth, AUTH)
    const exited = new Promise((r) => s.events.on('exit', r))
    s.close('SIGTERM')
    await exited
    await new Promise((r) => setImmediate(r))
    assert.equal(existsSync(auth), false)
  })

  test('AC3: a non-localhost MCP server refuses to start before pi or the credential copy', () => {
    const { work, sandboxHome, opts } = evalOpts()
    writeFileSync(opts.mcpConfig, JSON.stringify({ mcpServers: { fermi: { type: 'http', url: 'https://fermi.example.com/mcp' } } }))
    assert.throws(() => runOnce({ ...opts, sandboxHome, prompt: 'turn' }), /refusing to start: non-localhost/)
    assert.throws(() => startSession({ ...opts, sandboxHome }), /refusing to start: non-localhost/)
    assert.equal(existsSync(sandboxHome), false)
    assert.equal(existsSync(join(work, 'pi-config.json')), false)
  })

  test('mcpConfig without sandboxHome is refused', () => {
    const { opts } = evalOpts()
    assert.throws(() => runOnce({ ...opts, prompt: 'turn' }), /mcpConfig without sandboxHome/)
    assert.throws(() => startSession(opts), /mcpConfig without sandboxHome/)
  })

  test('the eval runner gives pi a temp sandboxHome and removes it after the attempt', async () => {
    let seen
    const spy = { name: 'pi', runOnce: (o) => ((seen = { ...o, existed: existsSync(o.sandboxHome) }), fake.runOnce(o)) }
    const scenario = {
      name: 'unit',
      fixtures: { bindings: [{ channel: 'sl', sender_id: 'U0EVALOWNER' }] },
      inbound: { channel: 'sl', sender: 'U0EVALOWNER', chat: 'D0EVAL', text: 'hi' },
      expect: [],
      fake: { script: [{ tool: 'task_claim', args: { limit: 1 } }] },
    }
    const r = await runAttempt({ scenario, attempt: 1, harness: spy, timeoutMs: 10_000, outDir: tmp() })
    assert.equal(r.pass, true, JSON.stringify(r.failed))
    assert.ok(seen.sandboxHome && seen.existed)
    assert.notEqual(seen.sandboxHome, process.env.HOME)
    assert.equal(existsSync(seen.sandboxHome), false)
    assert.doesNotThrow(() => piMcpConfig(seen.mcpConfig))
  })

  test('other harnesses get no sandboxHome', async () => {
    let seen
    const spy = { name: 'claude-code', runOnce: (o) => ((seen = o), fake.runOnce(o)) }
    const scenario = {
      name: 'unit',
      fixtures: { bindings: [{ channel: 'sl', sender_id: 'U0EVALOWNER' }] },
      inbound: { channel: 'sl', sender: 'U0EVALOWNER', chat: 'D0EVAL', text: 'hi' },
      expect: [],
      fake: { script: [] },
    }
    await runAttempt({ scenario, attempt: 1, harness: spy, timeoutMs: 10_000, outDir: tmp() })
    assert.equal(seen.sandboxHome, undefined)
  })
})
