// DMN: pi adapter eval mode. pi runs under a sandbox HOME whose .pi/agent/mcp.json
// holds only the localhost eval worker; the real ~/.pi/agent is never used.
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runOnce, startSession, piMcpConfig } from '../harness/pi.mjs'
import { runAttempt } from '../evals/lib/runner.mjs'
import { loadScenario } from '../evals/lib/scenario.mjs'
import * as fake from '../evals/harness/fake.mjs'
import { ROOT } from './run-worker.mjs'

const tmp = () => mkdtempSync(join(tmpdir(), 'pi-eval-'))
const EVAL = { mcpServers: { fermi: { type: 'http', url: 'http://127.0.0.1:4567/mcp' } } }
const AUTH = '{"anthropic":{"type":"oauth","access":"sk-ant-oat-real"}}'

// A real HOME as the owner has it: mcp.json pointing at production (unreadable, so
// any read of it fails loudly) and the /login auth.json.
const realHome = tmp()
const realAgent = join(realHome, '.pi', 'agent')
mkdirSync(realAgent, { recursive: true })
writeFileSync(join(realAgent, 'mcp.json'), JSON.stringify({ mcpServers: { fermi: { url: 'https://fermi.example.com/mcp' } } }))
chmodSync(join(realAgent, 'mcp.json'), 0o000)
writeFileSync(join(realAgent, 'auth.json'), AUTH)
let savedHome
before(() => {
  savedHome = process.env.HOME
  process.env.HOME = realHome
})
after(() => {
  process.env.HOME = savedHome
})

// Fake pi: resolves its agent dir the way pi does (PI_CODING_AGENT_DIR, else
// ~/.pi/agent), records what it sees to $FAKE_DIR/seen.json, then answers each
// prompt with a settled run. Closing stdin exits.
const FAKE_PI = `
const fs = require('node:fs'), path = require('node:path'), os = require('node:os')
const dir = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), '.pi', 'agent')
let mcp
try { mcp = JSON.parse(fs.readFileSync(path.join(dir, 'mcp.json'), 'utf8')) } catch (e) { mcp = { error: e.code } }
const auth = path.join(dir, 'auth.json')
fs.writeFileSync(path.join(process.env.FAKE_DIR, 'seen.json'), JSON.stringify({
  home: process.env.HOME, agentDir: process.env.PI_CODING_AGENT_DIR, mcp,
  auth: fs.existsSync(auth) ? fs.readFileSync(auth, 'utf8') : null,
}))
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n')
require('node:readline').createInterface({ input: process.stdin })
  .on('line', (l) => {
    if (JSON.parse(l).type !== 'prompt') return
    out({ type: 'response', command: 'prompt', success: true, data: { disposition: 'started' } })
    out({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }], stopReason: 'stop' } })
    out({ type: 'agent_settled' })
  })
  .on('close', () => process.exit(0))
`

function fakePi() {
  const d = tmp()
  const js = join(d, 'fake-pi.cjs')
  writeFileSync(js, FAKE_PI)
  const bin = join(d, 'pi')
  writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${js}" "$@"\n`)
  chmodSync(bin, 0o755)
  return { bin, dir: d, seen: () => JSON.parse(readFileSync(join(d, 'seen.json'), 'utf8')) }
}

describe('pi eval mode: sandbox HOME', () => {
  test('AC1: pi runs with HOME=<sandboxHome>; its mcp.json holds only the eval worker; the real one is never read', async () => {
    const pi = fakePi()
    const sandboxHome = tmp()
    const mcpFile = join(tmp(), 'mcp.json')
    writeFileSync(mcpFile, JSON.stringify(EVAL))
    const r = await runOnce({ bin: pi.bin, prompt: 'go', cwd: pi.dir, mcpConfig: mcpFile, sandboxHome, env: { FAKE_DIR: pi.dir, HOME: realHome } }).done
    assert.equal(r.outcome?.ok, true, r.stderr)
    const seen = pi.seen()
    assert.equal(seen.home, sandboxHome)
    assert.equal(seen.agentDir, join(sandboxHome, '.pi', 'agent'))
    assert.deepEqual(seen.mcp, { mcpServers: { fermi: { url: 'http://127.0.0.1:4567/mcp' } } })
    assert.equal(seen.auth, AUTH) // pi could log in during the attempt
    assert.equal(statSync(join(realAgent, 'mcp.json')).mode & 0o777, 0) // untouched, unreadable
  })

  test('AC2: the sandbox auth.json is removed after the attempt (runOnce and startSession)', async () => {
    const pi = fakePi()
    const sandboxHome = tmp()
    const auth = join(sandboxHome, '.pi', 'agent', 'auth.json')
    const r = await runOnce({ bin: pi.bin, prompt: 'go', cwd: pi.dir, mcpConfig: EVAL, sandboxHome, env: { FAKE_DIR: pi.dir } }).done
    assert.equal(r.outcome?.ok, true, r.stderr)
    assert.equal(pi.seen().auth, AUTH)
    assert.equal(existsSync(auth), false)
    assert.equal(existsSync(join(realAgent, 'auth.json')), true) // the real one stays

    const s = startSession({ bin: pi.bin, cwd: pi.dir, mcpConfig: EVAL, sandboxHome, env: { FAKE_DIR: pi.dir } })
    const ended = new Promise((res) => s.events.on('event', (e) => e.type === 'turn_end' && res()))
    s.send('go')
    await ended
    assert.equal(existsSync(auth), true)
    const exited = new Promise((res) => s.events.on('exit', res))
    s.close('SIGTERM')
    await exited
    assert.equal(existsSync(auth), false)
  })

  test('AC3: a non-localhost or url-less MCP server refuses to start; mcpConfig needs sandboxHome', () => {
    const pi = fakePi()
    const sandboxHome = tmp()
    const prod = { mcpServers: { ...EVAL.mcpServers, prod: { type: 'http', url: 'https://fermi.example.com/mcp' } } }
    assert.throws(() => piMcpConfig(prod), /refusing to start: non-localhost .*mcp:prod=https:\/\/fermi\.example\.com/)
    assert.throws(() => piMcpConfig({ mcpServers: { local: { command: 'node', args: ['x'] } } }), /refusing to start: non-localhost .*mcp:local/)
    assert.throws(() => runOnce({ bin: pi.bin, prompt: 'go', mcpConfig: prod, sandboxHome, env: { FAKE_DIR: pi.dir } }), /refusing to start: non-localhost/)
    assert.equal(existsSync(join(pi.dir, 'seen.json')), false) // pi never started
    assert.equal(existsSync(join(sandboxHome, '.pi', 'agent', 'auth.json')), false)
    assert.throws(() => runOnce({ bin: pi.bin, prompt: 'go', mcpConfig: EVAL }), /mcpConfig without sandboxHome/)
  })

  test('the eval runner passes pi a temp sandboxHome and removes it after the attempt', async () => {
    const seen = {}
    const spy = {
      name: 'pi',
      runOnce: (o) => {
        seen.sandboxHome = o.sandboxHome
        seen.existed = existsSync(o.sandboxHome)
        return fake.runOnce(o)
      },
    }
    const scenario = loadScenario(join(ROOT, 'evals/scenarios/examples/reply-contract.json'))
    const r = await runAttempt({ scenario, attempt: 1, harness: spy, timeoutMs: 10_000, outDir: tmp() })
    assert.equal(r.pass, true, JSON.stringify(r.failed))
    assert.ok(seen.sandboxHome)
    assert.equal(seen.existed, true)
    assert.equal(existsSync(seen.sandboxHome), false)
  })
})
