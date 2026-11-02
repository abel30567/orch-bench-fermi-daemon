// pi adapter eval mode: with mcpConfig + sandboxHome, pi runs under HOME=<sandboxHome>
// and sees only the local eval worker; the owner's ~/.pi/agent stays out of reach.
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { once } from 'node:events'
import { piMcpConfig, runOnce, startSession } from '../harness/pi.mjs'
import { runAttempt } from '../evals/lib/runner.mjs'
import * as fake from '../evals/harness/fake.mjs'

const tmp = () => mkdtempSync(join(tmpdir(), 'pi-eval-'))
const FAKE = join(dirname(fileURLToPath(import.meta.url)), 'conformance/fake-pi.mjs')
const bin = join(tmp(), 'pi')
writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${FAKE}" "$@"\n`)
chmodSync(bin, 0o755)

const PROD = 'https://fermi.example.com/mcp'
const EVAL = 'http://127.0.0.1:8799/mcp'
const AUTH = JSON.stringify({ anthropic: { type: 'oauth', access: 'real-owner-token' } })

// A stand-in for the owner's real HOME: ~/.pi/agent with a production mcp.json and an auth.json.
let realHome
let savedHome
before(() => {
  savedHome = process.env.HOME
  realHome = tmp()
  mkdirSync(join(realHome, '.pi/agent'), { recursive: true })
  writeFileSync(join(realHome, '.pi/agent/mcp.json'), JSON.stringify({ mcpServers: { fermi: { url: PROD } } }))
  writeFileSync(join(realHome, '.pi/agent/auth.json'), AUTH)
  process.env.HOME = realHome
})
after(() => {
  process.env.HOME = savedHome
})

const evalOpts = (servers = { fermi: { type: 'http', url: EVAL } }) => {
  const cwd = tmp()
  const mcpConfig = join(cwd, 'mcp.json')
  writeFileSync(mcpConfig, JSON.stringify({ mcpServers: servers }))
  return { bin, model: 'm', cwd, env: { FAKE_DIR: cwd }, mcpConfig, sandboxHome: join(tmp(), 'home') }
}

describe('piMcpConfig', () => {
  test("translates the runner's config to pi's mcp.json", () => {
    assert.deepEqual(piMcpConfig({ mcpServers: { fermi: { type: 'http', url: EVAL, headers: { a: 'b' } } } }), {
      mcpServers: { fermi: { url: EVAL, headers: { a: 'b' } } },
    })
    assert.deepEqual(piMcpConfig({ mcpServers: {} }), { mcpServers: {} })
  })

  test('throws on a non-localhost or url-less server', () => {
    assert.throws(() => piMcpConfig({ mcpServers: { fermi: { url: EVAL }, prod: { url: PROD } } }), /^Error: refusing to start: non-localhost .*prod/)
    assert.throws(() => piMcpConfig({ mcpServers: { local: { command: 'npx', args: ['x'] } } }), /^Error: refusing to start: non-localhost .*local/)
    assert.throws(() => piMcpConfig({ mcpServers: { sneaky: { url: 'http://127.0.0.1.example.com/mcp' } } }), /refusing to start: non-localhost/)
  })
})

describe('eval mode', () => {
  test('AC1: pi runs with HOME=<sandboxHome> and an mcp.json holding only the localhost eval worker', async () => {
    const o = evalOpts()
    const { outcome } = await runOnce({ ...o, prompt: 'home' }).done
    assert.equal(outcome?.ok, true)
    const seen = JSON.parse(readFileSync(join(o.cwd, 'home.json'), 'utf8'))
    assert.equal(seen.home, o.sandboxHome)
    assert.equal(seen.agentDir, join(o.sandboxHome, '.pi/agent'))
    assert.equal(seen.mcpFile, join(o.sandboxHome, '.pi/agent/mcp.json'))
    assert.deepEqual(JSON.parse(seen.mcp), { mcpServers: { fermi: { url: EVAL } } })
    assert.ok(!seen.mcp.includes(PROD), 'the real mcp.json leaked into the sandbox')
    assert.equal(seen.auth, AUTH, 'pi logs in from the copied auth.json')
  })

  test('AC1: the real mcp.json is never read', async () => {
    // Swap the real mcp.json for a directory: any read of it would throw EISDIR.
    const real = join(realHome, '.pi/agent/mcp.json')
    const saved = readFileSync(real)
    rmSync(real)
    mkdirSync(real)
    try {
      const o = evalOpts()
      const { outcome } = await runOnce({ ...o, prompt: 'home' }).done
      assert.equal(outcome?.ok, true)
      assert.deepEqual(JSON.parse(JSON.parse(readFileSync(join(o.cwd, 'home.json'), 'utf8')).mcp), { mcpServers: { fermi: { url: EVAL } } })
    } finally {
      rmSync(real, { recursive: true })
      writeFileSync(real, saved)
    }
  })

  test('AC2: the sandbox auth.json is removed when a one-shot attempt ends', async () => {
    const o = evalOpts()
    await runOnce({ ...o, prompt: 'home' }).done
    assert.equal(JSON.parse(readFileSync(join(o.cwd, 'home.json'), 'utf8')).auth, AUTH)
    assert.equal(existsSync(join(o.sandboxHome, '.pi/agent/auth.json')), false)
    assert.deepEqual(readdirSync(join(o.sandboxHome, '.pi/agent')), ['mcp.json'])
    assert.equal(readFileSync(join(realHome, '.pi/agent/auth.json'), 'utf8'), AUTH, 'the real auth.json is untouched')
  })

  test('AC2: the sandbox auth.json is removed when a session is closed', async () => {
    const o = evalOpts()
    const s = startSession(o)
    assert.equal(existsSync(join(o.sandboxHome, '.pi/agent/auth.json')), true)
    const exited = once(s.events, 'exit')
    s.close('SIGTERM')
    await exited
    assert.equal(existsSync(join(o.sandboxHome, '.pi/agent/auth.json')), false)
    assert.equal(existsSync(join(realHome, '.pi/agent/auth.json')), true)
  })

  test('AC3: a non-localhost URL in the MCP config refuses to start', () => {
    for (const servers of [{ fermi: { type: 'http', url: PROD } }, { fermi: { type: 'http', url: EVAL }, other: { url: PROD } }, { stdio: { command: 'x' } }]) {
      const o = evalOpts(servers)
      assert.throws(() => runOnce({ ...o, prompt: 'home' }), /refusing to start: non-localhost/)
      assert.throws(() => startSession(o), /refusing to start: non-localhost/)
      assert.equal(existsSync(o.sandboxHome), false, 'nothing written, no credential copied')
      assert.equal(existsSync(join(o.cwd, 'home.json')), false, 'pi never ran')
    }
  })

  test('mcpConfig without sandboxHome refuses to start', () => {
    const { sandboxHome, ...o } = evalOpts()
    assert.throws(() => runOnce({ ...o, prompt: 'home' }), /^Error: mcpConfig without sandboxHome/)
    assert.throws(() => startSession(o), /^Error: mcpConfig without sandboxHome/)
  })

  test('sandboxHome may not be the real HOME', () => {
    const o = evalOpts()
    assert.throws(() => runOnce({ ...o, sandboxHome: realHome, prompt: 'home' }), /real HOME/)
    assert.equal(readFileSync(join(realHome, '.pi/agent/auth.json'), 'utf8'), AUTH)
  })
})

describe('the eval runner gives pi a sandbox HOME', () => {
  const scenario = {
    name: 'unit',
    fixtures: { bindings: [{ channel: 'sl', sender_id: 'U0EVALOWNER' }] },
    inbound: { channel: 'sl', sender: 'U0EVALOWNER', chat: 'D0EVAL', text: 'hi' },
    expect: [],
    fake: { script: [] },
  }

  test('a temp sandboxHome for pi, removed after the attempt', async () => {
    let seen
    const pi = {
      name: 'pi',
      runOnce: (o) => {
        seen = { ...o, existed: existsSync(o.sandboxHome) }
        return fake.runOnce(o)
      },
    }
    const r = await runAttempt({ scenario, attempt: 1, harness: pi, timeoutMs: 10_000, outDir: tmp() })
    assert.equal(r.pass, true, JSON.stringify(r.failed))
    assert.equal(seen.existed, true)
    assert.notEqual(seen.sandboxHome, realHome)
    assert.equal(existsSync(seen.sandboxHome), false)
  })

  test('other harnesses get no sandboxHome', async () => {
    let seen
    const other = { name: 'claude-code', runOnce: (o) => ((seen = o), fake.runOnce(o)) }
    await runAttempt({ scenario, attempt: 1, harness: other, timeoutMs: 10_000, outDir: tmp() })
    assert.equal('sandboxHome' in seen, false)
  })
})
