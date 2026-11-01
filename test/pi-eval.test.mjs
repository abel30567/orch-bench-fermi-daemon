// pi adapter eval mode: pi runs in a sandbox HOME whose mcp.json holds only the
// localhost eval worker, never the owner's real ~/.pi/agent (production Fermi).
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { ROOT } from './run-worker.mjs'
import * as pi from '../harness/pi.mjs'
import { runAttempt } from '../evals/lib/runner.mjs'
import { loadScenario } from '../evals/lib/scenario.mjs'

const tmp = () => mkdtempSync(join(tmpdir(), 'pi-eval-'))
const readJson = (...p) => JSON.parse(readFileSync(join(...p), 'utf8'))
const LOCAL = { mcpServers: { fermi: { type: 'http', url: 'http://127.0.0.1:8787/mcp' } } }
const PROD = { mcpServers: { fermi: { url: 'https://fermi.example.com/mcp' }, playwright: { command: 'npx', args: ['@playwright/mcp'] } } }
const AUTH = '{"anthropic":{"type":"oauth","access":"sk-ant-oat-real"}}'

const bin = join(tmp(), 'pi')
writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${join(ROOT, 'test/conformance/fake-pi.mjs')}" "$@"\n`)
chmodSync(bin, 0o755)

// The owner's real HOME: production mcp.json (unreadable, so any read of it fails) and the login.
let realHome, realAgent, savedHome
before(() => {
  savedHome = process.env.HOME
  realHome = tmp()
  realAgent = join(realHome, '.pi', 'agent')
  mkdirSync(realAgent, { recursive: true })
  writeFileSync(join(realAgent, 'mcp.json'), JSON.stringify(PROD))
  chmodSync(join(realAgent, 'mcp.json'), 0o000)
  writeFileSync(join(realAgent, 'auth.json'), AUTH)
  process.env.HOME = realHome
})
after(() => {
  chmodSync(join(realAgent, 'mcp.json'), 0o600)
  process.env.HOME = savedHome
})

const evalOpts = (extra) => {
  const dir = tmp()
  const mcpConfig = join(dir, 'mcp.json')
  writeFileSync(mcpConfig, JSON.stringify(LOCAL))
  return { bin, cwd: dir, env: { FAKE_DIR: dir }, mcpConfig, sandboxHome: join(dir, 'home'), ...extra }
}

describe('pi eval mode: sandbox HOME', () => {
  test('piMcpConfig keeps only the localhost servers, in pi\'s mcp.json shape', () => {
    assert.deepEqual(pi.piMcpConfig(LOCAL), { mcpServers: { fermi: { url: 'http://127.0.0.1:8787/mcp' } } })
    assert.deepEqual(pi.piMcpConfig(JSON.stringify({ mcpServers: { f: { url: 'http://localhost:1/mcp', headers: { a: 'b' } } } })), {
      mcpServers: { f: { url: 'http://localhost:1/mcp', headers: { a: 'b' } } },
    })
    assert.deepEqual(pi.piMcpConfig({ mcpServers: {} }), { mcpServers: {} })
  })

  test('AC1: pi runs with HOME=<sandboxHome>; its mcp.json holds only the eval worker; the real one is never read', async () => {
    const o = evalOpts()
    const r = await pi.runOnce({ ...o, prompt: 'home' }).done
    assert.equal(r.outcome?.ok, true, r.stderr)
    const seen = readJson(o.cwd, 'home.json')
    assert.equal(seen.home, o.sandboxHome)
    assert.equal(seen.agentDir, join(o.sandboxHome, '.pi', 'agent'))
    assert.deepEqual(seen.mcp, { mcpServers: { fermi: { url: 'http://127.0.0.1:8787/mcp' } } })
    assert.equal(seen.auth, AUTH) // the login was copied in
    // the real config is untouched (and unreadable: a read would have thrown)
    chmodSync(join(realAgent, 'mcp.json'), 0o600)
    assert.deepEqual(readJson(realAgent, 'mcp.json'), PROD)
    chmodSync(join(realAgent, 'mcp.json'), 0o000)
  })

  test('AC2: the sandbox auth.json is removed when the attempt ends (runOnce)', async () => {
    const o = evalOpts()
    await pi.runOnce({ ...o, prompt: 'home' }).done
    assert.equal(readJson(o.cwd, 'home.json').auth, AUTH)
    assert.equal(existsSync(join(o.sandboxHome, '.pi/agent/auth.json')), false)
    assert.equal(readFileSync(join(realAgent, 'auth.json'), 'utf8'), AUTH) // the original stays
  })

  test('AC2: the sandbox auth.json is removed when the session is closed', async () => {
    const o = evalOpts()
    const s = pi.startSession(o)
    const auth = join(o.sandboxHome, '.pi/agent/auth.json')
    assert.equal(readFileSync(auth, 'utf8'), AUTH)
    const exited = once(s.events, 'exit')
    s.close('SIGTERM')
    await exited
    await new Promise((r) => setTimeout(r, 50)) // 'close' follows 'exit'
    assert.equal(existsSync(auth), false)
  })

  test('AC3: a non-localhost or url-less MCP server refuses to start; nothing is spawned or written', () => {
    for (const mcpServers of [PROD.mcpServers, { fermi: PROD.mcpServers.fermi }, { pw: PROD.mcpServers.playwright }, { f: { url: 'http://localhost.evil.com/mcp' } }]) {
      const o = evalOpts({ mcpConfig: JSON.stringify({ mcpServers: { ...LOCAL.mcpServers, ...mcpServers } }) })
      assert.throws(() => pi.runOnce({ ...o, prompt: 'home' }), /^Error: refusing to start: non-localhost/)
      assert.throws(() => pi.startSession(o), /^Error: refusing to start: non-localhost/)
      assert.equal(existsSync(o.sandboxHome), false)
    }
  })

  test('mcpConfig without sandboxHome is refused', () => {
    assert.throws(() => pi.runOnce({ ...evalOpts(), sandboxHome: undefined, prompt: 'home' }), /^Error: mcpConfig without sandboxHome/)
  })

  test('the eval runner gives pi a throwaway sandboxHome and removes it after the attempt', async () => {
    const seen = {}
    const harness = {
      name: 'pi',
      runOnce(o) {
        seen.opts = o
        return pi.runOnce({ ...o, bin, prompt: 'home', env: { ...o.env, FAKE_DIR: o.cwd } })
      },
    }
    const scenario = loadScenario(join(ROOT, 'evals/scenarios/examples/reply-contract.json'))
    const out = tmp()
    await runAttempt({ scenario, attempt: 1, harness, timeoutMs: 10_000, outDir: out })
    const home = readJson(seen.opts.cwd, 'home.json')
    assert.equal(home.home, seen.opts.sandboxHome)
    assert.notEqual(home.home, realHome)
    assert.deepEqual(Object.keys(home.mcp.mcpServers), ['fermi'])
    assert.match(home.mcp.mcpServers.fermi.url, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/)
    assert.equal(existsSync(seen.opts.sandboxHome), false)
  })
})
