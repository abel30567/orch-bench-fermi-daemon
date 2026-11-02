// pi adapter eval mode: pi runs in a sandbox HOME whose .pi/agent/mcp.json names
// only the localhost eval worker, never the owner's real ~/.pi/agent (production Fermi).
// Own file (own process): it points process.env.HOME at a fake "real" home.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ROOT } from './run-worker.mjs'
import * as pi from '../harness/pi.mjs'
import { runAttempt } from '../evals/lib/runner.mjs'
import { loadScenario } from '../evals/lib/scenario.mjs'

const tmp = () => mkdtempSync(join(tmpdir(), 'pi-eval-'))
const bin = join(tmp(), 'pi')
writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${join(ROOT, 'test/conformance/fake-pi.mjs')}" "$@"\n`)
chmodSync(bin, 0o755)

// The owner's real HOME: an mcp.json at production Fermi (unreadable, so any read fails) and the pi login.
const REAL = tmp()
const REAL_AGENT = join(REAL, '.pi/agent')
mkdirSync(REAL_AGENT, { recursive: true })
const REAL_MCP = { mcpServers: { fermi: { url: 'https://fermi.example.com/mcp' } } }
writeFileSync(join(REAL_AGENT, 'mcp.json'), JSON.stringify(REAL_MCP))
chmodSync(join(REAL_AGENT, 'mcp.json'), 0o000)
const AUTH = JSON.stringify({ anthropic: { type: 'oauth', access: 'real-token' } })
writeFileSync(join(REAL_AGENT, 'auth.json'), AUTH)
process.env.HOME = REAL

const EVAL_MCP = { mcpServers: { fermi: { type: 'http', url: 'http://127.0.0.1:4567/mcp' } } }

async function evalRun(mcpConfig) {
  const fakeDir = tmp()
  const sandboxHome = join(tmp(), 'home')
  const run = pi.runOnce({ bin, prompt: 'sandbox', mcpConfig, sandboxHome, cwd: fakeDir, env: { FAKE_DIR: fakeDir } })
  const res = await run.done
  return { ...res, sandboxHome, seen: JSON.parse(readFileSync(join(fakeDir, 'agent-dir.json'), 'utf8')) }
}

describe('pi eval mode', () => {
  test('piMcpConfig keeps only localhost url servers', () => {
    assert.deepEqual(pi.piMcpConfig(EVAL_MCP), { mcpServers: { fermi: { url: 'http://127.0.0.1:4567/mcp' } } })
    assert.deepEqual(pi.piMcpConfig(JSON.stringify(EVAL_MCP)), pi.piMcpConfig(EVAL_MCP))
    const file = join(tmp(), 'mcp.json')
    writeFileSync(file, JSON.stringify(EVAL_MCP))
    assert.deepEqual(pi.piMcpConfig(file), pi.piMcpConfig(EVAL_MCP))
  })

  test('AC1: pi runs with HOME=<sandboxHome> and an mcp.json of only the eval worker; the real one is never read', async () => {
    const { outcome, sandboxHome, seen } = await evalRun(EVAL_MCP)
    assert.equal(outcome?.ok, true)
    assert.equal(seen.home, sandboxHome)
    assert.equal(seen.agentDir, join(sandboxHome, '.pi/agent'))
    assert.deepEqual(seen.mcp, { mcpServers: { fermi: { url: 'http://127.0.0.1:4567/mcp' } } })
    // the real mcp.json is untouched and still unreadable: neither the adapter nor pi opened it
    if (process.getuid?.() !== 0) assert.throws(() => readFileSync(join(REAL_AGENT, 'mcp.json')), /EACCES/)
  })

  test('AC2: auth.json is copied in for the attempt and removed when it ends', async () => {
    const { sandboxHome, seen } = await evalRun(EVAL_MCP)
    assert.equal(seen.auth, AUTH)
    assert.equal(existsSync(join(sandboxHome, '.pi/agent/auth.json')), false)
    assert.equal(readFileSync(join(REAL_AGENT, 'auth.json'), 'utf8'), AUTH)
  })

  test('AC2: auth.json is removed when the attempt is killed', async () => {
    const sandboxHome = join(tmp(), 'home')
    const s = pi.startSession({ bin, mcpConfig: EVAL_MCP, sandboxHome, cwd: tmp() })
    assert.equal(existsSync(join(sandboxHome, '.pi/agent/auth.json')), true)
    const exited = new Promise((r) => s.events.once('exit', r))
    s.close('SIGKILL')
    await exited
    assert.equal(existsSync(join(sandboxHome, '.pi/agent/auth.json')), false)
  })

  test('AC3: a non-localhost or url-less MCP server refuses to start', () => {
    const sandboxHome = join(tmp(), 'home')
    for (const s of [{ url: 'https://fermi.example.com/mcp' }, { url: 'http://127.0.0.1.example.com/mcp' }, { command: 'npx', args: ['x'] }]) {
      const cfg = { mcpServers: { fermi: EVAL_MCP.mcpServers.fermi, other: s } }
      assert.throws(() => pi.piMcpConfig(cfg), /refusing to start: non-localhost/)
      assert.throws(() => pi.runOnce({ bin, prompt: 'sandbox', mcpConfig: cfg, sandboxHome }), /refusing to start: non-localhost/)
    }
    const headers = { mcpServers: { fermi: { ...EVAL_MCP.mcpServers.fermi, headers: { Referer: 'https://fermi.example.com' } } } }
    assert.throws(() => pi.piMcpConfig(headers), /refusing to start: non-localhost/)
    assert.equal(existsSync(join(sandboxHome, '.pi/agent/mcp.json')), false)
  })

  test('mcpConfig without sandboxHome refuses to start', () => {
    assert.throws(() => pi.runOnce({ bin, prompt: 'sandbox', mcpConfig: EVAL_MCP }), /mcpConfig without sandboxHome/)
    assert.throws(() => pi.runOnce({ bin, prompt: 'sandbox', mcpConfig: EVAL_MCP, sandboxHome: REAL }), /real HOME/)
  })

  test('the eval runner gives pi a throwaway sandbox HOME at the attempt\'s eval worker', async () => {
    const fakeDir = tmp()
    let opts
    const harness = {
      name: 'pi',
      runOnce: (o) => {
        opts = o
        return pi.runOnce({ ...o, bin, prompt: 'sandbox', env: { ...o.env, FAKE_DIR: fakeDir } })
      },
    }
    const out = tmp()
    const scenario = loadScenario(join(ROOT, 'evals/scenarios/examples/reply-contract.json'))
    await runAttempt({ scenario, attempt: 1, harness, timeoutMs: 10_000, outDir: out })
    const seen = JSON.parse(readFileSync(join(fakeDir, 'agent-dir.json'), 'utf8'))
    assert.equal(seen.home, opts.sandboxHome)
    assert.notEqual(seen.home, REAL)
    const attemptMcp = JSON.parse(readFileSync(join(out, 'reply-contract/1/mcp.json'), 'utf8'))
    assert.deepEqual(seen.mcp, { mcpServers: { fermi: { url: attemptMcp.mcpServers.fermi.url } } })
    assert.match(attemptMcp.mcpServers.fermi.url, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/)
    assert.equal(seen.auth, AUTH)
    assert.equal(existsSync(opts.sandboxHome), false)
  })
})
