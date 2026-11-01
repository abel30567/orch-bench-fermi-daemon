// pi adapter eval mode: a sandbox HOME whose mcp.json holds only the local eval worker.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { piMcpConfig, runOnce, startSession } from '../harness/pi.mjs'

const tmp = () => mkdtempSync(join(tmpdir(), 'pi-eval-'))

// A fake pi that, on its prompt, records HOME, PI_CODING_AGENT_DIR and the
// mcp.json/auth.json it would load (from the agent dir pi resolves), then settles.
const bin = join(tmp(), 'pi')
writeFileSync(
  bin,
  `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path')
const read = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null)
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n')
require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
  if (JSON.parse(line).type !== 'prompt') return
  const agentDir = process.env.PI_CODING_AGENT_DIR || path.join(process.env.HOME, '.pi', 'agent')
  fs.writeFileSync(path.join(process.env.FAKE_DIR, 'seen.json'), JSON.stringify({
    HOME: process.env.HOME, agentDir, mcp: read(path.join(agentDir, 'mcp.json')), auth: read(path.join(agentDir, 'auth.json')),
  }))
  out({ type: 'response', command: 'prompt', success: true, data: { disposition: 'started' } })
  out({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }], stopReason: 'stop' } })
  out({ type: 'agent_settled' })
}).on('close', () => process.exit(0))
`,
)
chmodSync(bin, 0o755)

const EVAL_URL = 'http://127.0.0.1:43210/mcp'
const PROD_URL = 'https://fermi.example.com/mcp'

// A real HOME whose ~/.pi/agent points at production and holds the login.
function realHome() {
  const home = tmp()
  mkdirSync(join(home, '.pi', 'agent'), { recursive: true })
  writeFileSync(join(home, '.pi', 'agent', 'mcp.json'), JSON.stringify({ mcpServers: { fermi: { url: PROD_URL } } }))
  writeFileSync(join(home, '.pi', 'agent', 'auth.json'), '{"anthropic":{"type":"oauth","access":"tok"}}')
  return home
}

async function withHome(home, fn) {
  const prev = process.env.HOME
  process.env.HOME = home
  try {
    return await fn()
  } finally {
    process.env.HOME = prev
  }
}

describe('pi eval mode', () => {
  test('AC1+AC2: pi runs with HOME=<sandboxHome>, sees only the eval worker, and the auth.json copy is removed', async () => {
    const home = realHome()
    const sandboxHome = tmp()
    const fakeDir = tmp()
    const mcpConfig = join(tmp(), 'mcp.json')
    writeFileSync(mcpConfig, JSON.stringify({ mcpServers: { fermi: { type: 'http', url: EVAL_URL } } }))
    const res = await withHome(home, () =>
      runOnce({ bin, prompt: 'go', mcpConfig, sandboxHome, env: { FAKE_DIR: fakeDir, HOME: home } }).done,
    )
    assert.equal(res.outcome?.ok, true)
    const seen = JSON.parse(readFileSync(join(fakeDir, 'seen.json'), 'utf8'))
    assert.equal(seen.HOME, sandboxHome)
    assert.equal(seen.agentDir, join(sandboxHome, '.pi', 'agent'))
    assert.deepEqual(JSON.parse(seen.mcp), { mcpServers: { fermi: { url: EVAL_URL } } })
    assert.ok(!seen.mcp.includes(PROD_URL))
    assert.equal(seen.auth, '{"anthropic":{"type":"oauth","access":"tok"}}', 'pi could log in from the sandbox copy')
    assert.equal(existsSync(join(sandboxHome, '.pi', 'agent', 'auth.json')), false, 'sandbox auth.json removed')
    assert.equal(existsSync(join(home, '.pi', 'agent', 'auth.json')), true, 'real auth.json untouched')
  })

  test('AC2: a session removes the sandbox auth.json when it is closed', async () => {
    const home = realHome()
    const sandboxHome = tmp()
    const s = await withHome(home, () =>
      startSession({ bin, mcpConfig: { mcpServers: { fermi: { url: EVAL_URL } } }, sandboxHome, env: { FAKE_DIR: tmp() } }),
    )
    assert.equal(existsSync(join(sandboxHome, '.pi', 'agent', 'auth.json')), true)
    const exited = new Promise((r) => s.events.once('exit', r))
    s.close('SIGTERM')
    await exited
    assert.equal(existsSync(join(sandboxHome, '.pi', 'agent', 'auth.json')), false)
  })

  test('AC3: a non-localhost or url-less MCP server refuses to start', () => {
    const sandboxHome = tmp()
    for (const server of [{ url: PROD_URL }, { command: 'npx', args: ['fermi'] }, { url: 'http://localhost.evil.com/mcp' }]) {
      const mcpConfig = { mcpServers: { eval: { url: EVAL_URL }, other: server } }
      assert.throws(() => piMcpConfig(mcpConfig), /refusing to start: non-localhost/)
      assert.throws(() => runOnce({ bin, prompt: 'go', mcpConfig, sandboxHome }), /refusing to start: non-localhost/)
    }
    assert.equal(existsSync(join(sandboxHome, '.pi', 'agent', 'mcp.json')), false, 'nothing written')
  })

  test('mcpConfig without sandboxHome is refused', () => {
    assert.throws(() => runOnce({ bin, prompt: 'go', mcpConfig: { mcpServers: {} } }), /mcpConfig without sandboxHome/)
  })

  test('piMcpConfig accepts a path, JSON text or an object', () => {
    const want = { mcpServers: { fermi: { url: EVAL_URL } } }
    const cfg = { mcpServers: { fermi: { type: 'http', url: EVAL_URL } } }
    const file = join(tmp(), 'mcp.json')
    writeFileSync(file, JSON.stringify(cfg))
    assert.deepEqual(piMcpConfig(cfg), want)
    assert.deepEqual(piMcpConfig(JSON.stringify(cfg)), want)
    assert.deepEqual(piMcpConfig(file), want)
  })
})
