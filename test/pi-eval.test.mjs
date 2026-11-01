// pi adapter eval mode (harness/pi.mjs): a sandbox HOME whose mcp.json holds only
// the localhost eval worker, and an auth.json copy that is gone after the attempt.
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ROOT } from './run-worker.mjs'
import * as pi from '../harness/pi.mjs'
import { runAttempt } from '../evals/lib/runner.mjs'
import * as fake from '../evals/harness/fake.mjs'

const tmp = () => mkdtempSync(join(tmpdir(), 'pi-eval-test-'))
const EVAL = { mcpServers: { fermi: { type: 'http', url: 'http://127.0.0.1:4242/mcp' } } }
const PROD_MCP = JSON.stringify({ mcpServers: { fermi: { url: 'https://fermi.example.com/mcp' } } })
const AUTH = JSON.stringify({ anthropic: { type: 'oauth', access: 'sk-ant-oat-test', refresh: 'r' } })

let bin, realHome, savedHome
before(() => {
  bin = join(tmp(), 'pi')
  writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${join(ROOT, 'test/conformance/fake-pi.mjs')}" "$@"\n`)
  chmodSync(bin, 0o755)
  // The owner's real HOME: an mcp.json at production Fermi and a logged-in auth.json.
  realHome = tmp()
  mkdirSync(join(realHome, '.pi/agent'), { recursive: true })
  writeFileSync(join(realHome, '.pi/agent/mcp.json'), PROD_MCP)
  writeFileSync(join(realHome, '.pi/agent/auth.json'), AUTH)
  savedHome = process.env.HOME
  process.env.HOME = realHome
})
after(() => {
  process.env.HOME = savedHome
})

const evalOpts = (extra = {}) => {
  const dir = tmp()
  const sandboxHome = tmp()
  const mcpConfig = join(dir, 'mcp.json')
  writeFileSync(mcpConfig, JSON.stringify(EVAL))
  return { bin, cwd: dir, env: { FAKE_DIR: dir }, mcpConfig, sandboxHome, ...extra }
}

describe('pi eval mode', () => {
  test('pi runs with HOME=<sandboxHome>; its mcp.json holds only the localhost eval worker', async () => {
    const o = evalOpts()
    const { outcome } = await pi.runOnce({ ...o, prompt: 'pi-env' }).done
    assert.equal(outcome?.ok, true)
    const seen = JSON.parse(readFileSync(join(o.cwd, 'pi-env.json'), 'utf8'))
    const agentDir = join(o.sandboxHome, '.pi/agent')
    assert.equal(seen.HOME, o.sandboxHome)
    assert.equal(seen.PI_CODING_AGENT_DIR, agentDir)
    assert.equal(seen.agentDir, agentDir)
    assert.deepEqual(JSON.parse(seen.mcp), { mcpServers: { fermi: { url: 'http://127.0.0.1:4242/mcp' } } })
    assert.doesNotMatch(seen.mcp, /example\.com/, 'the real mcp.json was never read')
    assert.equal(seen.auth, AUTH, 'pi could log in from the sandbox auth.json')
    assert.equal(readFileSync(join(realHome, '.pi/agent/mcp.json'), 'utf8'), PROD_MCP, 'the real mcp.json is untouched')
  })

  test('the real mcp.json is never read, even by the adapter', async () => {
    const real = join(realHome, '.pi/agent/mcp.json')
    chmodSync(real, 0o000) // any read of it would throw EACCES
    try {
      const o = evalOpts()
      const { outcome } = await pi.runOnce({ ...o, prompt: 'pi-env' }).done
      assert.equal(outcome?.ok, true)
      assert.match(JSON.parse(readFileSync(join(o.cwd, 'pi-env.json'), 'utf8')).mcp, /127\.0\.0\.1:4242/)
    } finally {
      chmodSync(real, 0o600)
    }
  })

  test('the sandbox auth.json is removed after the attempt (runOnce and session)', async () => {
    const o = evalOpts()
    await pi.runOnce({ ...o, prompt: 'pi-env' }).done
    assert.equal(existsSync(join(o.sandboxHome, '.pi/agent/auth.json')), false)

    const o2 = evalOpts()
    const s = pi.startSession(o2)
    const ended = new Promise((r) => s.events.on('event', (e) => e.type === 'turn_end' && r()))
    s.send('pi-env')
    await ended
    assert.equal(existsSync(join(o2.sandboxHome, '.pi/agent/auth.json')), true, 'present while pi runs')
    const exited = once(s.events, 'exit')
    s.close('SIGTERM')
    await exited
    assert.equal(existsSync(join(o2.sandboxHome, '.pi/agent/auth.json')), false)
    assert.equal(readFileSync(join(realHome, '.pi/agent/auth.json'), 'utf8'), AUTH, 'the real auth.json stays')
  })

  test('a non-localhost or url-less MCP server refuses to start', () => {
    for (const server of [
      { type: 'http', url: 'https://fermi.example.com/mcp' },
      { type: 'http', url: 'http://127.0.0.1.example.com/mcp' },
      { type: 'http', url: 'http://127.0.0.1:1/mcp', headers: { 'x-upstream': 'https://fermi.example.com' } },
      { command: 'npx', args: ['fermi-mcp'] },
    ]) {
      const config = { mcpServers: { fermi: EVAL.mcpServers.fermi, other: server } }
      assert.throws(() => pi.piMcpConfig(config), /^Error: refusing to start: non-localhost/)
      const o = evalOpts({ mcpConfig: config })
      assert.throws(() => pi.runOnce({ ...o, prompt: 'pi-env' }), /refusing to start: non-localhost/)
      assert.equal(existsSync(join(o.sandboxHome, '.pi/agent/mcp.json')), false, 'nothing written')
      assert.equal(existsSync(join(o.sandboxHome, '.pi/agent/auth.json')), false, 'no credential copied')
      assert.equal(existsSync(join(o.cwd, 'pi-env.json')), false, 'pi never started')
    }
  })

  test('mcpConfig without sandboxHome, or sandboxHome = the real HOME, is refused', () => {
    const o = evalOpts()
    assert.throws(() => pi.startSession({ ...o, sandboxHome: undefined }), /^Error: mcpConfig without sandboxHome/)
    assert.throws(() => pi.startSession({ ...o, sandboxHome: realHome }), /refusing to start/)
  })

  test('piMcpConfig keeps url and headers only', () => {
    const headers = { authorization: 'Bearer x' }
    assert.deepEqual(pi.piMcpConfig({ mcpServers: { fermi: { type: 'http', url: 'http://localhost:9/mcp', headers } } }), {
      mcpServers: { fermi: { url: 'http://localhost:9/mcp', headers } },
    })
  })
})

describe('eval runner: pi gets a sandbox HOME', () => {
  test('sandboxHome is passed for pi, outside the attempt dir, and removed after the attempt', async () => {
    const seen = {}
    const spy = {
      name: 'pi',
      runOnce: (o) => {
        seen.sandboxHome = o.sandboxHome
        seen.existed = existsSync(o.sandboxHome)
        return fake.runOnce(o)
      },
    }
    const outDir = tmp()
    const scenario = {
      name: 'unit',
      fixtures: { bindings: [{ channel: 'sl', sender_id: 'U0EVALOWNER' }] },
      inbound: { channel: 'sl', sender: 'U0EVALOWNER', chat: 'D0EVAL', text: 'hi' },
      expect: [{ called: 'task_claim' }],
      fake: { script: [{ tool: 'task_claim', args: { limit: 1, stale_minutes: 25 } }] },
    }
    const r = await runAttempt({ scenario, attempt: 1, harness: spy, timeoutMs: 10_000, outDir })
    assert.equal(r.pass, true, JSON.stringify(r.failed))
    assert.equal(seen.existed, true)
    assert.ok(!seen.sandboxHome.startsWith(outDir))
    assert.equal(existsSync(seen.sandboxHome), false)
    rmSync(outDir, { recursive: true, force: true })
  })

  test('other harnesses get no sandboxHome', async () => {
    let got = 'unset'
    const spy = { runOnce: (o) => ((got = o.sandboxHome), fake.runOnce(o)) }
    const scenario = {
      name: 'unit',
      inbound: { channel: 'sl', sender: 'U0EVALOWNER', chat: 'D0EVAL', text: 'hi' },
      expect: [],
      fake: { script: [] },
    }
    await runAttempt({ scenario, attempt: 1, harness: spy, timeoutMs: 10_000, outDir: tmp() })
    assert.equal(got, undefined)
  })
})
