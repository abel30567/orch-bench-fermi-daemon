// pi adapter eval mode: pi runs in a sandbox HOME whose mcp.json holds only the
// localhost eval worker; the owner's real ~/.pi/agent is never read except for
// the auth.json copy, which is removed when the attempt ends.
import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ROOT } from './run-worker.mjs'
import * as pi from '../harness/pi.mjs'
import { runAttempt } from '../evals/lib/runner.mjs'
import { loadScenario } from '../evals/lib/scenario.mjs'

const FAKE = join(ROOT, 'test/conformance/fake-pi.mjs')
const PROD = 'https://fermi.example.com/mcp'
const AUTH = JSON.stringify({ anthropic: { type: 'oauth', access: 'sk-ant-oat01-eval-test' } })
const LOCAL = { mcpServers: { fermi: { type: 'http', url: 'http://127.0.0.1:4321/mcp' } } }

const dirs = []
const tmp = (p = 'dmn-pi-eval-') => {
  const d = mkdtempSync(join(tmpdir(), p))
  dirs.push(d)
  return d
}
const readJson = (...p) => JSON.parse(readFileSync(join(...p), 'utf8'))

let realHome, savedHome, savedAgentDir, bin
beforeEach(() => {
  // The owner's real HOME: a production mcp.json (unreadable, so any read throws) and a login.
  realHome = tmp('dmn-pi-realhome-')
  const agent = join(realHome, '.pi/agent')
  mkdirSync(agent, { recursive: true })
  writeFileSync(join(agent, 'mcp.json'), JSON.stringify({ mcpServers: { fermi: { url: PROD } } }))
  chmodSync(join(agent, 'mcp.json'), 0o000)
  writeFileSync(join(agent, 'auth.json'), AUTH)
  savedHome = process.env.HOME
  savedAgentDir = process.env.PI_CODING_AGENT_DIR
  process.env.HOME = realHome
  process.env.PI_CODING_AGENT_DIR = agent // even an inherited agent dir is overridden
  bin = join(tmp(), 'pi')
  writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${FAKE}" "$@"\n`, { mode: 0o755 })
})
afterEach(() => {
  process.env.HOME = savedHome
  if (savedAgentDir == null) delete process.env.PI_CODING_AGENT_DIR
  else process.env.PI_CODING_AGENT_DIR = savedAgentDir
  for (const d of dirs.splice(0)) {
    try {
      chmodSync(join(d, '.pi/agent/mcp.json'), 0o600)
    } catch {}
    rmSync(d, { recursive: true, force: true })
  }
})

describe('pi adapter eval mode', () => {
  test('piMcpConfig keeps localhost servers only', () => {
    assert.deepEqual(pi.piMcpConfig(LOCAL), { mcpServers: { fermi: { url: 'http://127.0.0.1:4321/mcp' } } })
    assert.throws(() => pi.piMcpConfig({ mcpServers: { fermi: { url: PROD } } }), /refusing to start: non-localhost/)
    assert.throws(() => pi.piMcpConfig({ mcpServers: { x: { command: 'npx', args: ['some-mcp'] } } }), /refusing to start: non-localhost/)
  })

  test('pi runs with HOME=<sandboxHome>; its mcp.json is only the eval worker; the real one is never read', async () => {
    const sandboxHome = tmp()
    const cwd = tmp()
    const cfg = join(cwd, 'mcp.json')
    writeFileSync(cfg, JSON.stringify(LOCAL))
    const { outcome } = await pi.runOnce({ bin, cwd, env: { FAKE_DIR: cwd }, mcpConfig: cfg, sandboxHome, prompt: 'turn' }).done
    assert.equal(outcome.ok, true)
    const seen = readJson(cwd, 'startup.json')
    assert.equal(seen.home, sandboxHome)
    assert.equal(seen.agentDirEnv, join(sandboxHome, '.pi/agent'))
    assert.deepEqual(JSON.parse(seen.mcp), { mcpServers: { fermi: { url: 'http://127.0.0.1:4321/mcp' } } })
    assert.ok(!seen.mcp.includes('fermi.example.com'))
    assert.equal(seen.auth, AUTH, 'pi can log in from the sandbox copy')
  })

  test('the sandbox auth.json is removed after the attempt', async () => {
    const sandboxHome = tmp()
    const cwd = tmp()
    const auth = join(sandboxHome, '.pi/agent/auth.json')
    await pi.runOnce({ bin, cwd, env: { FAKE_DIR: cwd }, mcpConfig: LOCAL, sandboxHome, prompt: 'turn' }).done
    assert.equal(readJson(cwd, 'startup.json').auth, AUTH)
    assert.equal(existsSync(auth), false)
    assert.equal(existsSync(join(realHome, '.pi/agent/auth.json')), true, 'the real login is untouched')

    // A session killed mid-turn (an eval timeout) also loses its copy.
    const s = pi.startSession({ bin, cwd, env: { FAKE_DIR: cwd }, mcpConfig: LOCAL, sandboxHome })
    s.send('hang')
    for (const t0 = Date.now(); !existsSync(join(cwd, 'startup.json')) && Date.now() - t0 < 5000; ) await new Promise((r) => setTimeout(r, 20))
    assert.equal(existsSync(auth), true)
    const exited = new Promise((r) => s.events.on('exit', r))
    s.close('SIGTERM')
    await exited
    assert.equal(existsSync(auth), false)
  })

  test('a non-localhost or url-less MCP server refuses to start', () => {
    for (const server of [{ type: 'http', url: PROD }, { command: 'npx' }, { url: 'http://127.0.0.1.example.com/mcp' }]) {
      const sandboxHome = tmp()
      const cwd = tmp()
      const mcpConfig = { mcpServers: { eval: LOCAL.mcpServers.fermi, other: server } }
      assert.throws(() => pi.startSession({ bin, cwd, env: { FAKE_DIR: cwd }, mcpConfig, sandboxHome }), /refusing to start: non-localhost/)
      assert.throws(() => pi.runOnce({ bin, cwd, env: { FAKE_DIR: cwd }, mcpConfig, sandboxHome, prompt: 'turn' }), /refusing to start: non-localhost/)
      assert.equal(existsSync(join(cwd, 'startup.json')), false, 'pi was not spawned')
      assert.deepEqual(readdirSync(sandboxHome), [], 'nothing written to the sandbox')
    }
  })

  test('mcpConfig without sandboxHome is refused', () => {
    const cwd = tmp()
    assert.throws(() => pi.startSession({ bin, cwd, env: { FAKE_DIR: cwd }, mcpConfig: LOCAL }), /mcpConfig without sandboxHome/)
    assert.equal(existsSync(join(cwd, 'startup.json')), false)
  })

  test('the eval runner gives pi a sandbox HOME and removes it after the attempt', async () => {
    const seen = {}
    const spy = {
      ...pi,
      runOnce: (o) => {
        seen.opts = o
        return pi.runOnce({ ...o, bin, env: { ...o.env, FAKE_DIR: o.cwd }, prompt: 'turn' })
      },
    }
    const scenario = loadScenario(join(ROOT, 'evals/scenarios/core/bootstrap-each-task.json'))
    const out = tmp()
    await runAttempt({ scenario, attempt: 1, harness: spy, timeoutMs: 10_000, outDir: out })
    const { sandboxHome, cwd } = seen.opts
    assert.ok(sandboxHome, 'runner passed sandboxHome')
    assert.notEqual(sandboxHome, realHome)
    const startup = readJson(cwd, 'startup.json')
    assert.equal(startup.home, sandboxHome)
    const servers = Object.values(JSON.parse(startup.mcp).mcpServers)
    assert.equal(servers.length, 1)
    assert.match(servers[0].url, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/)
    assert.equal(existsSync(sandboxHome), false, 'the sandbox HOME (and its auth.json) is gone')
  })
})
