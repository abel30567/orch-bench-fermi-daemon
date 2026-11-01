// pr-60: pi adapter eval mode. With mcpConfig + sandboxHome, pi runs under
// HOME=<sandboxHome> with only the localhost eval server in its mcp.json; the
// real ~/.pi/agent/mcp.json is never read and the auth.json copy is removed when
// the attempt ends. Runs against test/conformance/fake-pi.mjs, no inference.
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

const PROD = 'https://fermi.example.workers.dev/mcp'
const EVAL = 'http://127.0.0.1:18005/mcp'
const AUTH = '{"anthropic":{"type":"oauth","access":"fake-access","refresh":"fake-refresh"}}'

// A stand-in for the owner's real HOME: mcp.json pointing at production (made
// unreadable, so any read of it fails) and the auth.json pi logs in with.
function realHome() {
  const home = tmp()
  const agent = join(home, '.pi', 'agent')
  mkdirSync(agent, { recursive: true })
  writeFileSync(join(agent, 'mcp.json'), JSON.stringify({ mcpServers: { fermi: { url: PROD } } }))
  chmodSync(join(agent, 'mcp.json'), 0o000)
  writeFileSync(join(agent, 'auth.json'), AUTH)
  return home
}

const evalConfig = { mcpServers: { fermi: { type: 'http', url: EVAL } } }

async function attempt(extra) {
  const fakeDir = tmp()
  const home = realHome()
  const sandboxHome = join(tmp(), 'home')
  const run = pi.runOnce({ bin, prompt: 'sandbox', cwd: fakeDir, env: { FAKE_DIR: fakeDir, HOME: home }, mcpConfig: evalConfig, sandboxHome, ...extra })
  const r = await run.done
  return { r, home, sandboxHome, seen: JSON.parse(readFileSync(join(fakeDir, 'sandbox.json'), 'utf8')) }
}

describe('AC1: eval mode runs pi under the sandbox HOME with only the localhost eval worker', () => {
  test('HOME, PI_CODING_AGENT_DIR and mcp.json point at the sandbox; the real mcp.json is never read', async () => {
    const { r, home, sandboxHome, seen } = await attempt()
    assert.equal(r.outcome?.ok, true, r.stderr)
    assert.equal(seen.home, sandboxHome)
    assert.equal(seen.agentDir, join(sandboxHome, '.pi', 'agent'))
    assert.deepEqual(seen.mcp, { mcpServers: { fermi: { type: 'http', url: EVAL } } })
    assert.ok(!JSON.stringify(seen).includes('workers.dev'))
    // still unreadable: nobody chmod-ed it back to read the production config
    assert.equal(readFileSync(join(home, '.pi', 'agent', 'auth.json'), 'utf8'), AUTH)
    assert.throws(() => readFileSync(join(home, '.pi', 'agent', 'mcp.json')), process.getuid?.() === 0 ? undefined : /EACCES/)
  })

  test('piMcpConfig translates the runner config (object, JSON string or file) to pi mcp.json', () => {
    const want = { mcpServers: { fermi: { type: 'http', url: EVAL } } }
    assert.deepEqual(pi.piMcpConfig(evalConfig), want)
    assert.deepEqual(pi.piMcpConfig(JSON.stringify(evalConfig)), want)
    const f = join(tmp(), 'mcp.json')
    writeFileSync(f, JSON.stringify(evalConfig))
    assert.deepEqual(pi.piMcpConfig(f), want)
    assert.deepEqual(pi.piMcpConfig({ mcpServers: { a: { url: 'http://localhost:1/mcp' }, b: { url: 'http://[::1]:2/mcp' } } }).mcpServers.b, { type: 'http', url: 'http://[::1]:2/mcp' })
  })

  test('the eval runner gives pi a sandbox HOME holding only the eval proxy, and removes it', async () => {
    const home = realHome()
    const fakeDir = tmp()
    let opts
    const harness = {
      ...pi,
      runOnce: (o) => {
        opts = o
        return pi.runOnce({ ...o, bin, prompt: 'sandbox', env: { ...o.env, FAKE_DIR: fakeDir, HOME: home } })
      },
    }
    const scenario = loadScenario(join(ROOT, 'evals/scenarios/examples/reply-contract.json'))
    await runAttempt({ scenario, attempt: 1, harness, timeoutMs: 10_000, outDir: tmp() })
    const seen = JSON.parse(readFileSync(join(fakeDir, 'sandbox.json'), 'utf8'))
    assert.ok(opts.sandboxHome, 'runner passed sandboxHome')
    assert.equal(seen.home, opts.sandboxHome)
    assert.deepEqual(Object.keys(seen.mcp.mcpServers), ['fermi'])
    assert.match(seen.mcp.mcpServers.fermi.url, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/)
    assert.equal(seen.auth, AUTH)
    assert.equal(existsSync(opts.sandboxHome), false, 'sandbox HOME removed after the attempt')
  })

  test('other harnesses get no sandboxHome from the runner', async () => {
    let opts
    const harness = { name: 'claude-code', runOnce: (o) => ((opts = o), { events: { on() {} }, done: Promise.resolve({}) }) }
    const scenario = loadScenario(join(ROOT, 'evals/scenarios/examples/reply-contract.json'))
    await runAttempt({ scenario, attempt: 1, harness, timeoutMs: 10_000, outDir: tmp() })
    assert.equal(opts.sandboxHome, undefined)
  })
})

describe('AC2: the sandbox auth.json is removed after the attempt', () => {
  test('runOnce: present during the run, gone after', async () => {
    const { r, sandboxHome, seen } = await attempt()
    assert.equal(r.code, 0)
    assert.equal(seen.auth, AUTH, 'pi could log in during the attempt')
    assert.equal(existsSync(join(sandboxHome, '.pi', 'agent', 'auth.json')), false)
  })

  test('startSession: gone after close()', async () => {
    const fakeDir = tmp()
    const sandboxHome = join(tmp(), 'home')
    const s = pi.startSession({ bin, cwd: fakeDir, env: { FAKE_DIR: fakeDir, HOME: realHome() }, mcpConfig: evalConfig, sandboxHome })
    const auth = join(sandboxHome, '.pi', 'agent', 'auth.json')
    assert.equal(readFileSync(auth, 'utf8'), AUTH)
    const exited = new Promise((r) => s.events.once('exit', r))
    s.close('SIGTERM')
    await exited
    await new Promise((r) => setImmediate(r))
    assert.equal(existsSync(auth), false)
  })

  test('a pi that dies at startup still removes it', async () => {
    const fakeDir = tmp()
    const sandboxHome = join(tmp(), 'home')
    const dead = join(tmp(), 'pi')
    writeFileSync(dead, '#!/bin/sh\nexit 3\n')
    chmodSync(dead, 0o755)
    const r = await pi.runOnce({ bin: dead, prompt: 'x', cwd: fakeDir, env: { HOME: realHome() }, mcpConfig: evalConfig, sandboxHome }).done
    assert.equal(r.code, 3)
    assert.equal(existsSync(join(sandboxHome, '.pi', 'agent', 'auth.json')), false)
  })
})

describe('AC3: a non-localhost MCP URL refuses to start', () => {
  for (const [label, url] of [
    ['production placeholder', PROD],
    ['plain http remote', 'http://example.com/mcp'],
    ['localhost lookalike', 'http://localhost.example.com/mcp'],
    ['not a URL', 'fermi'],
  ])
    test(label, () => {
      const cfg = { mcpServers: { eval: { url: EVAL }, fermi: { type: 'http', url } } }
      assert.throws(() => pi.piMcpConfig(cfg), /refusing to start: non-localhost/)
      const sandboxHome = join(tmp(), 'home')
      assert.throws(() => pi.runOnce({ bin, prompt: 'sandbox', env: { HOME: realHome() }, mcpConfig: cfg, sandboxHome }), /refusing to start: non-localhost/)
      assert.equal(existsSync(join(sandboxHome, '.pi')), false, 'nothing written, auth.json not copied')
    })

  test('a url-less (stdio) server refuses to start', () => {
    assert.throws(() => pi.piMcpConfig({ mcpServers: { x: { command: 'curl', args: [PROD] } } }), /refusing to start: non-localhost/)
  })

  test('mcpConfig without sandboxHome refuses to start', () => {
    assert.throws(() => pi.runOnce({ bin, prompt: 'sandbox', mcpConfig: evalConfig }), /mcpConfig without sandboxHome/)
    assert.throws(() => pi.startSession({ bin, mcpConfig: evalConfig }), /mcpConfig without sandboxHome/)
  })
})
