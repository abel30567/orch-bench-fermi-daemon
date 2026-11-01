// pi adapter eval mode (harness/pi.mjs): a sandbox HOME whose mcp.json holds only
// the localhost eval worker, a sandbox auth.json removed after the attempt, and a
// refusal to start on any non-localhost MCP server. Runs against the fake pi.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ROOT } from './run-worker.mjs'
import * as pi from '../harness/pi.mjs'
import { runAttempt } from '../evals/lib/runner.mjs'
import { loadScenario } from '../evals/lib/scenario.mjs'

const tmp = () => mkdtempSync(join(tmpdir(), 'dmn-pi-eval-'))
const bin = join(tmp(), 'pi')
writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${join(ROOT, 'test/conformance/fake-pi.mjs')}" "$@"\n`)
chmodSync(bin, 0o755)

const readdir = (d) => readdirSync(join(ROOT, d)).filter((f) => f.endsWith('.json') && !f.includes('negative'))[0]

const EVAL_URL = 'http://127.0.0.1:41234/mcp'
const PROD_URL = 'https://fermi.example.com/mcp'
const AUTH = '{"anthropic":{"type":"oauth","access":"sk-ant-oat01-fake"}}'

// A real HOME as the owner has it: ~/.pi/agent/mcp.json → production Fermi, plus auth.json.
function realHome() {
  const home = tmp()
  mkdirSync(join(home, '.pi/agent'), { recursive: true })
  writeFileSync(join(home, '.pi/agent/mcp.json'), JSON.stringify({ mcpServers: { fermi: { url: PROD_URL } } }))
  writeFileSync(join(home, '.pi/agent/auth.json'), AUTH)
  return home
}

function evalRun(extra = {}) {
  const cwd = tmp()
  const home = realHome()
  const sandboxHome = tmp()
  const mcpConfig = join(cwd, 'mcp.json')
  writeFileSync(mcpConfig, JSON.stringify({ mcpServers: { fermi: { type: 'http', url: EVAL_URL } } }))
  const o = { bin, cwd, prompt: 'agent-dir', mcpConfig, sandboxHome, realHome: home, env: { FAKE_DIR: cwd, HOME: home }, ...extra }
  return { o, cwd, home, sandboxHome }
}

describe('pi adapter eval mode', () => {
  test('piMcpConfig translates the runner config to pi mcp.json', () => {
    assert.deepEqual(pi.piMcpConfig({ mcpServers: { fermi: { type: 'http', url: EVAL_URL, headers: { a: 'b' } } } }), {
      mcpServers: { fermi: { url: EVAL_URL, headers: { a: 'b' } } },
    })
    assert.deepEqual(pi.piMcpConfig({ mcpServers: {} }), { mcpServers: {} })
  })

  test('pi runs with HOME=<sandboxHome> and sees only the localhost eval worker; the real mcp.json is never read', async () => {
    const { o, cwd, home, sandboxHome } = evalRun()
    const { outcome } = await pi.runOnce(o).done
    assert.equal(outcome?.ok, true)
    const seen = JSON.parse(readFileSync(join(cwd, 'agent-dir.json'), 'utf8'))
    assert.equal(seen.home, sandboxHome)
    assert.equal(seen.agentDir, join(sandboxHome, '.pi/agent'))
    assert.deepEqual(JSON.parse(seen.mcp), { mcpServers: { fermi: { url: EVAL_URL } } })
    assert.ok(!seen.mcp.includes(PROD_URL))
    assert.equal(seen.auth, AUTH, 'pi can log in from the sandbox auth.json')
    assert.ok(!JSON.stringify(seen).includes(home), 'nothing under the real HOME was resolved')
    // Without PI_CODING_AGENT_DIR pi would resolve $HOME/.pi/agent: also the sandbox.
    assert.ok(existsSync(join(sandboxHome, '.pi/agent/mcp.json')))
  })

  test('the sandbox auth.json is removed after the attempt (runOnce and startSession)', async () => {
    const a = evalRun()
    await pi.runOnce(a.o).done
    assert.ok(!existsSync(join(a.sandboxHome, '.pi/agent/auth.json')))
    assert.ok(existsSync(join(a.home, '.pi/agent/auth.json')), 'the real auth.json is untouched')

    const b = evalRun()
    const s = pi.startSession(b.o)
    assert.ok(existsSync(join(b.sandboxHome, '.pi/agent/auth.json')))
    const exited = new Promise((r) => s.events.on('exit', r))
    s.close('SIGKILL')
    await exited
    await new Promise((r) => setImmediate(r))
    assert.ok(!existsSync(join(b.sandboxHome, '.pi/agent/auth.json')))
  })

  test('a non-localhost or url-less MCP server refuses to start', () => {
    for (const server of [{ type: 'http', url: PROD_URL }, { type: 'http', url: 'http://10.0.0.5/mcp' }, { command: 'npx', args: ['x'] }]) {
      const { o, sandboxHome } = evalRun({ mcpConfig: { mcpServers: { eval: { type: 'http', url: EVAL_URL }, other: server } } })
      assert.throws(() => pi.runOnce(o), /refusing to start: non-localhost/)
      assert.throws(() => pi.startSession(o), /refusing to start: non-localhost/)
      assert.ok(!existsSync(join(sandboxHome, '.pi/agent/mcp.json')), 'nothing written')
      assert.ok(!existsSync(join(sandboxHome, '.pi/agent/auth.json')), 'no credential copied')
    }
    assert.throws(() => pi.piMcpConfig({ mcpServers: { fermi: { url: PROD_URL } } }), /refusing to start: non-localhost/)
  })

  test('mcpConfig without sandboxHome refuses to start', () => {
    const { o } = evalRun({ sandboxHome: undefined })
    assert.throws(() => pi.runOnce(o), /mcpConfig without sandboxHome/)
  })

  test('the eval runner gives pi a sandbox HOME, removed after the attempt', async () => {
    let seen
    const spy = {
      name: 'pi',
      runOnce: (o) => {
        seen = { sandboxHome: o.sandboxHome, existed: existsSync(o.sandboxHome) }
        return pi.runOnce({ ...o, bin, prompt: 'turn' })
      },
      startSession: (o) => {
        seen = { sandboxHome: o.sandboxHome, existed: existsSync(o.sandboxHome) }
        return pi.startSession({ ...o, bin })
      },
    }
    const scenario = loadScenario(join(ROOT, 'evals/scenarios/core', readdir('evals/scenarios/core')))
    await runAttempt({ scenario, attempt: 1, harness: spy, timeoutMs: 10_000, outDir: tmp() })
    assert.ok(seen?.sandboxHome, 'sandboxHome passed')
    assert.equal(seen.existed, true)
    assert.ok(!seen.sandboxHome.startsWith(process.env.HOME + '/'), 'not under the real HOME')
    assert.ok(!existsSync(seen.sandboxHome), 'sandbox removed')
  })
})
