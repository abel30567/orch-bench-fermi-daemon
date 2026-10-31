// pr-60: pi adapter eval mode. With mcpConfig + sandboxHome, pi runs with
// HOME=<sandboxHome> and a generated localhost-only mcp.json; the real auth.json
// is copied in for the attempt and deleted after; the eval runner passes
// sandboxHome for pi.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ROOT } from './run-worker.mjs'
import * as pi from '../harness/pi.mjs'
import * as fake from '../evals/harness/fake.mjs'
import { runAttempt } from '../evals/lib/runner.mjs'
import { loadScenario } from '../evals/lib/scenario.mjs'

const FAKE_PI = join(ROOT, 'test/fixtures/fake-pi-eval.mjs')
const tmp = () => mkdtempSync(join(tmpdir(), 'pr60-'))
const LOCAL = 'http://127.0.0.1:18005/mcp'
const PROD = 'https://fermi.example.workers.dev/mcp'
const AUTH = JSON.stringify({ anthropic: { type: 'oauth', access: 'fake-access', refresh: 'fake-refresh' } })

// A real HOME whose .pi/agent holds a production mcp.json (unreadable: any read
// throws) and an auth.json; a runner-shaped MCP config file; a fake pi binary.
function setup(servers = { fermi: { type: 'http', url: LOCAL } }) {
  const dir = tmp()
  const realHome = join(dir, 'home')
  const realAgent = join(realHome, '.pi/agent')
  mkdirSync(realAgent, { recursive: true })
  writeFileSync(join(realAgent, 'mcp.json'), JSON.stringify({ mcpServers: { fermi: { url: PROD } } }))
  chmodSync(join(realAgent, 'mcp.json'), 0o000)
  writeFileSync(join(realAgent, 'auth.json'), AUTH)
  const mcpConfig = join(dir, 'mcp.json')
  writeFileSync(mcpConfig, JSON.stringify({ mcpServers: servers }))
  const fakeDir = join(dir, 'fake')
  mkdirSync(fakeDir)
  const bin = join(dir, 'pi')
  writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${FAKE_PI}" "$@"\n`)
  chmodSync(bin, 0o755)
  const sandboxHome = join(dir, 'sandbox')
  return { dir, realHome, mcpConfig, sandboxHome, bin, opts: { bin, mcpConfig, sandboxHome, realHome, cwd: dir, env: { FAKE_DIR: fakeDir } }, spawned: () => readJson(fakeDir, 'spawn.json'), fakeDir }
}
const readJson = (...p) => JSON.parse(readFileSync(join(...p), 'utf8'))

describe('AC1: eval mode runs pi in the sandbox HOME with a localhost-only mcp.json', () => {
  test('HOME and PI_CODING_AGENT_DIR point into the sandbox; mcp.json holds only the eval worker', async () => {
    const s = setup()
    const r = await pi.runOnce({ ...s.opts, prompt: 'hi' }).done
    assert.equal(r.outcome?.ok, true, r.stderr)
    const seen = s.spawned()
    assert.equal(seen.home, s.sandboxHome)
    assert.equal(seen.agentDir, join(s.sandboxHome, '.pi/agent'))
    assert.deepEqual(JSON.parse(seen.mcp), { mcpServers: { fermi: { url: LOCAL } } })
    assert.doesNotMatch(seen.mcp, /workers\.dev/)
    assert.equal(seen.auth, AUTH, 'pi can log in from the sandbox auth.json')
  })

  test('the real mcp.json is never read (it is unreadable, and nothing from it leaks)', async () => {
    const s = setup()
    const r = await pi.runOnce({ ...s.opts, prompt: 'hi' }).done
    assert.equal(r.outcome?.ok, true, r.stderr)
    chmodSync(join(s.realHome, '.pi/agent/mcp.json'), 0o600)
    assert.match(readFileSync(join(s.realHome, '.pi/agent/mcp.json'), 'utf8'), /workers\.dev/, 'the real file is untouched')
  })

  test('piMcpConfig translates an object, JSON text or a file and keeps headers', () => {
    const cfg = { mcpServers: { fermi: { type: 'http', url: LOCAL, headers: { 'x-eval': '1' } } } }
    const want = { mcpServers: { fermi: { url: LOCAL, headers: { 'x-eval': '1' } } } }
    assert.deepEqual(pi.piMcpConfig(cfg), want)
    assert.deepEqual(pi.piMcpConfig(JSON.stringify(cfg)), want)
    const f = join(tmp(), 'mcp.json')
    writeFileSync(f, JSON.stringify(cfg))
    assert.deepEqual(pi.piMcpConfig(f), want)
  })

  test('mcpConfig without sandboxHome refuses to start', () => {
    const s = setup()
    assert.throws(() => pi.runOnce({ ...s.opts, sandboxHome: undefined, prompt: 'hi' }), /mcpConfig without sandboxHome/)
    assert.throws(() => pi.startSession({ ...s.opts, sandboxHome: s.realHome }), /sandboxHome is the real HOME/)
    assert.deepEqual(readdirSync(s.fakeDir), [], 'pi was never spawned')
  })
})

describe('AC2: the sandbox auth.json is removed after the attempt', () => {
  test('runOnce: gone once the run is done; the real auth.json stays', async () => {
    const s = setup()
    await pi.runOnce({ ...s.opts, prompt: 'hi' }).done
    assert.equal(s.spawned().auth, AUTH)
    assert.equal(existsSync(join(s.sandboxHome, '.pi/agent/auth.json')), false)
    assert.equal(readFileSync(join(s.realHome, '.pi/agent/auth.json'), 'utf8'), AUTH)
  })

  test('startSession: gone once the session is closed', async () => {
    const s = setup()
    const session = pi.startSession(s.opts)
    const ended = new Promise((r) => session.events.on('event', (ev) => ev.type === 'turn_end' && r()))
    session.send('hi')
    await ended
    assert.equal(existsSync(join(s.sandboxHome, '.pi/agent/auth.json')), true, 'present while the session runs')
    const exited = new Promise((r) => session.events.on('exit', r))
    session.close('SIGTERM')
    await exited
    await new Promise((r) => setImmediate(r)) // 'close' follows 'exit'
    assert.equal(existsSync(join(s.sandboxHome, '.pi/agent/auth.json')), false)
  })

  test('a binary that fails to spawn still removes it', async () => {
    const s = setup()
    pi.runOnce({ ...s.opts, bin: join(s.dir, 'missing-pi'), prompt: 'hi' })
    await new Promise((r) => setTimeout(r, 200))
    assert.equal(existsSync(join(s.sandboxHome, '.pi/agent/auth.json')), false)
  })
})

describe('AC3: a non-localhost URL in the MCP config refuses to start', () => {
  for (const [label, servers] of [
    ['production URL', { fermi: { type: 'http', url: PROD } }],
    ['one bad server among local ones', { fermi: { type: 'http', url: LOCAL }, other: { type: 'http', url: 'http://10.0.0.5/mcp' } }],
    ['url-less (stdio) server', { fermi: { command: 'npx', args: ['mcp-remote', PROD] } }],
  ]) {
    test(label, () => {
      const s = setup(servers)
      assert.throws(() => pi.runOnce({ ...s.opts, prompt: 'hi' }), /^Error: refusing to start: non-localhost/)
      assert.deepEqual(readdirSync(s.fakeDir), [], 'pi was never spawned')
      assert.equal(existsSync(join(s.sandboxHome, '.pi/agent/mcp.json')), false, 'no mcp.json written')
      assert.equal(existsSync(join(s.sandboxHome, '.pi/agent/auth.json')), false, 'no auth.json copied')
    })
  }
})

describe('the eval runner passes sandboxHome for pi', () => {
  const scenario = loadScenario(join(ROOT, 'evals/scenarios/examples/reply-contract.json'))
  test('pi gets a fresh sandbox HOME that is removed after the attempt', async () => {
    const seen = {}
    const spy = {
      name: 'pi',
      runOnce: (o) => {
        seen.sandboxHome = o.sandboxHome
        seen.existed = o.sandboxHome != null && existsSync(o.sandboxHome)
        return fake.runOnce(o)
      },
    }
    const r = await runAttempt({ scenario, attempt: 1, harness: spy, timeoutMs: 10_000, outDir: tmp() })
    assert.equal(r.pass, true, JSON.stringify(r.failed))
    assert.equal(seen.existed, true)
    assert.notEqual(seen.sandboxHome, process.env.HOME)
    assert.equal(existsSync(seen.sandboxHome), false, 'sandbox removed')
  })

  test('other harnesses get no sandboxHome', async () => {
    const seen = {}
    const spy = { name: 'claude-code', runOnce: (o) => ((seen.opts = o), fake.runOnce(o)) }
    await runAttempt({ scenario, attempt: 1, harness: spy, timeoutMs: 10_000, outDir: tmp() })
    assert.equal('sandboxHome' in seen.opts, false)
  })
})
