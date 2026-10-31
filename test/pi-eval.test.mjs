// pr-60: pi adapter eval mode. pi runs with a sandbox HOME whose mcp.json holds
// only the localhost eval server; the real ~/.pi/agent is never used.
import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ROOT } from './run-worker.mjs'
import { piMcpConfig, runOnce, startSession } from '../harness/pi.mjs'
import { runAttempt } from '../evals/lib/runner.mjs'
import { loadScenario } from '../evals/lib/scenario.mjs'
import * as fake from '../evals/harness/fake.mjs'

const FAKE = join(ROOT, 'test/fixtures/fake-pi-eval.mjs')
const tmp = () => mkdtempSync(join(tmpdir(), 'pr60-'))
const EVAL_URL = 'http://127.0.0.1:18005/mcp'
const SCENARIO = join(ROOT, 'evals/scenarios/examples/reply-contract.json')
const PROD = { mcpServers: { fermi: { url: 'https://fermi.example.workers.dev/mcp' } } }

let realHome, savedHome, bin, out
beforeEach(() => {
  // A stand-in for the owner's HOME: a production mcp.json (unreadable, so any read
  // of it fails loudly) and a logged-in auth.json.
  realHome = tmp()
  const agent = join(realHome, '.pi', 'agent')
  mkdirSync(agent, { recursive: true })
  writeFileSync(join(agent, 'mcp.json'), JSON.stringify(PROD))
  chmodSync(join(agent, 'mcp.json'), 0o000)
  writeFileSync(join(agent, 'auth.json'), '{"anthropic":{"type":"oauth","access":"fake-token"}}')
  savedHome = process.env.HOME
  process.env.HOME = realHome
  const dir = tmp()
  bin = join(dir, 'pi')
  writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${FAKE}" "$@"\n`)
  chmodSync(bin, 0o755)
  out = join(dir, 'seen.json')
})
afterEach(() => {
  process.env.HOME = savedHome
})

const evalOpts = (extra = {}) => {
  const cwd = tmp()
  const mcpConfig = join(cwd, 'mcp.json')
  writeFileSync(mcpConfig, JSON.stringify({ mcpServers: { fermi: { type: 'http', url: EVAL_URL } } }))
  return { bin, cwd, mcpConfig, sandboxHome: tmp(), env: { FAKE_PI_OUT: out }, ...extra }
}
const seen = () => JSON.parse(readFileSync(out, 'utf8'))

describe('pr-60 AC1: eval mode runs pi with HOME=<sandboxHome> and only the localhost eval server', () => {
  test('HOME and PI_CODING_AGENT_DIR point into the sandbox; mcp.json holds only the eval worker', async () => {
    const o = evalOpts()
    const r = await runOnce({ ...o, prompt: 'drain' }).done
    assert.equal(r.outcome?.ok, true, r.stderr)
    const s = seen()
    assert.equal(s.home, o.sandboxHome)
    assert.equal(s.agentDir, join(o.sandboxHome, '.pi', 'agent'))
    assert.deepEqual(s.mcp, { mcpServers: { fermi: { url: EVAL_URL } } })
    // pi saw the login copy while it ran
    assert.match(s.auth, /fake-token/)
    // the real mcp.json is still unreadable: nothing could have read it
    assert.throws(() => readFileSync(join(realHome, '.pi', 'agent', 'mcp.json')), /EACCES/)
  })

  test('piMcpConfig translates the runner config (object, JSON text or path) to pi mcp.json', () => {
    const cfg = { mcpServers: { fermi: { type: 'http', url: EVAL_URL, headers: { 'x-eval': '1' } } } }
    const want = { mcpServers: { fermi: { url: EVAL_URL, headers: { 'x-eval': '1' } } } }
    assert.deepEqual(piMcpConfig(cfg), want)
    assert.deepEqual(piMcpConfig(JSON.stringify(cfg)), want)
    const f = join(tmp(), 'mcp.json')
    writeFileSync(f, JSON.stringify(cfg))
    assert.deepEqual(piMcpConfig(f), want)
  })

  test('mcpConfig without sandboxHome is refused', () => {
    const { sandboxHome, ...o } = evalOpts()
    assert.throws(() => runOnce({ ...o, prompt: 'x' }), /mcpConfig without sandboxHome/)
    assert.equal(existsSync(out), false)
  })
})

describe('pr-60 AC2: the sandbox auth.json is removed after the attempt', () => {
  test('runOnce: gone once the run is done', async () => {
    const o = evalOpts()
    await runOnce({ ...o, prompt: 'drain' }).done
    assert.match(seen().auth, /fake-token/)
    assert.equal(existsSync(join(o.sandboxHome, '.pi', 'agent', 'auth.json')), false)
    // the real one is untouched
    assert.equal(existsSync(join(realHome, '.pi', 'agent', 'auth.json')), true)
  })

  test('startSession: gone once the session is closed', async () => {
    const o = evalOpts()
    const s = startSession(o)
    const ended = new Promise((r) => s.events.on('event', (ev) => ev.type === 'turn_end' && r()))
    s.send('hi')
    await ended
    const auth = join(o.sandboxHome, '.pi', 'agent', 'auth.json')
    assert.equal(existsSync(auth), true)
    s.close('SIGTERM')
    // removed on the child's 'close', which follows 'exit' once stdio drains
    for (const t0 = Date.now(); existsSync(auth) && Date.now() - t0 < 5000; ) await new Promise((r) => setTimeout(r, 20))
    assert.equal(existsSync(auth), false)
  })

  test('a pi that fails to spawn leaves no auth.json behind', async () => {
    const o = evalOpts({ bin: join(tmp(), 'no-such-pi') })
    await runOnce({ ...o, prompt: 'x' }).done
    assert.equal(existsSync(join(o.sandboxHome, '.pi', 'agent', 'auth.json')), false)
  })

  test('the eval runner gives pi a temp sandboxHome and removes it after the attempt', async () => {
    let home, existedDuring
    const spy = {
      name: 'pi',
      runOnce: (o) => {
        home = o.sandboxHome
        existedDuring = home != null && existsSync(home)
        return fake.runOnce(o)
      },
    }
    const scenario = loadScenario(SCENARIO)
    const outDir = tmp()
    const r = await runAttempt({ scenario, attempt: 1, harness: spy, timeoutMs: 10_000, outDir })
    assert.equal(r.pass, true, JSON.stringify(r.failed))
    assert.ok(home, 'runner passed sandboxHome')
    assert.equal(existedDuring, true)
    assert.ok(!home.startsWith(outDir), 'sandbox is outside the run artifacts')
    assert.equal(existsSync(home), false)
  })

  test('other harnesses get no sandboxHome', async () => {
    let opts
    const spy = { name: 'claude-code', runOnce: (o) => ((opts = o), fake.runOnce(o)) }
    const scenario = loadScenario(SCENARIO)
    await runAttempt({ scenario, attempt: 1, harness: spy, timeoutMs: 10_000, outDir: tmp() })
    assert.equal(opts.sandboxHome, undefined)
  })
})

describe('pr-60 AC3: a non-localhost MCP URL refuses to start', () => {
  test('piMcpConfig throws on a non-localhost or url-less server', () => {
    assert.throws(() => piMcpConfig(PROD), /refusing to start: non-localhost MCP server\(s\): fermi=https:\/\/fermi\.example\.workers\.dev\/mcp/)
    assert.throws(() => piMcpConfig({ mcpServers: { a: { url: EVAL_URL }, b: { command: 'npx' } } }), /refusing to start: non-localhost .*b=\(no url\)/)
    assert.throws(() => piMcpConfig({ mcpServers: { a: { url: 'http://127.0.0.1.example.com/mcp' } } }), /refusing to start: non-localhost/)
  })

  test('runOnce refuses before writing the sandbox or spawning pi', () => {
    const o = evalOpts()
    writeFileSync(o.mcpConfig, JSON.stringify({ mcpServers: { fermi: { type: 'http', url: EVAL_URL }, prod: PROD.mcpServers.fermi } }))
    assert.throws(() => runOnce({ ...o, prompt: 'x' }), /refusing to start: non-localhost/)
    assert.equal(existsSync(join(o.sandboxHome, '.pi')), false)
    assert.equal(existsSync(out), false)
  })
})
