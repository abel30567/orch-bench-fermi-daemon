// pi adapter eval mode: pi runs in a sandbox HOME whose mcp.json holds only the
// local eval worker; the real ~/.pi/agent/mcp.json is never used, and the
// auth.json copy is removed when the attempt ends. Runs against the fake pi.
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ROOT } from './run-worker.mjs'
import * as pi from '../harness/pi.mjs'
import { runAttempt } from '../evals/lib/runner.mjs'
import * as fake from '../evals/harness/fake.mjs'

const tmp = () => mkdtempSync(join(tmpdir(), 'pi-eval-'))
const bin = join(tmp(), 'pi')
writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${join(ROOT, 'test/conformance/fake-pi.mjs')}" "$@"\n`)
chmodSync(bin, 0o755)

const EVAL = { mcpServers: { fermi: { type: 'http', url: 'http://127.0.0.1:4321/mcp' } } }
const PROD = 'https://fermi.example.com/mcp'
const AUTH = JSON.stringify({ anthropic: { type: 'oauth', access: 'sk-ant-oat-real', refresh: 'r', expires: 1 } })

// A stand-in for the owner's real HOME: an mcp.json pointing at production Fermi, and a pi login.
let realHome, savedHome
before(() => {
  savedHome = process.env.HOME
  realHome = tmp()
  mkdirSync(join(realHome, '.pi/agent'), { recursive: true })
  writeFileSync(join(realHome, '.pi/agent/mcp.json'), JSON.stringify({ mcpServers: { fermi: { url: PROD } } }))
  writeFileSync(join(realHome, '.pi/agent/auth.json'), AUTH)
  process.env.HOME = realHome
})
after(() => (process.env.HOME = savedHome))

const evalRun = (extra = {}) => {
  const dir = tmp()
  const mcpConfig = join(dir, 'mcp.json')
  writeFileSync(mcpConfig, JSON.stringify(EVAL))
  const sandboxHome = join(dir, 'home')
  mkdirSync(sandboxHome)
  return { dir, sandboxHome, opts: { bin, cwd: dir, env: { FAKE_DIR: dir }, mcpConfig, sandboxHome, prompt: 'pi-env', ...extra } }
}

describe('AC1: eval mode runs pi with HOME=<sandboxHome> and only the eval worker', () => {
  test('HOME, PI_CODING_AGENT_DIR and mcp.json are the sandbox\'s; the real mcp.json is untouched', async () => {
    const { dir, sandboxHome, opts } = evalRun()
    const r = await pi.runOnce(opts).done
    assert.equal(r.outcome?.ok, true, r.stderr)
    const seen = JSON.parse(readFileSync(join(dir, 'pi-env.json'), 'utf8'))
    assert.equal(seen.HOME, sandboxHome)
    assert.equal(seen.PI_CODING_AGENT_DIR, join(sandboxHome, '.pi/agent'))
    assert.deepEqual(JSON.parse(seen.mcp), { mcpServers: { fermi: { url: 'http://127.0.0.1:4321/mcp' } } })
    assert.ok(!JSON.stringify(seen).includes(PROD))
    assert.equal(seen.auth, AUTH, 'pi can log in from the copied auth.json')
    assert.equal(readFileSync(join(realHome, '.pi/agent/auth.json'), 'utf8'), AUTH, 'the real login stays')
  })

  test('the real mcp.json is never read: an unreadable one changes nothing', async (t) => {
    if (process.getuid?.() === 0) return t.skip('root reads mode-000 files')
    const realMcp = join(realHome, '.pi/agent/mcp.json')
    chmodSync(realMcp, 0o000)
    try {
      const { dir, opts } = evalRun()
      const r = await pi.runOnce(opts).done
      assert.equal(r.outcome?.ok, true, r.stderr)
      assert.ok(existsSync(join(dir, 'pi-env.json')))
    } finally {
      chmodSync(realMcp, 0o644)
    }
  })

  test('mcpConfig without sandboxHome is refused', () => {
    assert.throws(() => pi.runOnce({ bin, mcpConfig: EVAL, prompt: 'turn' }), /^Error: mcpConfig without sandboxHome/)
  })

  test('piMcpConfig translates the runner config to pi\'s mcp.json', () => {
    assert.deepEqual(pi.piMcpConfig(EVAL), { mcpServers: { fermi: { url: 'http://127.0.0.1:4321/mcp' } } })
    assert.deepEqual(pi.piMcpConfig({ mcpServers: { a: { url: 'http://localhost:1/mcp', headers: { 'x-k': 'v' } } } }), {
      mcpServers: { a: { url: 'http://localhost:1/mcp', headers: { 'x-k': 'v' } } },
    })
  })

  test('the eval runner gives pi a temp sandboxHome and removes it after the attempt', async () => {
    let seen
    const harness = { ...fake, name: 'pi', runOnce: (o) => ((seen = { ...o, existed: existsSync(o.sandboxHome) }), fake.runOnce(o)) }
    const scenario = {
      name: 'unit',
      fixtures: { bindings: [{ channel: 'sl', sender_id: 'U0EVALOWNER' }] },
      inbound: { channel: 'sl', sender: 'U0EVALOWNER', chat: 'D0EVAL', text: 'hi' },
      expect: [],
      fake: { script: [{ tool: 'task_claim', args: { limit: 1, stale_minutes: 25 } }] },
    }
    const r = await runAttempt({ scenario, attempt: 1, harness, timeoutMs: 10_000, outDir: tmp() })
    assert.equal(r.pass, true, JSON.stringify(r.failed))
    assert.ok(seen.sandboxHome && seen.existed)
    assert.notEqual(seen.sandboxHome, realHome)
    assert.ok(!existsSync(seen.sandboxHome))
    seen = null
    await runAttempt({ scenario, attempt: 1, harness: { ...harness, name: 'fake' }, timeoutMs: 10_000, outDir: tmp() })
    assert.equal(seen.sandboxHome, undefined, 'only pi gets a sandbox HOME')
  })
})

describe('AC2: the sandbox auth.json is removed after the attempt', () => {
  test('runOnce', async () => {
    const { dir, sandboxHome, opts } = evalRun()
    await pi.runOnce(opts).done
    assert.ok(JSON.parse(readFileSync(join(dir, 'pi-env.json'), 'utf8')).auth)
    assert.ok(!existsSync(join(sandboxHome, '.pi/agent/auth.json')))
    assert.ok(existsSync(join(realHome, '.pi/agent/auth.json')))
  })

  test('startSession, on close', async () => {
    const { sandboxHome, opts } = evalRun()
    const s = pi.startSession(opts)
    const auth = join(sandboxHome, '.pi/agent/auth.json')
    assert.ok(existsSync(auth))
    const exited = new Promise((r) => s.events.once('exit', r))
    s.close('SIGTERM')
    await exited
    assert.ok(!existsSync(auth))
  })
})

describe('AC3: a non-localhost URL refuses to start', () => {
  const cases = {
    'a production server': { mcpServers: { fermi: { type: 'http', url: PROD } } },
    'one remote server among local ones': { mcpServers: { ...EVAL.mcpServers, extra: { type: 'http', url: 'http://10.0.0.5/mcp' } } },
    'a url-less (stdio) server': { mcpServers: { local: { command: 'node', args: ['server.mjs'] } } },
    'a remote URL in a header': { mcpServers: { fermi: { ...EVAL.mcpServers.fermi, headers: { referer: 'https://fermi.example.com' } } } },
    'a lookalike host': { mcpServers: { fermi: { url: 'http://localhost.example.com/mcp' } } },
  }
  for (const [title, config] of Object.entries(cases)) {
    test(title, () => {
      assert.throws(() => pi.piMcpConfig(config), /^Error: refusing to start: non-localhost/)
      const { sandboxHome, opts } = evalRun({ mcpConfig: config })
      assert.throws(() => pi.runOnce(opts), /^Error: refusing to start: non-localhost/)
      assert.ok(!existsSync(join(sandboxHome, '.pi')), 'nothing is written, no credential copied')
    })
  }
})
