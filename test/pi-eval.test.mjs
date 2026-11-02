// pi adapter eval mode (harness/pi.mjs): with mcpConfig + sandboxHome, pi runs in
// a sandbox HOME whose agent dir holds only the eval worker's mcp.json and a
// copy of the login, deleted when pi exits. Runs against test/fixtures/fake-pi-home.mjs.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { ROOT } from './run-worker.mjs'
import * as pi from '../harness/pi.mjs'
import { runAttempt } from '../evals/lib/runner.mjs'
import { loadScenario } from '../evals/lib/scenario.mjs'

const tmp = () => mkdtempSync(join(tmpdir(), 'pi-eval-'))
const FAKE = join(ROOT, 'test/fixtures/fake-pi-home.mjs')
const PROD = 'https://fermi.example.com/mcp'
const AUTH = JSON.stringify({ anthropic: { type: 'oauth', access: 'sk-ant-oat-real', refresh: 'r' } })
const EVAL = { mcpServers: { fermi: { type: 'http', url: 'http://127.0.0.1:4567/mcp' } } }

// The owner's real HOME: a pi login and an mcp.json pointing at production Fermi.
const realHome = tmp()
const realAgent = join(realHome, '.pi', 'agent')
mkdirSync(realAgent, { recursive: true })
writeFileSync(join(realAgent, 'auth.json'), AUTH)
writeFileSync(join(realAgent, 'mcp.json'), JSON.stringify({ mcpServers: { fermi: { url: PROD } } }))
chmodSync(join(realAgent, 'mcp.json'), 0o000) // reading it fails (unless root)
process.env.HOME = realHome

const bin = join(tmp(), 'pi')
writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${FAKE}" "$@"\n`)
chmodSync(bin, 0o755)

// Eval-mode options with a fresh sandbox HOME, cwd and dump path.
const evalOpts = (extra = {}) => {
  const dir = tmp()
  const dump = join(dir, 'dump.json')
  return { bin, cwd: dir, sandboxHome: join(dir, 'home'), mcpConfig: EVAL, env: { FAKE_PI_DUMP: dump }, dump, ...extra }
}
const readDump = (o) => JSON.parse(readFileSync(o.dump, 'utf8'))
const sandboxAuth = (o) => join(o.sandboxHome, '.pi', 'agent', 'auth.json')

describe('pi eval mode: HOME is the sandbox and mcp.json holds only the eval worker', () => {
  test('runOnce: HOME and PI_CODING_AGENT_DIR are the sandbox; mcp.json is the localhost server; the real one is not reachable', async () => {
    const o = evalOpts()
    const { code, outcome } = await pi.runOnce({ ...o, prompt: 'go' }).done
    assert.equal(code, 0)
    assert.equal(outcome.ok, true)
    const d = readDump(o)
    assert.equal(d.home, o.sandboxHome)
    assert.equal(d.agentDir, join(o.sandboxHome, '.pi', 'agent'))
    assert.deepEqual(JSON.parse(d.mcp), { mcpServers: { fermi: { url: 'http://127.0.0.1:4567/mcp' } } })
    assert.doesNotMatch(d.mcp, /fermi\.example\.com/)
    const leaks = Object.entries(d.env).filter(([, v]) => String(v).includes(realHome))
    assert.deepEqual(leaks, [], 'no env var leads pi back to the real HOME')
    assert.equal(d.auth, AUTH, 'the login was copied in')
  })

  test('the MCP config may be a file path or a JSON string', async () => {
    const file = join(tmp(), 'mcp.json')
    writeFileSync(file, JSON.stringify(EVAL))
    for (const mcpConfig of [file, JSON.stringify(EVAL)]) {
      const o = evalOpts({ mcpConfig })
      await pi.runOnce({ ...o, prompt: 'go' }).done
      assert.deepEqual(JSON.parse(readDump(o).mcp), pi.piMcpConfig(EVAL))
    }
  })

  test('the eval runner gives pi a temp sandbox HOME with the attempt\'s localhost MCP server, removed afterwards', async () => {
    const dump = join(tmp(), 'dump.json')
    process.env.PI_BIN = bin
    process.env.FAKE_PI_DUMP = dump
    try {
      const scenario = loadScenario(join(ROOT, 'evals/scenarios/examples/reply-contract.json'))
      await runAttempt({ scenario, attempt: 1, harness: pi, timeoutMs: 10_000, outDir: tmp() })
    } finally {
      delete process.env.PI_BIN
      delete process.env.FAKE_PI_DUMP
    }
    const d = JSON.parse(readFileSync(dump, 'utf8'))
    assert.match(d.home, /fermi-eval-home-/)
    assert.notEqual(d.home, realHome)
    const servers = JSON.parse(d.mcp).mcpServers
    assert.deepEqual(Object.keys(servers), ['fermi'])
    assert.match(servers.fermi.url, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/)
    assert.equal(existsSync(d.home), false, 'the sandbox HOME is removed after the attempt')
  })
})

describe('pi eval mode: the sandbox auth.json is removed after the attempt', () => {
  test('runOnce: present while pi runs, gone once it exits; the real login is untouched', async () => {
    const o = evalOpts()
    await pi.runOnce({ ...o, prompt: 'go' }).done
    assert.equal(readDump(o).auth, AUTH)
    assert.equal(existsSync(sandboxAuth(o)), false)
    assert.equal(readFileSync(join(realAgent, 'auth.json'), 'utf8'), AUTH)
  })

  test('startSession: removed when the session is closed mid-turn', async () => {
    const o = evalOpts()
    const s = pi.startSession(o)
    s.send('hold')
    await new Promise((r) => s.events.on('raw', r)) // the fake is up and has dumped
    assert.equal(existsSync(sandboxAuth(o)), true)
    s.close('SIGKILL')
    await once(s.events, 'exit')
    assert.equal(existsSync(sandboxAuth(o)), false)
  })
})

describe('pi eval mode: a non-localhost MCP config refuses to start', () => {
  test('piMcpConfig refuses remote, look-alike and url-less servers', () => {
    const cfg = (s) => ({ mcpServers: { local: EVAL.mcpServers.fermi, other: s } })
    for (const s of [{ type: 'http', url: PROD }, { url: 'http://localhost.example.com/mcp' }, { url: 'file:///tmp/x' }, { command: 'npx', args: ['fermi-mcp'] }]) {
      assert.throws(() => pi.piMcpConfig(cfg(s)), /^Error: refusing to start: non-localhost .*other=/)
    }
    assert.deepEqual(pi.piMcpConfig({ mcpServers: { a: { url: 'http://localhost:1/mcp', headers: { x: '1' } } } }), {
      mcpServers: { a: { url: 'http://localhost:1/mcp', headers: { x: '1' } } },
    })
  })

  test('runOnce and startSession throw before pi starts or the sandbox is written', () => {
    for (const start of [pi.runOnce, pi.startSession]) {
      const o = evalOpts({ mcpConfig: { mcpServers: { fermi: { type: 'http', url: PROD } } } })
      assert.throws(() => start({ ...o, prompt: 'go' }), /refusing to start: non-localhost/)
      assert.equal(existsSync(o.dump), false, 'pi never started')
      assert.equal(existsSync(o.sandboxHome), false, 'nothing written to the sandbox')
    }
  })

  test('mcpConfig without sandboxHome is refused', () => {
    const o = evalOpts({ sandboxHome: undefined })
    assert.throws(() => pi.runOnce({ ...o, prompt: 'go' }), /^Error: mcpConfig without sandboxHome/)
    assert.equal(existsSync(o.dump), false)
  })
})
