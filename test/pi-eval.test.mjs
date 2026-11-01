// pi adapter eval mode: a sandboxed HOME whose mcp.json holds only the local eval worker.
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ROOT } from './run-worker.mjs'
import * as pi from '../harness/pi.mjs'
import { runAttempt } from '../evals/lib/runner.mjs'
import { loadScenario } from '../evals/lib/scenario.mjs'

const tmp = () => mkdtempSync(join(tmpdir(), 'dmn-pi-eval-'))
const LOCAL = { mcpServers: { fermi: { type: 'http', url: 'http://127.0.0.1:8787/mcp' } } }
const PROD = 'https://fermi.example.com/mcp'

// Fake pi: on its prompt, records what it sees of HOME and its agent dir, then
// reports the prompt as handled (a turn_end without a run). Exits when stdin closes.
const FAKE = `
const fs = require('node:fs'), path = require('node:path')
const dir = process.env.PI_CODING_AGENT_DIR
require('node:readline').createInterface({ input: process.stdin })
  .on('line', () => {
    fs.writeFileSync(process.env.FAKE_OUT, JSON.stringify({
      home: process.env.HOME,
      agentDir: dir,
      mcp: JSON.parse(fs.readFileSync(path.join(process.env.HOME, '.pi/agent/mcp.json'), 'utf8')),
      auth: fs.existsSync(path.join(dir, 'auth.json')) ? fs.readFileSync(path.join(dir, 'auth.json'), 'utf8') : null,
    }))
    process.stdout.write(JSON.stringify({ type: 'response', command: 'prompt', success: true, data: { disposition: 'handled' } }) + '\\n')
  })
  .on('close', () => process.exit(0))
`

let realHome, bin, out, realHomeBefore
before(() => {
  const dir = tmp()
  bin = join(dir, 'pi')
  writeFileSync(join(dir, 'fake-pi.cjs'), FAKE)
  writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${join(dir, 'fake-pi.cjs')}" "$@"\n`)
  chmodSync(bin, 0o755)
  out = join(dir, 'seen.json')
  // The owner's real ~/.pi/agent: mcp.json points at production and is unreadable,
  // so any read of it (by the adapter or the child) fails the test.
  realHome = tmp()
  mkdirSync(join(realHome, '.pi/agent'), { recursive: true })
  writeFileSync(join(realHome, '.pi/agent/mcp.json'), JSON.stringify({ mcpServers: { fermi: { url: PROD } } }))
  chmodSync(join(realHome, '.pi/agent/mcp.json'), 0o000)
  writeFileSync(join(realHome, '.pi/agent/auth.json'), '{"anthropic":{"type":"oauth","access":"tok"}}')
  realHomeBefore = process.env.HOME
  process.env.HOME = realHome
})
after(() => {
  process.env.HOME = realHomeBefore
})

describe('pi eval mode', () => {
  test('piMcpConfig keeps only url (and headers) of localhost servers', () => {
    assert.deepEqual(pi.piMcpConfig(LOCAL), { mcpServers: { fermi: { url: 'http://127.0.0.1:8787/mcp' } } })
    assert.deepEqual(pi.piMcpConfig(JSON.stringify(LOCAL)), { mcpServers: { fermi: { url: 'http://127.0.0.1:8787/mcp' } } })
    const f = join(tmp(), 'mcp.json')
    writeFileSync(f, JSON.stringify({ mcpServers: { a: { url: 'http://localhost:1/mcp', headers: { x: '1' } } } }))
    assert.deepEqual(pi.piMcpConfig(f), { mcpServers: { a: { url: 'http://localhost:1/mcp', headers: { x: '1' } } } })
  })

  test('AC1: pi runs with HOME=<sandboxHome> and an mcp.json holding only the eval worker; the real one is never read', async () => {
    const sandboxHome = tmp()
    const { code, outcome } = await pi.runOnce({ bin, prompt: 'x', mcpConfig: LOCAL, sandboxHome, env: { FAKE_OUT: out, HOME: '/elsewhere' } }).done
    assert.equal(code, 0)
    assert.equal(outcome?.type, 'turn_end')
    const seen = JSON.parse(readFileSync(out, 'utf8'))
    assert.equal(seen.home, sandboxHome)
    assert.equal(seen.agentDir, join(sandboxHome, '.pi/agent'))
    assert.deepEqual(seen.mcp, { mcpServers: { fermi: { url: 'http://127.0.0.1:8787/mcp' } } })
    assert.ok(!JSON.stringify(seen.mcp).includes('fermi.example.com'))
  })

  test('AC2: auth.json is copied in for the login and removed after the attempt', async () => {
    const sandboxHome = tmp()
    await pi.runOnce({ bin, prompt: 'x', mcpConfig: LOCAL, sandboxHome, env: { FAKE_OUT: out } }).done
    assert.equal(JSON.parse(readFileSync(out, 'utf8')).auth, readFileSync(join(realHome, '.pi/agent/auth.json'), 'utf8'))
    assert.equal(existsSync(join(sandboxHome, '.pi/agent/auth.json')), false)
    assert.equal(existsSync(join(sandboxHome, '.pi/agent/mcp.json')), true)
  })

  test('AC2: a killed session removes auth.json too', async () => {
    const sandboxHome = tmp()
    const s = pi.startSession({ bin, mcpConfig: LOCAL, sandboxHome, env: { FAKE_OUT: out } })
    assert.equal(existsSync(join(sandboxHome, '.pi/agent/auth.json')), true)
    const exited = new Promise((r) => s.events.on('exit', r))
    s.close('SIGKILL')
    await exited
    assert.equal(existsSync(join(sandboxHome, '.pi/agent/auth.json')), false)
  })

  test('AC3: a non-localhost or url-less MCP server refuses to start', () => {
    for (const server of [{ url: PROD }, { url: 'http://127.0.0.1.example.com/mcp' }, { command: 'npx', args: ['fermi'] }]) {
      const sandboxHome = tmp()
      const cfg = { mcpServers: { ...LOCAL.mcpServers, other: server } }
      assert.throws(() => pi.runOnce({ bin, prompt: 'x', mcpConfig: cfg, sandboxHome }), /^Error: refusing to start: non-localhost/)
      assert.equal(existsSync(join(sandboxHome, '.pi/agent/mcp.json')), false)
      assert.equal(existsSync(join(sandboxHome, '.pi/agent/auth.json')), false)
    }
  })

  test('mcpConfig without sandboxHome is refused', () => {
    assert.throws(() => pi.runOnce({ bin, prompt: 'x', mcpConfig: LOCAL }), /^Error: mcpConfig without sandboxHome/)
    assert.throws(() => pi.startSession({ bin, mcpConfig: LOCAL }), /^Error: mcpConfig without sandboxHome/)
  })

  test('the eval runner gives pi a temp sandboxHome with the eval worker and removes it after the attempt', async () => {
    let seen
    const harness = {
      name: 'pi',
      runOnce(o) {
        seen = o
        return pi.runOnce({ ...o, bin, env: { ...o.env, FAKE_OUT: out } })
      },
    }
    const scenario = loadScenario(join(ROOT, 'evals/scenarios/examples/reply-contract.json'))
    await runAttempt({ scenario, attempt: 1, harness, timeoutMs: 10_000, outDir: tmp() })
    assert.ok(seen?.sandboxHome, 'runner passed sandboxHome')
    const s = JSON.parse(readFileSync(out, 'utf8'))
    assert.equal(s.home, seen.sandboxHome)
    assert.deepEqual(Object.keys(s.mcp.mcpServers), ['fermi'])
    assert.match(s.mcp.mcpServers.fermi.url, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/)
    assert.equal(existsSync(seen.sandboxHome), false)
  })
})
