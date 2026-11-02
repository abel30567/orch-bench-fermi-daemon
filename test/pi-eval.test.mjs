// pi adapter eval mode: a sandbox HOME whose .pi/agent/mcp.json holds only the
// local eval worker, so pi never sees the owner's real config (production Fermi).
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ROOT } from './run-worker.mjs'
import * as pi from '../harness/pi.mjs'
import { runAttempt } from '../evals/lib/runner.mjs'
import { loadScenario } from '../evals/lib/scenario.mjs'

const tmp = () => mkdtempSync(join(tmpdir(), 'pi-eval-'))
const FAKE = join(ROOT, 'test/conformance/fake-pi.mjs')
const bin = join(tmp(), 'pi')
writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${FAKE}" "$@"\n`)
chmodSync(bin, 0o755)

const LOCAL = 'http://127.0.0.1:8787/mcp'
const PROD = 'https://fermi.example.workers.dev/mcp'
const AUTH = '{"anthropic":{"type":"oauth","access":"sk-ant-oat-real"}}'

// The owner's real HOME: auth.json, and an mcp.json at production Fermi that is
// unreadable, so any read of it (by the adapter) fails the test.
const realHome = tmp()
const realAgent = join(realHome, '.pi/agent')
let savedHome
before(() => {
  mkdirSync(realAgent, { recursive: true })
  writeFileSync(join(realAgent, 'auth.json'), AUTH)
  writeFileSync(join(realAgent, 'mcp.json'), JSON.stringify({ mcpServers: { fermi: { url: PROD } } }))
  chmodSync(join(realAgent, 'mcp.json'), 0o000)
  savedHome = process.env.HOME
  process.env.HOME = realHome
})
after(() => {
  process.env.HOME = savedHome
  chmodSync(join(realAgent, 'mcp.json'), 0o600)
})

function evalOpts(extra = {}) {
  const dir = tmp()
  const mcpConfig = join(dir, 'mcp.json')
  writeFileSync(mcpConfig, JSON.stringify({ mcpServers: { fermi: { type: 'http', url: LOCAL } } }))
  const sandboxHome = join(dir, 'home')
  mkdirSync(sandboxHome)
  return { bin, cwd: dir, mcpConfig, sandboxHome, env: { FAKE_DIR: dir }, ...extra, dir }
}
const seen = (dir) => JSON.parse(readFileSync(join(dir, 'agent.json'), 'utf8'))

describe('pi eval mode: sandbox HOME', () => {
  test('AC1: pi runs with HOME=<sandboxHome>; its mcp.json holds only the localhost eval worker', async () => {
    const o = evalOpts()
    const r = await pi.runOnce({ ...o, prompt: 'agent-dir' }).done
    assert.equal(r.outcome?.ok, true, r.stderr)
    const s = seen(o.dir)
    assert.equal(s.home, o.sandboxHome)
    assert.equal(s.agentDir, join(o.sandboxHome, '.pi/agent'))
    assert.deepEqual(s.mcp, { mcpServers: { fermi: { url: LOCAL } } })
    assert.ok(!JSON.stringify(s).includes(PROD))
    // the copied login was there for the run
    assert.equal(s.auth, AUTH)
  })

  test('AC2: the sandbox auth.json is removed after the attempt; the real one stays', async () => {
    const o = evalOpts()
    await pi.runOnce({ ...o, prompt: 'agent-dir' }).done
    assert.equal(seen(o.dir).auth, AUTH)
    assert.ok(!existsSync(join(o.sandboxHome, '.pi/agent/auth.json')))
    assert.equal(readFileSync(join(realAgent, 'auth.json'), 'utf8'), AUTH)
  })

  test('AC2: a session removes it when closed', async () => {
    const o = evalOpts()
    const s = pi.startSession(o)
    const end = new Promise((r) => s.events.on('event', (e) => e.type === 'turn_end' && r(e)))
    s.send('agent-dir')
    await end
    assert.equal(seen(o.dir).auth, AUTH)
    const exited = new Promise((r) => s.events.on('exit', r))
    s.close('SIGTERM')
    await exited
    // cleanup runs on the child's 'close', which follows 'exit' once stdio drains
    for (let i = 0; i < 100 && existsSync(join(o.sandboxHome, '.pi/agent/auth.json')); i++) await new Promise((r) => setTimeout(r, 20))
    assert.ok(!existsSync(join(o.sandboxHome, '.pi/agent/auth.json')))
  })

  test('AC3: a non-localhost or url-less MCP server refuses to start; nothing is written or spawned', () => {
    for (const server of [{ type: 'http', url: PROD }, { type: 'http', url: 'http://10.0.0.5/mcp' }, { command: 'npx', args: ['fermi-mcp'] }]) {
      const o = evalOpts()
      const cfg = { mcpServers: { fermi: { type: 'http', url: LOCAL }, other: server } }
      assert.throws(() => pi.piMcpConfig(cfg), /^Error: refusing to start: non-localhost .*other=/)
      writeFileSync(o.mcpConfig, JSON.stringify(cfg))
      assert.throws(() => pi.runOnce({ ...o, prompt: 'agent-dir' }), /refusing to start: non-localhost/)
      assert.deepEqual(readdirSync(o.sandboxHome), [])
      assert.ok(!existsSync(join(o.dir, 'agent.json')))
    }
  })

  test('mcpConfig without sandboxHome is refused (pi would load the real mcp.json)', () => {
    const o = evalOpts({ sandboxHome: undefined })
    assert.throws(() => pi.runOnce({ ...o, prompt: 'agent-dir' }), /^Error: mcpConfig without sandboxHome/)
    assert.throws(() => pi.startSession(o), /mcpConfig without sandboxHome/)
  })

  test('piMcpConfig translates the runner config (object, JSON text or file)', () => {
    const cfg = { mcpServers: { fermi: { type: 'http', url: LOCAL, headers: { 'x-eval': '1' } } } }
    const want = { mcpServers: { fermi: { url: LOCAL, headers: { 'x-eval': '1' } } } }
    assert.deepEqual(pi.piMcpConfig(cfg), want)
    assert.deepEqual(pi.piMcpConfig(JSON.stringify(cfg)), want)
    const f = join(tmp(), 'mcp.json')
    writeFileSync(f, JSON.stringify(cfg))
    assert.deepEqual(pi.piMcpConfig(f), want)
  })

  test('the eval runner gives pi a throwaway HOME holding only its eval server, removed after the attempt', async () => {
    const dir = tmp()
    let opts
    const harness = {
      ...pi,
      runOnce: (o) => {
        opts = o
        return pi.runOnce({ ...o, bin, prompt: 'agent-dir', env: { ...o.env, FAKE_DIR: dir } })
      },
    }
    const scenario = loadScenario(join(ROOT, 'evals/scenarios/examples/reply-contract.json'))
    await runAttempt({ scenario, attempt: 1, harness, timeoutMs: 10_000, outDir: tmp() })
    const s = seen(dir)
    assert.equal(s.home, opts.sandboxHome)
    assert.deepEqual(Object.keys(s.mcp.mcpServers), ['fermi'])
    assert.match(s.mcp.mcpServers.fermi.url, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/)
    assert.equal(s.auth, AUTH)
    assert.ok(!existsSync(opts.sandboxHome))
  })
})
