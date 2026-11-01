// The conformance suite (./suite.mjs) for the pi adapter, against ./fake-pi.mjs.
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { after, before, describe, test } from 'node:test'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runConformance } from './suite.mjs'

const bin = join(mkdtempSync(join(tmpdir(), 'dmn5-bin-')), 'pi')
const fake = join(dirname(fileURLToPath(import.meta.url)), 'fake-pi.mjs')
writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${fake}" "$@"\n`)
chmodSync(bin, 0o755)

runConformance(() => import('../../harness/pi.mjs'), { name: 'pi', options: { bin } }, {
  expectedFail: {
    tool_names:
      "pi's built-in shell tool is `bash`, not `Bash`; the contract keeps name = bareToolName(rawName), so it stays `bash` (MCP prefixes are stripped)",
    credential_isolation:
      'SWAP-GATE BLOCKER: pi takes its credential only from argv, env (inherited by its bash tool) or auth.json (readable by its tools); no fd handoff, so the adapter refuses tokenFd (see harness/pi.mjs)',
  },
})

// Eval mode: mcpConfig + sandboxHome (see harness/pi.mjs).
describe('pi eval mode', () => {
  const tmp = (p) => mkdtempSync(join(tmpdir(), `dmn-pi-${p}-`))
  const realHome = tmp('real')
  const realAgent = join(realHome, '.pi', 'agent')
  mkdirSync(realAgent, { recursive: true })
  writeFileSync(join(realAgent, 'mcp.json'), JSON.stringify({ mcpServers: { fermi: { url: 'https://fermi.example.com/mcp' } } }))
  writeFileSync(join(realAgent, 'auth.json'), '{"anthropic":{"type":"oauth","access":"real-token"}}')
  const evalConfig = { mcpServers: { fermi: { type: 'http', url: 'http://127.0.0.1:4321/mcp' } } }
  let savedHome
  before(() => {
    savedHome = process.env.HOME
    process.env.HOME = realHome
  })
  after(() => {
    process.env.HOME = savedHome
  })

  async function attempt(mcpConfig) {
    const pi = await import('../../harness/pi.mjs')
    const fakeDir = tmp('fake')
    const sandboxHome = tmp('home')
    const r = pi.runOnce({ bin, prompt: 'sandbox', cwd: fakeDir, env: { FAKE_DIR: fakeDir }, mcpConfig, sandboxHome })
    const res = await r.done
    return { res, sandboxHome, seen: JSON.parse(readFileSync(join(fakeDir, 'agent-dir.json'), 'utf8')) }
  }

  test('pi runs with HOME=<sandboxHome> and sees only the localhost eval worker', async () => {
    const file = join(tmp('cfg'), 'mcp.json')
    writeFileSync(file, JSON.stringify(evalConfig))
    const { res, sandboxHome, seen } = await attempt(file)
    assert.equal(res.outcome?.ok, true)
    assert.equal(seen.home, sandboxHome)
    assert.equal(seen.agentDir, join(sandboxHome, '.pi', 'agent'))
    assert.deepEqual(seen.mcp, { mcpServers: { fermi: { url: 'http://127.0.0.1:4321/mcp' } } })
    assert.doesNotMatch(JSON.stringify(seen), /fermi\.example\.com/)
    // pi logs in from the sandbox copy of the real auth.json
    assert.match(seen.auth, /real-token/)
  })

  test('the sandbox auth.json is removed after the attempt', async () => {
    const { sandboxHome, seen } = await attempt(evalConfig)
    assert.ok(seen.auth)
    assert.equal(existsSync(join(sandboxHome, '.pi', 'agent', 'auth.json')), false)
    assert.equal(existsSync(join(realAgent, 'auth.json')), true) // the real one is untouched
  })

  test('a non-localhost or url-less MCP server refuses to start', async () => {
    const pi = await import('../../harness/pi.mjs')
    const sandboxHome = tmp('home')
    for (const s of [{ url: 'https://fermi.example.com/mcp' }, { url: 'http://127.0.0.1.example.com/mcp' }, { command: 'fermi-mcp' }]) {
      const mcpConfig = { mcpServers: { fermi: s } }
      assert.throws(() => pi.piMcpConfig(mcpConfig), /^Error: refusing to start: non-localhost/)
      assert.throws(() => pi.runOnce({ bin, prompt: 'turn', mcpConfig, sandboxHome }), /refusing to start: non-localhost/)
    }
    assert.equal(existsSync(join(sandboxHome, '.pi')), false)
  })

  test('mcpConfig without sandboxHome is refused', async () => {
    const pi = await import('../../harness/pi.mjs')
    assert.throws(() => pi.runOnce({ bin, prompt: 'turn', mcpConfig: evalConfig }), /^Error: mcpConfig without sandboxHome/)
  })
})
