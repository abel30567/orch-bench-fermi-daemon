// pr-60: the pi adapter's eval mode. pi runs with a sandbox HOME whose
// .pi/agent/mcp.json holds only the localhost eval worker; the owner's real
// ~/.pi/agent (mcp.json pointing at production) is never used.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ROOT } from './run-worker.mjs'
import * as pi from '../harness/pi.mjs'
import { runAttempt } from '../evals/lib/runner.mjs'
import { loadScenario } from '../evals/lib/scenario.mjs'

const tmp = () => mkdtempSync(join(tmpdir(), 'pr60-'))
const bin = join(tmp(), 'pi')
writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${join(ROOT, 'test/conformance/fake-pi.mjs')}" "$@"\n`)
chmodSync(bin, 0o755)

// The owner's real HOME: a login and an mcp.json pointing at production (unreadable, so any read fails).
const REAL_AUTH = '{"anthropic":{"type":"oauth","access":"fake-access-token"}}'
const realHome = tmp()
mkdirSync(join(realHome, '.pi/agent'), { recursive: true })
writeFileSync(join(realHome, '.pi/agent/auth.json'), REAL_AUTH)
const realMcp = join(realHome, '.pi/agent/mcp.json')
writeFileSync(realMcp, JSON.stringify({ mcpServers: { fermi: { url: 'https://fermi.example.workers.dev/mcp' } } }))
chmodSync(realMcp, 0o000)
process.env.HOME = realHome
delete process.env.PI_CODING_AGENT_DIR

const EVAL_URL = 'http://127.0.0.1:18001/mcp'
const evalConfig = () => {
  const f = join(tmp(), 'mcp.json')
  writeFileSync(f, JSON.stringify({ mcpServers: { fermi: { type: 'http', url: EVAL_URL } } }))
  return f
}

describe('pr-60 AC1: eval mode runs pi with HOME=<sandboxHome> and only the eval worker', () => {
  test('piMcpConfig translates the runner config to pi mcp.json', () => {
    assert.deepEqual(pi.piMcpConfig({ mcpServers: { fermi: { type: 'http', url: EVAL_URL, headers: { a: 'b' } } } }), {
      mcpServers: { fermi: { url: EVAL_URL, headers: { a: 'b' } } },
    })
    assert.deepEqual(pi.piMcpConfig(evalConfig()), { mcpServers: { fermi: { url: EVAL_URL } } })
  })

  test('pi sees HOME and PI_CODING_AGENT_DIR in the sandbox, an mcp.json with only the eval worker, and the login copy', async () => {
    const sandboxHome = tmp()
    const fakeDir = tmp()
    const run = pi.runOnce({ bin, prompt: 'home', mcpConfig: evalConfig(), sandboxHome, env: { FAKE_DIR: fakeDir } })
    const { outcome } = await run.done
    assert.equal(outcome?.ok, true)
    const seen = JSON.parse(readFileSync(join(fakeDir, 'home.json'), 'utf8'))
    assert.equal(seen.HOME, sandboxHome)
    assert.equal(seen.PI_CODING_AGENT_DIR, join(sandboxHome, '.pi/agent'))
    assert.deepEqual(seen.mcp, { mcpServers: { fermi: { url: EVAL_URL } } })
    assert.equal(seen.auth, REAL_AUTH)
    assert.deepEqual(JSON.parse(readFileSync(join(sandboxHome, '.pi/agent/mcp.json'), 'utf8')), seen.mcp)
  })

  test('mcpConfig without sandboxHome refuses to start', () => {
    assert.throws(() => pi.runOnce({ bin, prompt: 'home', mcpConfig: evalConfig() }), /mcpConfig without sandboxHome/)
  })
})

describe('pr-60 AC2: the sandbox auth.json is removed after the attempt', () => {
  test('runOnce', async () => {
    const sandboxHome = tmp()
    const run = pi.runOnce({ bin, prompt: 'home', mcpConfig: evalConfig(), sandboxHome, env: { FAKE_DIR: tmp() } })
    assert.equal(readFileSync(join(sandboxHome, '.pi/agent/auth.json'), 'utf8'), REAL_AUTH)
    await run.done
    assert.equal(existsSync(join(sandboxHome, '.pi/agent/auth.json')), false)
    assert.equal(readFileSync(join(realHome, '.pi/agent/auth.json'), 'utf8'), REAL_AUTH) // the real login is untouched
  })

  test('a killed session', async () => {
    const sandboxHome = tmp()
    const s = pi.startSession({ bin, mcpConfig: evalConfig(), sandboxHome, env: { FAKE_DIR: tmp() } })
    assert.equal(existsSync(join(sandboxHome, '.pi/agent/auth.json')), true)
    const exited = new Promise((r) => s.events.once('exit', r))
    s.close('SIGKILL')
    await exited
    await new Promise((r) => setTimeout(r, 50)) // 'close' follows 'exit'
    assert.equal(existsSync(join(sandboxHome, '.pi/agent/auth.json')), false)
  })

  test('the eval runner gives pi a temp sandboxHome with only its proxy and removes it after the attempt', async () => {
    let opts
    const fakeDir = tmp()
    const harness = {
      name: 'pi',
      runOnce: (o) => {
        opts = o
        return pi.runOnce({ ...o, bin, prompt: 'home', env: { ...o.env, FAKE_DIR: fakeDir } })
      },
    }
    const scenario = loadScenario(join(ROOT, 'evals/scenarios/control/cancelled-by-user.json'))
    await runAttempt({ scenario, attempt: 1, harness, timeoutMs: 10_000, outDir: tmp() })
    assert.ok(opts.sandboxHome, 'runner passes sandboxHome for pi')
    const seen = JSON.parse(readFileSync(join(fakeDir, 'home.json'), 'utf8'))
    assert.equal(seen.HOME, opts.sandboxHome)
    assert.deepEqual(Object.keys(seen.mcp.mcpServers), ['fermi'])
    assert.match(seen.mcp.mcpServers.fermi.url, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/)
    assert.equal(existsSync(opts.sandboxHome), false)
  })
})

describe('pr-60 AC3: a non-localhost URL in the MCP config refuses to start', () => {
  for (const [label, server] of [
    ['remote url', { type: 'http', url: 'https://fermi.example.workers.dev/mcp' }],
    ['localhost lookalike', { type: 'http', url: 'http://127.0.0.1.example.com/mcp' }],
    ['stdio server (no url)', { command: 'npx', args: ['mcp-remote', 'https://fermi.example.workers.dev/mcp'] }],
  ]) {
    test(label, () => {
      const sandboxHome = tmp()
      const mcpConfig = { mcpServers: { local: { type: 'http', url: EVAL_URL }, fermi: server } }
      assert.throws(() => pi.piMcpConfig(mcpConfig), /^Error: refusing to start: non-localhost/)
      assert.throws(() => pi.runOnce({ bin, prompt: 'home', mcpConfig, sandboxHome }), /refusing to start: non-localhost/)
      assert.equal(existsSync(join(sandboxHome, '.pi')), false, 'nothing written, no login copied')
    })
  }
})
