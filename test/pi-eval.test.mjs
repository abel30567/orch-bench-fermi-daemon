// pi adapter eval mode (harness/pi.mjs): a sandboxed HOME that holds only the
// localhost eval worker, never the owner's real ~/.pi/agent config.
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { piMcpConfig, runOnce, startSession } from '../harness/pi.mjs'

const fake = join(dirname(fileURLToPath(import.meta.url)), 'conformance/fake-pi.mjs')
const PROD = 'https://fermi.example.com/mcp'
const LOCAL = 'http://127.0.0.1:48123/mcp'

describe('pi eval mode', () => {
  let root, bin, realHome, realMcp
  const saved = { HOME: process.env.HOME, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR }
  before(() => {
    root = mkdtempSync(join(tmpdir(), 'pi-eval-'))
    bin = join(root, 'pi')
    writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${fake}" "$@"\n`)
    chmodSync(bin, 0o755)
    // The owner's real config: production Fermi and a login.
    realHome = join(root, 'real-home')
    const agent = join(realHome, '.pi/agent')
    mkdirSync(agent, { recursive: true })
    realMcp = join(agent, 'mcp.json')
    writeFileSync(realMcp, JSON.stringify({ mcpServers: { fermi: { url: PROD } } }))
    chmodSync(realMcp, 0o000) // any read of it would throw
    writeFileSync(join(agent, 'auth.json'), '{"anthropic":{"type":"oauth","access":"real"}}')
    process.env.HOME = realHome
    process.env.PI_CODING_AGENT_DIR = agent
  })
  after(() => {
    for (const [k, v] of Object.entries(saved)) v == null ? delete process.env[k] : (process.env[k] = v)
    rmSync(root, { recursive: true, force: true })
  })

  const attempt = (name) => {
    const dir = mkdtempSync(join(root, 'attempt-'))
    const sandboxHome = mkdtempSync(join(root, 'home-'))
    const mcpConfig = join(dir, 'mcp.json')
    writeFileSync(mcpConfig, JSON.stringify({ mcpServers: { fermi: { type: 'http', url: LOCAL } } }))
    return { dir, sandboxHome, opts: { bin, cwd: dir, env: { FAKE_DIR: dir }, mcpConfig, sandboxHome, prompt: name } }
  }

  test('pi runs with HOME=<sandboxHome> and an mcp.json holding only the eval worker', async () => {
    const { dir, sandboxHome, opts } = attempt('home')
    const { outcome } = await runOnce(opts).done
    assert.equal(outcome?.ok, true)
    const seen = JSON.parse(readFileSync(join(dir, 'home.json'), 'utf8'))
    assert.equal(seen.HOME, sandboxHome)
    assert.equal(seen.agentDir, join(sandboxHome, '.pi/agent'))
    assert.deepEqual(seen.mcp, { mcpServers: { fermi: { url: LOCAL } } })
    assert.equal(seen.auth, true, 'the login is available to pi during the attempt')
    assert.doesNotMatch(JSON.stringify(seen), /fermi\.example\.com/)
  })

  test('the sandbox auth.json is removed after the attempt', async () => {
    const { sandboxHome, opts } = attempt('turn')
    const auth = join(sandboxHome, '.pi/agent/auth.json')
    const run = runOnce(opts)
    assert.equal(existsSync(auth), true)
    await run.done
    assert.equal(existsSync(auth), false)
    assert.equal(existsSync(join(realHome, '.pi/agent/auth.json')), true, 'the real login is untouched')
  })

  test('a killed session also removes the sandbox auth.json', async () => {
    const { sandboxHome, opts } = attempt('hang')
    const s = startSession(opts)
    s.send('hang')
    const closed = new Promise((r) => s.events.on('exit', () => setImmediate(r)))
    s.close('SIGKILL')
    await closed
    await new Promise((r) => setTimeout(r, 50)) // 'close' follows 'exit' once stdio drains
    assert.equal(existsSync(join(sandboxHome, '.pi/agent/auth.json')), false)
  })

  test('a non-localhost URL in the MCP config refuses to start', () => {
    const { sandboxHome, opts } = attempt('turn')
    const config = { mcpServers: { local: { type: 'http', url: LOCAL }, fermi: { type: 'http', url: PROD } } }
    assert.throws(() => runOnce({ ...opts, mcpConfig: config }), /refusing to start: non-localhost .*fermi\.example\.com/)
    assert.equal(existsSync(join(sandboxHome, '.pi/agent/auth.json')), false, 'nothing copied before refusing')
  })

  test('piMcpConfig keeps localhost URL servers and refuses remote or url-less ones', () => {
    assert.deepEqual(piMcpConfig({ mcpServers: { fermi: { type: 'http', url: LOCAL, headers: { a: 'b' } } } }), {
      mcpServers: { fermi: { url: LOCAL, headers: { a: 'b' } } },
    })
    assert.throws(() => piMcpConfig({ mcpServers: { x: { url: PROD } } }), /refusing to start: non-localhost/)
    assert.throws(() => piMcpConfig({ mcpServers: { x: { command: 'npx' } } }), /refusing to start: non-localhost/)
  })

  test('mcpConfig without sandboxHome is refused', () => {
    const { opts } = attempt('turn')
    assert.throws(() => runOnce({ ...opts, sandboxHome: undefined }), /mcpConfig without sandboxHome/)
  })
})
