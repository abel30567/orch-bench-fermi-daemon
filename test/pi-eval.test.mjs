// pi adapter eval mode: a sandbox HOME whose .pi/agent/mcp.json holds only the
// localhost eval worker, plus a per-attempt copy of auth.json.
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { piMcpConfig, runOnce } from '../harness/pi.mjs'
import { runAttempt } from '../evals/lib/runner.mjs'
import { loadScenario } from '../evals/lib/scenario.mjs'
import * as fake from '../evals/harness/fake.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const tmp = () => mkdtempSync(join(tmpdir(), 'pi-eval-'))
const EVAL_URL = 'http://127.0.0.1:4567/mcp'
const PROD_URL = 'https://fermi.example.com/mcp'

// A fake pi that first records what it sees (HOME, agent dir, mcp.json, auth.json)
// to $FAKE_DIR/seen.json, then speaks RPC as test/conformance/fake-pi.mjs.
const bin = join(tmp(), 'pi')
const probe = `const fs=require("fs"),p=require("path");const d=process.env.PI_CODING_AGENT_DIR||"";const r=(f)=>{try{return fs.readFileSync(p.join(d,f),"utf8")}catch{return null}};fs.writeFileSync(p.join(process.env.FAKE_DIR,"seen.json"),JSON.stringify({home:process.env.HOME,agentDir:d,mcp:r("mcp.json"),auth:r("auth.json")}))`
writeFileSync(bin, `#!/bin/sh\n"${process.execPath}" -e '${probe}'\nexec "${process.execPath}" "${join(HERE, 'conformance/fake-pi.mjs')}" "$@"\n`)
chmodSync(bin, 0o755)

let realHome
let savedHome
before(() => {
  // The owner's real pi config: production Fermi and a login.
  realHome = tmp()
  mkdirSync(join(realHome, '.pi/agent'), { recursive: true })
  writeFileSync(join(realHome, '.pi/agent/mcp.json'), JSON.stringify({ mcpServers: { fermi: { url: PROD_URL } } }))
  writeFileSync(join(realHome, '.pi/agent/auth.json'), '{"anthropic":{"type":"oauth","access":"real-token"}}')
  savedHome = process.env.HOME
  process.env.HOME = realHome
})
after(() => {
  process.env.HOME = savedHome
})

const evalRun = (extra = {}) => {
  const dir = tmp()
  const sandboxHome = join(tmp(), 'home')
  const mcpConfig = join(dir, 'mcp.json')
  writeFileSync(mcpConfig, JSON.stringify({ mcpServers: { fermi: { type: 'http', url: EVAL_URL } } }))
  const run = runOnce({ bin, prompt: 'turn', cwd: dir, env: { FAKE_DIR: dir }, mcpConfig, sandboxHome, ...extra })
  return { dir, sandboxHome, run }
}

describe('pi eval mode', () => {
  test('AC1: pi runs with HOME=<sandboxHome>; its mcp.json holds only the localhost eval worker', async () => {
    const { dir, sandboxHome, run } = evalRun()
    const r = await run.done
    assert.equal(r.outcome?.ok, true, r.stderr)
    const seen = JSON.parse(readFileSync(join(dir, 'seen.json'), 'utf8'))
    assert.equal(seen.home, sandboxHome)
    assert.equal(seen.agentDir, join(sandboxHome, '.pi/agent'))
    assert.deepEqual(JSON.parse(seen.mcp), { mcpServers: { fermi: { url: EVAL_URL } } })
    assert.doesNotMatch(seen.mcp, /fermi\.example\.com/)
  })

  test('AC1: the real mcp.json is never read', async () => {
    const real = join(realHome, '.pi/agent/mcp.json')
    chmodSync(real, 0o000) // any read of it would throw (EACCES)
    try {
      const { dir, run } = evalRun()
      const r = await run.done
      assert.equal(r.outcome?.ok, true, r.stderr)
      const seen = JSON.parse(readFileSync(join(dir, 'seen.json'), 'utf8'))
      assert.notEqual(seen.agentDir, join(realHome, '.pi/agent'))
      assert.deepEqual(Object.values(JSON.parse(seen.mcp).mcpServers).map((s) => s.url), [EVAL_URL])
    } finally {
      chmodSync(real, 0o644)
    }
  })

  test('AC2: the sandbox auth.json is a copy for the attempt and is removed afterwards', async () => {
    const { dir, sandboxHome, run } = evalRun()
    await run.done
    const seen = JSON.parse(readFileSync(join(dir, 'seen.json'), 'utf8'))
    assert.equal(seen.auth, readFileSync(join(realHome, '.pi/agent/auth.json'), 'utf8'))
    assert.equal(existsSync(join(sandboxHome, '.pi/agent/auth.json')), false)
    assert.equal(existsSync(join(realHome, '.pi/agent/auth.json')), true)
  })

  test('AC2: the eval runner gives pi a sandbox HOME and removes it after the attempt', async () => {
    const seen = {}
    const spy = { name: 'pi', runOnce: (o) => ((seen.opts = o), fake.runOnce(o)), startSession: (o) => ((seen.opts = o), fake.startSession(o)) }
    const scenario = loadScenario(join(HERE, '../evals/scenarios/examples/reply-contract.json'))
    const r = await runAttempt({ scenario, attempt: 1, harness: spy, timeoutMs: 10_000, outDir: tmp() })
    assert.equal(r.pass, true, JSON.stringify(r.failed))
    assert.ok(seen.opts.sandboxHome)
    assert.notEqual(seen.opts.sandboxHome, realHome)
    assert.equal(existsSync(seen.opts.sandboxHome), false)
  })

  test('AC3: a non-localhost or url-less server refuses to start', () => {
    assert.throws(() => piMcpConfig({ mcpServers: { fermi: { url: PROD_URL } } }), /refusing to start: non-localhost/)
    assert.throws(() => piMcpConfig({ mcpServers: { a: { url: EVAL_URL }, b: { command: 'npx', args: ['x'] } } }), /refusing to start: non-localhost/)
    const dir = tmp()
    const mcpConfig = join(dir, 'mcp.json')
    writeFileSync(mcpConfig, JSON.stringify({ mcpServers: { fermi: { url: PROD_URL } } }))
    const sandboxHome = join(dir, 'home')
    assert.throws(() => runOnce({ bin, prompt: 'turn', cwd: dir, env: { FAKE_DIR: dir }, mcpConfig, sandboxHome }), /refusing to start: non-localhost/)
    assert.equal(existsSync(join(dir, 'seen.json')), false)
    assert.equal(existsSync(join(sandboxHome, '.pi/agent/auth.json')), false)
  })

  test('mcpConfig without sandboxHome is refused', () => {
    assert.throws(() => evalRun({ sandboxHome: undefined }), /mcpConfig without sandboxHome/)
  })
})
