// The pi adapter's eval mode, against ./fixtures/fake-pi-probe.mjs. This process's
// HOME is a throwaway, so the real ~/.pi is never in reach.
import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ROOT } from './run-worker.mjs'
import * as pi from '../harness/pi.mjs'
import { runAttempt } from '../evals/lib/runner.mjs'
import { loadScenario } from '../evals/lib/scenario.mjs'

const { piMcpConfig, runOnce, startSession } = pi
const tmp = () => mkdtempSync(join(tmpdir(), 'pi-eval-'))
const EVAL_URL = 'http://127.0.0.1:43210/mcp'
const PROD_URL = 'https://fermi.example.workers.dev/mcp'
const evalConfig = { mcpServers: { fermi: { type: 'http', url: EVAL_URL } } }
const REAL_AUTH = '{"anthropic":{"type":"oauth","refresh":"fake-refresh"}}'

const bin = join(tmp(), 'pi')
writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${join(ROOT, 'test/fixtures/fake-pi-probe.mjs')}" "$@"\n`)
chmodSync(bin, 0o755)

let home, sandboxHome, probeFile, realAgentDir
beforeEach(() => {
  home = tmp()
  sandboxHome = join(tmp(), 'home')
  probeFile = join(tmp(), 'probe.json')
  realAgentDir = join(home, '.pi/agent')
  mkdirSync(realAgentDir, { recursive: true })
  writeFileSync(join(realAgentDir, 'mcp.json'), JSON.stringify({ mcpServers: { fermi: { url: PROD_URL } } }))
  writeFileSync(join(realAgentDir, 'auth.json'), REAL_AUTH)
  process.env.HOME = home
  process.env.PROBE_FILE = probeFile
  delete process.env.PI_CODING_AGENT_DIR
})
const probe = () => JSON.parse(readFileSync(probeFile, 'utf8'))
const sandboxFile = (name) => join(sandboxHome, '.pi/agent', name)
const evalRun = (over = {}) => runOnce({ bin, prompt: 'go', mcpConfig: evalConfig, sandboxHome, ...over })

describe('piMcpConfig', () => {
  test('keeps only the url of each server, exposed directly', () => {
    const config = { mcpServers: { fermi: { type: 'http', url: EVAL_URL, headers: { Authorization: 'Bearer x' }, command: 'evil' } } }
    assert.deepEqual(piMcpConfig(config), { mcpServers: { fermi: { url: EVAL_URL, exposure: 'direct' } } })
  })

  test('accepts every localhost spelling', () => {
    for (const url of ['http://localhost:1/mcp', 'http://127.0.0.1:1/mcp', 'http://[::1]:1/mcp']) assert.equal(piMcpConfig({ mcpServers: { a: { url } } }).mcpServers.a.url, url)
  })

  test('refuses non-localhost, look-alike and url-less servers, even next to a local one', () => {
    for (const bad of [{ url: PROD_URL }, { url: 'http://127.0.0.1.example.com/mcp' }, { url: 'http://localhost@example.com/mcp' }, { url: 'not a url' }, { command: 'npx' }, null])
      assert.throws(() => piMcpConfig({ mcpServers: { fermi: { url: EVAL_URL }, other: bad } }), /refusing to start: non-localhost/, JSON.stringify(bad))
  })
})

describe('pi eval mode', () => {
  test('pi runs with HOME=<sandboxHome>, sees only the eval worker, never the real mcp.json', async () => {
    process.env.PI_CODING_AGENT_DIR = realAgentDir // an inherited agent dir must not win
    await evalRun({ env: { PI_CODING_AGENT_DIR: realAgentDir } }).done
    const p = probe()
    assert.equal(p.home, sandboxHome)
    assert.equal(p.agentDir, join(sandboxHome, '.pi/agent'))
    assert.deepEqual(JSON.parse(p.mcp), { mcpServers: { fermi: { url: EVAL_URL, exposure: 'direct' } } })
    assert.equal(JSON.parse(readFileSync(join(realAgentDir, 'mcp.json'), 'utf8')).mcpServers.fermi.url, PROD_URL, 'the real file is untouched')
  })

  test('mcpConfig may be a file path or JSON text', async () => {
    const file = join(tmp(), 'mcp.json')
    writeFileSync(file, JSON.stringify(evalConfig))
    for (const mcpConfig of [file, JSON.stringify(evalConfig)]) {
      await evalRun({ mcpConfig }).done
      assert.equal(JSON.parse(probe().mcp).mcpServers.fermi.url, EVAL_URL)
    }
  })

  test('sandboxHome alone still sandboxes, with no servers', async () => {
    await evalRun({ mcpConfig: undefined }).done
    assert.equal(probe().home, sandboxHome)
    assert.deepEqual(JSON.parse(probe().mcp), { mcpServers: {} })
  })

  test('the sandbox auth.json is a private copy during the run and gone after it; the real one stays', async () => {
    const { code } = await evalRun().done
    assert.equal(code, 0)
    assert.equal(probe().auth, REAL_AUTH)
    assert.equal(probe().authMode, 0o600)
    assert.equal(existsSync(sandboxFile('auth.json')), false)
    assert.equal(readFileSync(join(realAgentDir, 'auth.json'), 'utf8'), REAL_AUTH)
  })

  test('a killed run and a closed session remove it too', async () => {
    const run = evalRun()
    run.close('SIGKILL')
    await run.done
    assert.equal(existsSync(sandboxFile('auth.json')), false)
    const session = startSession({ bin, mcpConfig: evalConfig, sandboxHome })
    assert.equal(existsSync(sandboxFile('auth.json')), true)
    session.close('SIGTERM')
    await once(session.events, 'exit')
    assert.equal(existsSync(sandboxFile('auth.json')), false)
  })

  test('a pi that cannot start removes it and reports on stderr instead of crashing', async () => {
    const { code, stderr } = await evalRun({ bin: join(tmp(), 'no-such-pi') }).done
    assert.notEqual(code, 0)
    assert.match(stderr, /ENOENT/)
    assert.equal(existsSync(sandboxFile('auth.json')), false)
  })

  test('with no real auth.json pi still starts, logged out', async () => {
    await evalRun({ env: { HOME: tmp() } }).done
    assert.equal(probe().auth, null)
  })

  test('a non-localhost URL refuses to start: pi never runs and nothing is written', () => {
    assert.throws(() => evalRun({ mcpConfig: { mcpServers: { fermi: { url: PROD_URL } } } }), /refusing to start: non-localhost/)
    assert.equal(existsSync(probeFile), false)
    assert.equal(existsSync(sandboxHome), false)
  })

  test('mcpConfig without sandboxHome refuses to start', () => {
    assert.throws(() => runOnce({ bin, prompt: 'go', mcpConfig: evalConfig }), /mcpConfig without sandboxHome/)
    assert.equal(existsSync(probeFile), false)
  })

  test('a sandbox that is the real HOME, or links to its agent dir, refuses before touching a file', () => {
    assert.throws(() => evalRun({ sandboxHome: home }), /real pi agent dir/)
    mkdirSync(join(sandboxHome, '.pi'), { recursive: true })
    symlinkSync(realAgentDir, join(sandboxHome, '.pi/agent'))
    assert.throws(() => evalRun(), /real pi agent dir/)
    assert.equal(readFileSync(join(realAgentDir, 'auth.json'), 'utf8'), REAL_AUTH)
    assert.equal(JSON.parse(readFileSync(join(realAgentDir, 'mcp.json'), 'utf8')).mcpServers.fermi.url, PROD_URL)
    assert.equal(existsSync(probeFile), false)
  })

  test('outside eval mode nothing changes: real HOME, no agent dir override', async () => {
    await runOnce({ bin, prompt: 'go' }).done
    assert.equal(probe().home, home)
    assert.equal(probe().agentDir, undefined)
    assert.equal(JSON.parse(probe().mcp).mcpServers.fermi.url, PROD_URL)
  })
})

describe('the eval runner', () => {
  test('gives pi a sandbox outside the attempt dir, pointing at the local proxy, and removes it', async () => {
    const outDir = tmp()
    process.env.PI_BIN = bin
    process.env.TMPDIR = tmp()
    const examples = join(ROOT, 'evals/scenarios/examples')
    const scenario = loadScenario(join(examples, readdirSync(examples)[0]))
    await runAttempt({ scenario, attempt: 1, harness: pi, timeoutMs: 10_000, outDir })
    const p = probe()
    assert.ok(p.home.startsWith(process.env.TMPDIR), p.home)
    assert.equal(p.auth, REAL_AUTH)
    assert.match(JSON.parse(p.mcp).mcpServers.fermi.url, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/)
    assert.deepEqual(readdirSync(process.env.TMPDIR), [])
  })
})
