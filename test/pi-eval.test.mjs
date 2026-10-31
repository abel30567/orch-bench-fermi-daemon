// pi adapter eval mode: HOME is a sandbox whose .pi/agent holds only the eval
// worker's mcp.json and a temporary copy of the real auth.json. Runs against
// test/conformance/fake-pi.mjs, which records what pi would load.
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ROOT } from './run-worker.mjs'
import { piMcpConfig, runOnce, startSession } from '../harness/pi.mjs'
import { runAttempt } from '../evals/lib/runner.mjs'
import { loadScenario } from '../evals/lib/scenario.mjs'
import * as fake from '../evals/harness/fake.mjs'

const tmp = () => mkdtempSync(join(tmpdir(), 'pi-eval-'))
const bin = join(tmp(), 'pi')
writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${join(ROOT, 'test/conformance/fake-pi.mjs')}" "$@"\n`)
chmodSync(bin, 0o755)

const PROD = 'https://fermi.example.com/mcp'
const EVAL = 'http://127.0.0.1:43210/mcp'
const AUTH = JSON.stringify({ anthropic: { type: 'oauth', access: 'sk-ant-oat01-fake' } })

// The owner's real HOME: an mcp.json pointing at production Fermi (unreadable,
// so any read of it fails loudly) and the auth.json pi logs in from.
let realHome, savedHome
before(() => {
  savedHome = process.env.HOME
  realHome = tmp()
  const agent = join(realHome, '.pi/agent')
  mkdirSync(agent, { recursive: true })
  writeFileSync(join(agent, 'mcp.json'), JSON.stringify({ mcpServers: { fermi: { url: PROD } } }))
  chmodSync(join(agent, 'mcp.json'), 0o000)
  writeFileSync(join(agent, 'auth.json'), AUTH)
  process.env.HOME = realHome
})
after(() => {
  chmodSync(join(realHome, '.pi/agent/mcp.json'), 0o600)
  process.env.HOME = savedHome
})

const evalOpts = (extra = {}) => {
  const dir = tmp()
  const mcpConfig = join(dir, 'mcp.json')
  writeFileSync(mcpConfig, JSON.stringify({ mcpServers: { fermi: { type: 'http', url: EVAL } } }))
  return { bin, model: 'm', cwd: dir, env: { FAKE_DIR: dir }, mcpConfig, sandboxHome: join(dir, 'home'), ...extra }
}
const seen = (o) => JSON.parse(readFileSync(join(o.cwd, 'pi-home.json'), 'utf8'))

describe('pi eval mode', () => {
  test('AC1: pi runs with HOME=<sandboxHome> and an mcp.json holding only the localhost eval worker', async () => {
    const o = evalOpts()
    const { outcome } = await runOnce({ ...o, prompt: 'turn' }).done
    assert.equal(outcome.ok, true)
    const s = seen(o)
    assert.equal(s.home, o.sandboxHome)
    assert.equal(s.agentDir, join(o.sandboxHome, '.pi/agent'))
    assert.deepEqual(JSON.parse(s.mcp), { mcpServers: { fermi: { url: EVAL } } })
    assert.ok(!JSON.stringify(s).includes(PROD), 'the real mcp.json leaked into the sandbox')
    assert.equal(s.auth, AUTH, 'pi saw the copied auth.json')
    assert.equal(existsSync(join(realHome, '.pi/agent/auth.json')), true, 'the real auth.json is untouched')
  })

  test('AC2: the sandbox auth.json is removed when the attempt ends', async () => {
    const o = evalOpts()
    await runOnce({ ...o, prompt: 'turn' }).done
    assert.equal(existsSync(join(o.sandboxHome, '.pi/agent/auth.json')), false)
    assert.equal(existsSync(join(o.sandboxHome, '.pi/agent/mcp.json')), true)

    const o2 = evalOpts()
    const s = startSession(o2)
    assert.equal(readFileSync(join(o2.sandboxHome, '.pi/agent/auth.json'), 'utf8'), AUTH)
    const exited = new Promise((r) => s.events.on('exit', r))
    s.close('SIGTERM')
    await exited
    await new Promise((r) => setTimeout(r, 50)) // 'close' follows 'exit'
    assert.equal(existsSync(join(o2.sandboxHome, '.pi/agent/auth.json')), false)
  })

  test('AC2: a session killed mid-turn also removes it', async () => {
    const o = evalOpts()
    const s = startSession(o)
    const closed = new Promise((r) => s.events.on('exit', r))
    s.send('hang')
    for (let i = 0; i < 100 && !existsSync(join(o.cwd, 'pi-home.json')); i++) await new Promise((r) => setTimeout(r, 20))
    assert.equal(seen(o).auth, AUTH)
    s.close('SIGKILL')
    await closed
    await new Promise((r) => setTimeout(r, 50))
    assert.equal(existsSync(join(o.sandboxHome, '.pi/agent/auth.json')), false)
  })

  test('AC3: a non-localhost or url-less MCP server refuses to start; nothing is spawned or copied', () => {
    for (const server of [{ type: 'http', url: PROD }, { type: 'stdio', command: 'fermi-mcp' }, { url: 'http://127.0.0.1.example.com/mcp' }]) {
      const o = evalOpts()
      writeFileSync(o.mcpConfig, JSON.stringify({ mcpServers: { local: { url: EVAL }, fermi: server } }))
      assert.throws(() => runOnce({ ...o, prompt: 'turn' }), /^Error: refusing to start: non-localhost/)
      assert.throws(() => startSession(o), /^Error: refusing to start: non-localhost/)
      assert.equal(existsSync(join(o.cwd, 'pi-home.json')), false, 'pi was spawned')
      assert.equal(existsSync(join(o.sandboxHome, '.pi/agent/auth.json')), false, 'auth.json was copied')
    }
  })

  test('mcpConfig without sandboxHome throws (pi would read the real mcp.json)', () => {
    assert.throws(() => runOnce({ ...evalOpts(), sandboxHome: undefined, prompt: 'turn' }), /^Error: mcpConfig without sandboxHome/)
  })

  test('piMcpConfig translates the runner config, keeping only url and headers', () => {
    const cfg = { mcpServers: { fermi: { type: 'http', url: EVAL, headers: { 'x-eval': '1' } }, b: { type: 'http', url: 'http://localhost:1/mcp' } } }
    const want = { mcpServers: { fermi: { url: EVAL, headers: { 'x-eval': '1' } }, b: { url: 'http://localhost:1/mcp' } } }
    assert.deepEqual(piMcpConfig(cfg), want)
    assert.deepEqual(piMcpConfig(JSON.stringify(cfg)), want)
    assert.deepEqual(piMcpConfig({ mcpServers: {} }), { mcpServers: {} })
    assert.throws(() => piMcpConfig({ mcpServers: { fermi: { url: PROD } } }), /refusing to start: non-localhost MCP server\(s\) for pi: fermi=https:\/\/fermi\.example\.com/)
  })

  test('the eval runner gives pi a temp sandboxHome and removes it after the attempt', async () => {
    let opts, existed
    const pi = {
      name: 'pi',
      runOnce(o) {
        opts = o
        existed = existsSync(o.sandboxHome)
        return fake.runOnce(o)
      },
    }
    const scenario = loadScenario(join(ROOT, 'evals/scenarios/examples/reply-contract.json'))
    const r = await runAttempt({ scenario, attempt: 1, harness: pi, timeoutMs: 10_000, outDir: tmp() })
    assert.equal(r.pass, true, JSON.stringify(r.failed))
    assert.equal(existed, true)
    assert.ok(!opts.sandboxHome.startsWith(realHome) && !opts.sandboxHome.startsWith(opts.cwd))
    assert.equal(existsSync(opts.sandboxHome), false)

    let other
    await runAttempt({ scenario, attempt: 1, harness: { ...fake, runOnce: (o) => ((other = o), fake.runOnce(o)) }, timeoutMs: 10_000, outDir: tmp() })
    assert.equal(other.sandboxHome, undefined, 'other harnesses get no sandboxHome')
  })
})
