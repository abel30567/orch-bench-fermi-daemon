// pi adapter eval mode (harness/pi.mjs): sandboxed HOME, localhost-only mcp.json,
// auth.json copied in and removed after the attempt.
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { piMcpConfig, runOnce, startSession } from '../harness/pi.mjs'

const tmp = mkdtempSync(join(tmpdir(), 'pi-eval-'))
const realHome = join(tmp, 'real-home')
const realAgent = join(realHome, '.pi', 'agent')
const probe = join(tmp, 'probe.json')
const PROD = 'https://fermi.example.com/mcp'
const EVAL = { mcpServers: { fermi: { type: 'http', url: 'http://127.0.0.1:4321/mcp' } } }

// Fake pi: records what it sees at startup, then settles each prompt.
const fake = join(tmp, 'fake-pi.mjs')
writeFileSync(
  fake,
  `import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
const home = process.env.HOME, dir = process.env.PI_CODING_AGENT_DIR
const read = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : null)
writeFileSync(process.env.PROBE, JSON.stringify({ home, dir, mcp: read(join(dir, 'mcp.json')), homeMcp: read(join(home, '.pi/agent/mcp.json')), auth: read(join(dir, 'auth.json')) }))
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n')
createInterface({ input: process.stdin }).on('line', (l) => {
  if (JSON.parse(l).type !== 'prompt') return
  out({ type: 'response', command: 'prompt', success: true, data: { disposition: 'started' } })
  out({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }], stopReason: 'stop' } })
  out({ type: 'agent_settled' })
}).on('close', () => process.exit(0))
`,
)
const bin = join(tmp, 'pi')
writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${fake}" "$@"\n`)
chmodSync(bin, 0o755)

let savedHome
before(() => {
  mkdirSync(realAgent, { recursive: true })
  writeFileSync(join(realAgent, 'mcp.json'), JSON.stringify({ mcpServers: { fermi: { url: PROD } } }))
  writeFileSync(join(realAgent, 'auth.json'), '{"anthropic":{"type":"oauth","access":"real-token"}}')
  savedHome = process.env.HOME
  process.env.HOME = realHome
})
after(() => (process.env.HOME = savedHome))

const evalOpts = (sandboxHome, extra = {}) => ({ bin, sandboxHome, mcpConfig: EVAL, env: { PROBE: probe }, prompt: 'go', ...extra })

test('eval mode: HOME is the sandbox and mcp.json holds only the localhost eval worker', async () => {
  const sandboxHome = join(tmp, 'sandbox-1')
  const file = join(tmp, 'runner-mcp.json')
  writeFileSync(file, JSON.stringify(EVAL))
  const { code, outcome } = await runOnce(evalOpts(sandboxHome, { mcpConfig: file })).done
  assert.equal(code, 0)
  assert.equal(outcome.ok, true)
  const p = JSON.parse(readFileSync(probe, 'utf8'))
  assert.equal(p.home, sandboxHome)
  assert.equal(p.dir, join(sandboxHome, '.pi', 'agent'))
  assert.deepEqual(JSON.parse(p.mcp), { mcpServers: { fermi: { url: 'http://127.0.0.1:4321/mcp' } } })
  assert.equal(p.homeMcp, p.mcp)
  assert.ok(!p.mcp.includes('fermi.example.com'), 'the real mcp.json is never used')
})

test('eval mode: auth.json is copied in for the attempt and removed after it', async () => {
  const sandboxHome = join(tmp, 'sandbox-2')
  const auth = join(sandboxHome, '.pi', 'agent', 'auth.json')
  await runOnce(evalOpts(sandboxHome)).done
  assert.equal(JSON.parse(readFileSync(probe, 'utf8')).auth, readFileSync(join(realAgent, 'auth.json'), 'utf8'))
  assert.equal(existsSync(auth), false)
  assert.equal(existsSync(join(realAgent, 'auth.json')), true, 'the real auth.json is left alone')

  const s = startSession(evalOpts(join(tmp, 'sandbox-3')))
  const closed = new Promise((r) => s.events.on('exit', r))
  assert.equal(existsSync(join(tmp, 'sandbox-3', '.pi', 'agent', 'auth.json')), true)
  s.close('SIGTERM')
  await closed
  // cleanup runs on the child's 'close', which follows 'exit' once stdio drains
  for (let i = 0; i < 100 && existsSync(join(tmp, 'sandbox-3', '.pi', 'agent', 'auth.json')); i++) await new Promise((r) => setTimeout(r, 20))
  assert.equal(existsSync(join(tmp, 'sandbox-3', '.pi', 'agent', 'auth.json')), false)
})

test('eval mode: a non-localhost or url-less MCP server refuses to start', () => {
  for (const cfg of [
    { mcpServers: { fermi: { url: PROD } } },
    { mcpServers: { fermi: EVAL.mcpServers.fermi, x: { url: 'http://localhost:1/mcp', headers: { via: 'http://evil.example/' } } } },
    { mcpServers: { local: { command: 'npx', args: ['some-mcp'] } } },
  ]) {
    assert.throws(() => piMcpConfig(cfg), /^Error: refusing to start: non-localhost/)
    const sandboxHome = join(tmp, 'sandbox-bad')
    assert.throws(() => runOnce(evalOpts(sandboxHome, { mcpConfig: cfg })), /refusing to start: non-localhost/)
    assert.equal(existsSync(join(sandboxHome, '.pi', 'agent', 'mcp.json')), false)
    assert.equal(existsSync(join(sandboxHome, '.pi', 'agent', 'auth.json')), false)
  }
})

test('mcpConfig without sandboxHome is refused', () => {
  assert.throws(() => runOnce({ bin, mcpConfig: EVAL, prompt: 'go' }), /mcpConfig without sandboxHome/)
})
