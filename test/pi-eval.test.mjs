// pi adapter eval mode: HOME is a sandbox whose .pi/agent/mcp.json holds only
// the local eval worker; the real ~/.pi/agent is never used except for auth.json,
// whose sandbox copy is removed when the attempt ends.
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ROOT } from './run-worker.mjs'
import { piMcpConfig, runOnce, startSession } from '../harness/pi.mjs'
import { runAttempt } from '../evals/lib/runner.mjs'
import * as fake from '../evals/harness/fake.mjs'

const tmp = () => mkdtempSync(join(tmpdir(), 'dmn-pi-eval-'))
const FAKE_PI = join(ROOT, 'test/conformance/fake-pi.mjs')
const PROD = 'https://fermi.example.com/mcp'
const LOCAL = 'http://127.0.0.1:4567/mcp'
const AUTH = JSON.stringify({ anthropic: { type: 'oauth', access: 'sk-ant-oat-real', refresh: 'r', expires: 1 } })

const bin = join(tmp(), 'pi')
writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${FAKE_PI}" "$@"\n`)
chmodSync(bin, 0o755)

// A real $HOME whose pi config points at production Fermi.
let realHome
let savedHome
before(() => {
  realHome = tmp()
  mkdirSync(join(realHome, '.pi/agent'), { recursive: true })
  writeFileSync(join(realHome, '.pi/agent/mcp.json'), JSON.stringify({ mcpServers: { fermi: { url: PROD } } }))
  writeFileSync(join(realHome, '.pi/agent/auth.json'), AUTH)
  chmodSync(join(realHome, '.pi/agent/mcp.json'), 0) // reading it would throw (unless root)
  savedHome = process.env.HOME
  process.env.HOME = realHome
})
after(() => {
  process.env.HOME = savedHome
})

const evalOpts = (extra = {}) => {
  const cwd = tmp()
  const sandboxHome = tmp()
  const mcpConfig = join(cwd, 'mcp.json')
  writeFileSync(mcpConfig, JSON.stringify({ mcpServers: { fermi: { type: 'http', url: LOCAL } } }))
  return { bin, model: 'm', cwd, sandboxHome, mcpConfig, env: { FAKE_DIR: cwd }, ...extra }
}

describe('pi eval mode', () => {
  test('AC1: pi runs with HOME=<sandboxHome>; its mcp.json holds only the localhost eval worker', async () => {
    const o = evalOpts()
    const r = await runOnce({ ...o, prompt: 'pi-home' }).done
    assert.equal(r.outcome?.ok, true, r.stderr)
    const seen = JSON.parse(readFileSync(join(o.cwd, 'pi-home.json'), 'utf8'))
    assert.equal(seen.home, o.sandboxHome)
    assert.equal(seen.agentDir, join(o.sandboxHome, '.pi/agent'))
    const expected = { mcpServers: { fermi: { url: LOCAL } } }
    assert.deepEqual(JSON.parse(seen.mcp), expected)
    assert.deepEqual(JSON.parse(seen.homeMcp), expected) // $HOME/.pi/agent is the sandbox too
    assert.equal(seen.auth, AUTH, 'pi can log in during the attempt')
    assert.doesNotMatch(JSON.stringify(seen), /fermi\.example\.com/)
  })

  test('AC2: the sandbox auth.json is removed after the attempt (runOnce and session)', async () => {
    const o = evalOpts()
    const auth = join(o.sandboxHome, '.pi/agent/auth.json')
    await runOnce({ ...o, prompt: 'turn' }).done
    assert.equal(existsSync(auth), false)
    assert.equal(existsSync(join(realHome, '.pi/agent/auth.json')), true, 'the real auth.json is left alone')

    const s = evalOpts()
    const sAuth = join(s.sandboxHome, '.pi/agent/auth.json')
    const session = startSession(s)
    assert.equal(readFileSync(sAuth, 'utf8'), AUTH)
    const closed = new Promise((r) => session.events.once('exit', r))
    session.close('SIGTERM')
    await closed
    await new Promise((r) => setTimeout(r, 50)) // 'close' follows 'exit'
    assert.equal(existsSync(sAuth), false)
  })

  test('AC3: a non-localhost or url-less MCP server refuses to start, before anything is written', () => {
    for (const server of [{ type: 'http', url: PROD }, { type: 'http', url: 'http://localhost.evil.com/mcp' }, { command: 'npx' }]) {
      const o = evalOpts({ mcpConfig: { mcpServers: { fermi: { type: 'http', url: LOCAL }, other: server } } })
      assert.throws(() => runOnce({ ...o, prompt: 'turn' }), /refusing to start: non-localhost/)
      assert.equal(existsSync(join(o.sandboxHome, '.pi')), false)
    }
    assert.throws(() => piMcpConfig({ mcpServers: { fermi: { url: LOCAL, headers: { referer: PROD } } } }), /refusing to start: non-localhost.*fermi\.example\.com/)
  })

  test('mcpConfig without sandboxHome is refused', () => {
    const { sandboxHome, ...o } = evalOpts()
    assert.throws(() => runOnce({ ...o, prompt: 'turn' }), /mcpConfig without sandboxHome/)
  })

  test('piMcpConfig keeps url and headers only', () => {
    assert.deepEqual(piMcpConfig({ mcpServers: { fermi: { type: 'http', url: LOCAL, headers: { a: 'b' } } } }), {
      mcpServers: { fermi: { url: LOCAL, headers: { a: 'b' } } },
    })
  })

  test('the eval runner gives pi a temporary sandboxHome and removes it after the attempt', async () => {
    let seen
    let during
    const spy = { name: 'pi', runOnce: (o) => ((seen = o), (during = existsSync(o.sandboxHome)), fake.runOnce(o)) }
    const r = await runAttempt({
      scenario: {
        name: 'unit',
        fixtures: { bindings: [{ channel: 'sl', sender_id: 'U0EVALOWNER' }] },
        inbound: { channel: 'sl', sender: 'U0EVALOWNER', chat: 'D0EVAL', text: 'hi' },
        expect: [],
        fake: { script: [{ tool: 'task_claim', args: { limit: 1, stale_minutes: 25 } }] },
      },
      attempt: 1,
      harness: spy,
      timeoutMs: 10_000,
      outDir: tmp(),
    })
    assert.equal(r.pass, true, JSON.stringify(r.failed))
    assert.ok(seen.sandboxHome, 'sandboxHome passed')
    assert.notEqual(seen.sandboxHome, realHome)
    assert.equal(during, true)
    assert.equal(existsSync(seen.sandboxHome), false)
  })

  test('other harnesses get no sandboxHome', async () => {
    let seen
    const spy = { name: 'claude-code', runOnce: (o) => ((seen = o), fake.runOnce(o)) }
    await runAttempt({
      scenario: { name: 'unit', inbound: { channel: 'sl', sender: 'U0EVALOWNER', chat: 'D0EVAL', text: 'hi' }, expect: [], fake: { script: [] } },
      attempt: 1,
      harness: spy,
      timeoutMs: 10_000,
      outDir: tmp(),
    })
    assert.equal(seen.sandboxHome, undefined)
  })
})
