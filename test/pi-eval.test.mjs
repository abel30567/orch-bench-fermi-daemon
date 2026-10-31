// pr-60: the pi adapter's eval mode. pi reads its MCP servers and its login from
// $HOME/.pi/agent, so an eval gets a sandbox HOME holding only the localhost eval
// worker; the real config (production Fermi) is never read. A fake pi binary
// records what it sees; no inference, no network.
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as pi from '../harness/pi.mjs'
import { runAttempt } from '../evals/lib/runner.mjs'
import { loadScenario } from '../evals/lib/scenario.mjs'
import { ROOT } from './run-worker.mjs'

const tmp = () => mkdtempSync(join(tmpdir(), 'pr60-'))
const LOCAL = { mcpServers: { fermi: { type: 'http', url: 'http://127.0.0.1:4321/mcp' } } }
const PROD = 'https://fermi.example.com/mcp'

// Fake pi: on the first prompt, records HOME, PI_CODING_AGENT_DIR and the agent
// dir's mcp.json/auth.json to $PI_FAKE_RECORD, then settles the turn.
const FAKE = join(tmp(), 'fake-pi.mjs')
writeFileSync(
  FAKE,
  `import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
const dir = process.env.PI_CODING_AGENT_DIR
const read = (f) => (existsSync(join(dir, f)) ? readFileSync(join(dir, f), 'utf8') : null)
createInterface({ input: process.stdin }).on('line', (l) => {
  if (JSON.parse(l).type !== 'prompt') return
  writeFileSync(process.env.PI_FAKE_RECORD, JSON.stringify({ home: process.env.HOME, dir, mcp: JSON.parse(read('mcp.json')), auth: read('auth.json') }))
  console.log(JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }], stopReason: 'stop' } }))
  console.log(JSON.stringify({ type: 'agent_settled' }))
})
`,
)
const BIN = join(tmp(), 'pi')
writeFileSync(BIN, `#!/bin/sh\nexec "${process.execPath}" "${FAKE}" "$@"\n`)
chmodSync(BIN, 0o755)

// A fake "real" HOME whose pi config points at production; its mcp.json is unreadable,
// so any attempt to read it fails loudly.
let realHome, savedHome, savedDir
before(() => {
  realHome = tmp()
  const agent = join(realHome, '.pi', 'agent')
  mkdirSync(agent, { recursive: true })
  writeFileSync(join(agent, 'mcp.json'), JSON.stringify({ mcpServers: { fermi: { url: PROD } } }))
  chmodSync(join(agent, 'mcp.json'), 0o000)
  writeFileSync(join(agent, 'auth.json'), '{"anthropic":{"type":"oauth","access":"fake-access"}}')
  savedHome = process.env.HOME
  savedDir = process.env.PI_CODING_AGENT_DIR
  process.env.HOME = realHome
  process.env.PI_CODING_AGENT_DIR = agent // the real agent dir in the parent env must not leak through
})
after(() => {
  process.env.HOME = savedHome
  if (savedDir == null) delete process.env.PI_CODING_AGENT_DIR
  else process.env.PI_CODING_AGENT_DIR = savedDir
})

const runPi = async (o) => {
  const record = join(tmp(), 'record.json')
  const r = pi.runOnce({ bin: BIN, prompt: 'go', cwd: tmp(), env: { PI_FAKE_RECORD: record }, ...o })
  const done = await r.done
  return { done, seen: JSON.parse(readFileSync(record, 'utf8')) }
}

describe('pr-60 AC1: eval mode runs pi with HOME=<sandboxHome> and only the localhost eval worker', () => {
  test('HOME, PI_CODING_AGENT_DIR and mcp.json are the sandbox\'s; the real mcp.json is never read', async () => {
    const sandboxHome = tmp()
    const cfg = join(tmp(), 'mcp.json')
    writeFileSync(cfg, JSON.stringify(LOCAL))
    const { done, seen } = await runPi({ mcpConfig: cfg, sandboxHome })
    assert.equal(done.outcome.ok, true)
    assert.equal(seen.home, sandboxHome)
    assert.equal(seen.dir, join(sandboxHome, '.pi', 'agent'))
    assert.deepEqual(seen.mcp, { mcpServers: { fermi: { url: 'http://127.0.0.1:4321/mcp' } } })
    assert.ok(!JSON.stringify(seen).includes(PROD))
  })

  test('piMcpConfig translates objects, JSON strings and files, keeping headers', () => {
    const withHeaders = { mcpServers: { fermi: { type: 'http', url: 'http://localhost:1/mcp', headers: { 'x-a': 'b' } } } }
    const want = { mcpServers: { fermi: { url: 'http://localhost:1/mcp', headers: { 'x-a': 'b' } } } }
    assert.deepEqual(pi.piMcpConfig(withHeaders), want)
    assert.deepEqual(pi.piMcpConfig(JSON.stringify(withHeaders)), want)
    const f = join(tmp(), 'm.json')
    writeFileSync(f, JSON.stringify(withHeaders))
    assert.deepEqual(pi.piMcpConfig(f), want)
  })

  test('mcpConfig without sandboxHome refuses to start', () => {
    assert.throws(() => pi.runOnce({ bin: BIN, prompt: 'go', cwd: tmp(), mcpConfig: LOCAL }), /^Error: mcpConfig without sandboxHome/)
  })

  test('the eval runner passes a sandbox HOME for pi and the attempt reaches only the local worker', async () => {
    const record = join(tmp(), 'record.json')
    const harness = { ...pi, runOnce: (o) => pi.runOnce({ ...o, bin: BIN, env: { ...o.env, PI_FAKE_RECORD: record } }) }
    const scenario = loadScenario(join(ROOT, 'evals/scenarios/examples/reply-contract.json'))
    await runAttempt({ scenario, attempt: 1, harness, timeoutMs: 10_000, outDir: tmp() })
    const seen = JSON.parse(readFileSync(record, 'utf8'))
    assert.notEqual(seen.home, realHome)
    assert.match(seen.home, /fermi-eval-home-/)
    assert.deepEqual(Object.keys(seen.mcp.mcpServers), ['fermi'])
    assert.match(seen.mcp.mcpServers.fermi.url, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/)
    assert.equal(existsSync(seen.home), false, 'the sandbox HOME is removed after the attempt')
  })
})

describe('pr-60 AC2: the sandbox auth.json is removed after the attempt', () => {
  test('pi sees a copy of the real auth.json while it runs; the copy is gone afterwards', async () => {
    const sandboxHome = tmp()
    const { seen } = await runPi({ mcpConfig: LOCAL, sandboxHome })
    assert.equal(seen.auth, readFileSync(join(realHome, '.pi', 'agent', 'auth.json'), 'utf8'))
    assert.equal(existsSync(join(sandboxHome, '.pi', 'agent', 'auth.json')), false)
    assert.equal(existsSync(join(realHome, '.pi', 'agent', 'auth.json')), true, 'the real auth.json is untouched')
  })

  test('a long-lived session that is closed also removes it', async () => {
    const sandboxHome = tmp()
    const auth = join(sandboxHome, '.pi', 'agent', 'auth.json')
    const s = pi.startSession({ bin: BIN, cwd: tmp(), env: { PI_FAKE_RECORD: join(tmp(), 'r.json') }, mcpConfig: LOCAL, sandboxHome })
    assert.equal(existsSync(auth), true)
    const exited = new Promise((r) => s.events.once('exit', r))
    s.close('SIGTERM')
    await exited
    for (let i = 0; i < 50 && existsSync(auth); i++) await new Promise((r) => setTimeout(r, 20))
    assert.equal(existsSync(auth), false)
  })

  test('a pi binary that fails to spawn (ENOENT) also removes it, and done resolves', async () => {
    const sandboxHome = tmp()
    const auth = join(sandboxHome, '.pi', 'agent', 'auth.json')
    const r = pi.runOnce({ bin: join(tmp(), 'no-such-pi'), prompt: 'go', cwd: tmp(), mcpConfig: LOCAL, sandboxHome })
    assert.equal(existsSync(auth), true)
    const done = await r.done
    assert.notEqual(done.code, 0)
    assert.equal(existsSync(auth), false)
  })
})

describe('pr-60 AC3: a non-localhost MCP URL refuses to start', () => {
  for (const [label, server] of [
    ['production URL', { type: 'http', url: PROD }],
    ['url-less (stdio) server', { command: 'npx', args: ['some-mcp'] }],
    ['look-alike host', { type: 'http', url: 'http://127.0.0.1.example.com/mcp' }],
  ]) {
    test(label, () => {
      const sandboxHome = tmp()
      const cfg = { mcpServers: { ...LOCAL.mcpServers, other: server } }
      assert.throws(() => pi.piMcpConfig(cfg), /^Error: refusing to start: non-localhost/)
      assert.throws(() => pi.runOnce({ bin: BIN, prompt: 'go', cwd: tmp(), mcpConfig: cfg, sandboxHome }), /refusing to start: non-localhost/)
      assert.equal(existsSync(join(sandboxHome, '.pi')), false, 'nothing written, no auth.json copied')
    })
  }
})
