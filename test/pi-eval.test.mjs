// pi adapter eval mode: a sandboxed HOME whose mcp.json holds only the local eval worker.
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { piMcpConfig, runOnce } from '../harness/pi.mjs'

const tmp = () => mkdtempSync(join(tmpdir(), 'pi-eval-'))
const LOCAL = { mcpServers: { fermi: { type: 'http', url: 'http://127.0.0.1:4100/mcp' } } }
const PROD = 'https://fermi.example.com/mcp'

// A fake pi that, on its prompt, records what it would read: HOME, PI_CODING_AGENT_DIR
// and the mcp.json / auth.json under $HOME/.pi/agent.
const FAKE = `
const fs = require('node:fs'), path = require('node:path')
const read = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null)
require('node:readline').createInterface({ input: process.stdin }).on('line', (l) => {
  if (JSON.parse(l).type !== 'prompt') return
  const dir = path.join(process.env.HOME, '.pi', 'agent')
  fs.writeFileSync(process.env.PROBE, JSON.stringify({
    home: process.env.HOME, agentDir: process.env.PI_CODING_AGENT_DIR,
    mcp: read(path.join(dir, 'mcp.json')), auth: read(path.join(dir, 'auth.json')),
  }))
  process.stdout.write(JSON.stringify({ type: 'response', command: 'prompt', success: true, data: { disposition: 'started' } }) + '\\n')
  process.stdout.write(JSON.stringify({ type: 'agent_settled' }) + '\\n')
}).on('close', () => process.exit(0))
`

describe('pi eval mode', () => {
  let realHome, savedHome, bin
  before(() => {
    const d = tmp()
    bin = join(d, 'pi')
    writeFileSync(join(d, 'fake.cjs'), FAKE)
    writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${join(d, 'fake.cjs')}" "$@"\n`)
    chmodSync(bin, 0o755)
    // The owner's real ~/.pi/agent: production Fermi and a login.
    realHome = tmp()
    mkdirSync(join(realHome, '.pi', 'agent'), { recursive: true })
    writeFileSync(join(realHome, '.pi', 'agent', 'mcp.json'), JSON.stringify({ mcpServers: { fermi: { url: PROD } } }))
    writeFileSync(join(realHome, '.pi', 'agent', 'auth.json'), '{"anthropic":{"type":"oauth","access":"tok"}}')
    savedHome = process.env.HOME
    process.env.HOME = realHome
  })
  after(() => {
    process.env.HOME = savedHome
  })

  test('pi runs with HOME=<sandboxHome> and sees only the localhost eval worker', async () => {
    const sandboxHome = tmp()
    const probe = join(tmp(), 'probe.json')
    const cfg = join(tmp(), 'mcp.json')
    writeFileSync(cfg, JSON.stringify(LOCAL))
    const { done } = runOnce({ bin, prompt: 'go', mcpConfig: cfg, sandboxHome, env: { PROBE: probe, HOME: realHome } })
    const res = await done
    assert.equal(res.outcome?.ok, true)
    const seen = JSON.parse(readFileSync(probe, 'utf8'))
    assert.equal(seen.home, sandboxHome)
    assert.equal(seen.agentDir, join(sandboxHome, '.pi', 'agent'))
    assert.deepEqual(JSON.parse(seen.mcp), { mcpServers: { fermi: { url: 'http://127.0.0.1:4100/mcp' } } })
    assert.doesNotMatch(seen.mcp, /fermi\.example\.com/)
    assert.match(seen.auth, /"oauth"/) // the login was copied in for the attempt
  })

  test('the sandbox auth.json is removed after the attempt', async () => {
    const sandboxHome = tmp()
    const { done } = runOnce({ bin, prompt: 'go', mcpConfig: LOCAL, sandboxHome, env: { PROBE: join(tmp(), 'p.json') } })
    await done
    assert.equal(existsSync(join(sandboxHome, '.pi', 'agent', 'auth.json')), false)
    assert.equal(existsSync(join(realHome, '.pi', 'agent', 'auth.json')), true) // the real one is untouched
  })

  test('a non-localhost or url-less MCP server refuses to start', () => {
    const sandboxHome = tmp()
    const probe = join(tmp(), 'p.json')
    assert.throws(
      () => runOnce({ bin, prompt: 'go', mcpConfig: { mcpServers: { fermi: { type: 'http', url: PROD } } }, sandboxHome, env: { PROBE: probe } }),
      /^Error: refusing to start: non-localhost/,
    )
    assert.throws(() => piMcpConfig({ mcpServers: { x: { command: 'npx' } } }), /^Error: refusing to start: non-localhost/)
    assert.throws(() => piMcpConfig({ mcpServers: { x: { url: 'http://localhost.evil.com/mcp' } } }), /refusing to start: non-localhost/)
    assert.equal(existsSync(probe), false)
    assert.equal(existsSync(join(sandboxHome, '.pi', 'agent', 'auth.json')), false)
  })

  test('mcpConfig without sandboxHome is refused', () => {
    assert.throws(() => runOnce({ bin, prompt: 'go', mcpConfig: LOCAL }), /^Error: mcpConfig without sandboxHome/)
  })

  test('piMcpConfig accepts a path, a JSON string or an object', () => {
    const want = { mcpServers: { fermi: { url: 'http://127.0.0.1:4100/mcp' } } }
    const f = join(tmp(), 'm.json')
    writeFileSync(f, JSON.stringify(LOCAL))
    assert.deepEqual(piMcpConfig(f), want)
    assert.deepEqual(piMcpConfig(JSON.stringify(LOCAL)), want)
    assert.deepEqual(piMcpConfig(LOCAL), want)
  })
})
