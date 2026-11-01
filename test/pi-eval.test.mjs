// pi adapter eval mode: the sandbox HOME, its generated mcp.json and the auth.json
// copy's lifetime. Uses a fake pi that records what a real pi would find on start.
import { test, describe, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { piMcpConfig, runOnce, startSession } from '../harness/pi.mjs'
import * as pi from '../harness/pi.mjs'
import * as fake from '../evals/harness/fake.mjs'
import { runAttempt } from '../evals/lib/runner.mjs'

const PROD = 'https://fermi.example.workers.dev/mcp'
const LOCAL = 'http://127.0.0.1:18001/mcp'
const CONFIG = { mcpServers: { fermi: { type: 'http', url: LOCAL } } }
const AUTH = '{"anthropic":{"access":"fake-oauth-token"}}'

// Resolves the agent dir the way pi does, records it, then speaks just enough RPC.
const FAKE_PI = `
import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
const agent = process.env.PI_CODING_AGENT_DIR ?? join(process.env.HOME, '.pi/agent')
const read = (f) => { try { return readFileSync(join(agent, f), 'utf8') } catch { return null } }
const mode = (f) => { try { return statSync(join(agent, f)).mode & 0o777 } catch { return null } }
writeFileSync(process.env.FAKE_PI_RECORD, JSON.stringify({ home: process.env.HOME, agent, mcp: read('mcp.json'), auth: read('auth.json'), authMode: mode('auth.json') }))
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n')
createInterface({ input: process.stdin })
  .on('line', () => {
    if (process.env.FAKE_PI_CRASH) process.exit(3)
    out({ type: 'response', command: 'prompt', success: true, data: { disposition: 'started' } })
    out({ type: 'agent_settled' })
  })
  .on('close', () => process.exit(0))
`

const tmp = () => mkdtempSync(join(tmpdir(), 'pi-eval-'))
const real = process.env.HOME
let bin, realHome, sandboxHome, record, cwd
const recorded = () => JSON.parse(readFileSync(record, 'utf8'))
const sandboxAuth = () => join(sandboxHome, '.pi/agent/auth.json')
const opts = (over = {}) => ({ bin, cwd, prompt: 'go', mcpConfig: CONFIG, sandboxHome, ...over })

before(() => {
  const d = tmp()
  writeFileSync(join(d, 'fake-pi.mjs'), FAKE_PI)
  bin = join(d, 'pi')
  writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${join(d, 'fake-pi.mjs')}" "$@"\n`)
  chmodSync(bin, 0o755)
})
beforeEach(() => {
  // The real mcp.json is production and not even valid JSON: reading it would show or throw.
  realHome = tmp()
  mkdirSync(join(realHome, '.pi/agent'), { recursive: true })
  writeFileSync(join(realHome, '.pi/agent/mcp.json'), `{ "mcpServers": { "fermi": { "url": "${PROD}" } } `)
  writeFileSync(join(realHome, '.pi/agent/auth.json'), AUTH)
  sandboxHome = join(tmp(), 'home')
  cwd = tmp()
  record = join(cwd, 'record.json')
  process.env.HOME = realHome
  process.env.FAKE_PI_RECORD = record
  delete process.env.FAKE_PI_CRASH
  delete process.env.PI_CODING_AGENT_DIR
})
after(() => {
  process.env.HOME = real
})

describe('piMcpConfig', () => {
  test('translates the runner config, from an object, JSON text or a path', () => {
    const want = { mcpServers: { fermi: { type: 'http', url: LOCAL, exposure: 'direct' } } }
    assert.deepEqual(piMcpConfig(CONFIG), want)
    assert.deepEqual(piMcpConfig(JSON.stringify(CONFIG)), want)
    const file = join(cwd, 'mcp.json')
    writeFileSync(file, JSON.stringify(CONFIG))
    assert.deepEqual(piMcpConfig(file), want)
  })

  test('only url and headers carry over', () => {
    const s = { url: LOCAL, command: 'sh', oauth: { clientId: 'x' }, headers: { 'x-eval': '1' } }
    assert.deepEqual(piMcpConfig({ mcpServers: { fermi: s } }).mcpServers.fermi, { type: 'http', url: LOCAL, headers: { 'x-eval': '1' }, exposure: 'direct' })
  })

  for (const url of [PROD, 'http://localhost.example.com/mcp', 'http://localhost@example.com/mcp', 'http://127.0.0.1.example.com/mcp', 'ftp://localhost/mcp', 'not a url', undefined]) {
    test(`refuses server url ${url}`, () => {
      assert.throws(() => piMcpConfig({ mcpServers: { local: { url: LOCAL }, fermi: { url, command: 'x' } } }), /refusing to start: non-localhost/)
    })
  }

  test('refuses a non-localhost URL anywhere in the generated file', () => {
    assert.throws(() => piMcpConfig({ mcpServers: { fermi: { url: LOCAL, headers: { 'x-next': PROD } } } }), /refusing to start: non-localhost.*workers\.dev/)
  })

  test('accepts every localhost spelling', () => {
    for (const url of ['http://localhost:1/mcp', 'http://127.0.0.1:1/mcp', 'http://[::1]:1/mcp']) assert.equal(piMcpConfig({ mcpServers: { f: { url } } }).mcpServers.f.url, url)
  })
})

describe('eval mode', () => {
  test('pi runs with HOME=<sandboxHome>, sees only the eval worker, never the real mcp.json', async () => {
    process.env.PI_CODING_AGENT_DIR = join(realHome, '.pi/agent') // must not survive into the child
    const { code, outcome } = await runOnce(opts({ env: { HOME: realHome, PI_CODING_AGENT_DIR: join(realHome, '.pi/agent') } })).done
    assert.equal(code, 0)
    assert.equal(outcome.ok, true)
    const r = recorded()
    assert.equal(r.home, sandboxHome)
    assert.equal(r.agent, join(sandboxHome, '.pi/agent'))
    assert.deepEqual(JSON.parse(r.mcp), { mcpServers: { fermi: { type: 'http', url: LOCAL, exposure: 'direct' } } })
    assert.doesNotMatch(r.mcp, /workers\.dev/)
  })

  test('the login is copied in, owner-only, and removed after the attempt', async () => {
    await runOnce(opts()).done
    assert.equal(recorded().auth, AUTH)
    assert.equal(recorded().authMode, 0o600)
    assert.equal(existsSync(sandboxAuth()), false)
    assert.equal(readFileSync(join(realHome, '.pi/agent/auth.json'), 'utf8'), AUTH, 'the real login is untouched')
  })

  test('a broader real auth.json mode does not reach the copy', async () => {
    chmodSync(join(realHome, '.pi/agent/auth.json'), 0o644)
    await runOnce(opts()).done
    assert.equal(recorded().authMode, 0o600)
  })

  test('auth.json is removed when pi crashes', async () => {
    process.env.FAKE_PI_CRASH = '1'
    const { code } = await runOnce(opts()).done
    assert.equal(code, 3)
    assert.equal(recorded().auth, AUTH)
    assert.equal(existsSync(sandboxAuth()), false)
  })

  test('auth.json is removed when a session is closed', async () => {
    const s = startSession(opts())
    await new Promise((r, rej) => {
      const t0 = Date.now()
      const poll = () => (existsSync(record) ? r() : Date.now() - t0 > 5000 ? rej(new Error('fake pi never started')) : setImmediate(poll))
      poll()
    })
    assert.equal(existsSync(sandboxAuth()), true)
    s.close('SIGTERM')
    await once(s.events, 'exit')
    assert.equal(existsSync(sandboxAuth()), false)
  })

  test('auth.json is removed, and the run ends, when pi cannot be spawned', async () => {
    const { code, stderr } = await runOnce(opts({ bin: join(cwd, 'no-such-pi') })).done
    assert.notEqual(code, 0)
    assert.match(stderr, /ENOENT/)
    assert.equal(existsSync(sandboxAuth()), false)
  })

  test('no real login: pi still starts, without an auth.json', async () => {
    rmSync(join(realHome, '.pi/agent/auth.json'))
    const { code } = await runOnce(opts()).done
    assert.equal(code, 0)
    assert.equal(recorded().auth, null)
  })

  test('a non-localhost URL refuses to start: nothing is spawned or copied', () => {
    assert.throws(() => runOnce(opts({ mcpConfig: { mcpServers: { fermi: { url: PROD } } } })), /refusing to start: non-localhost/)
    assert.equal(existsSync(record), false)
    assert.equal(existsSync(sandboxHome), false)
  })

  test('mcpConfig without sandboxHome refuses to start', () => {
    assert.throws(() => runOnce(opts({ sandboxHome: undefined })), /mcpConfig without sandboxHome/)
    assert.equal(existsSync(record), false)
  })

  test('sandboxHome set to the real $HOME refuses to start, also through a symlink', () => {
    const link = join(cwd, 'link')
    symlinkSync(realHome, link)
    for (const home of [realHome, link]) {
      assert.throws(() => runOnce(opts({ sandboxHome: home })), /sandboxHome is the real \$HOME/)
      assert.equal(existsSync(join(realHome, '.pi/agent/auth.json')), true)
      assert.match(readFileSync(join(realHome, '.pi/agent/mcp.json'), 'utf8'), /workers\.dev/)
    }
  })

  test('without eval options HOME and the agent dir are left alone', async () => {
    await runOnce({ bin, cwd, prompt: 'go' }).done
    assert.equal(recorded().home, realHome)
    assert.equal(recorded().agent, join(realHome, '.pi/agent'))
  })
})

describe('eval runner', () => {
  const scenario = { name: 'pi-sandbox', inbound: { channel: 'sl', sender: 'U0EVALOWNER', chat: 'D0EVAL', text: 'hi' }, expect: [] }

  test('gives pi a temp sandboxHome, removes it, and keeps no credential in the output', async () => {
    process.env.PI_BIN = bin
    const outDir = tmp()
    try {
      const r = await runAttempt({ scenario, attempt: 1, harness: pi, timeoutMs: 10_000, outDir })
      assert.deepEqual(r.errorKinds, [], JSON.stringify(r.failed))
    } finally {
      delete process.env.PI_BIN
    }
    const seen = recorded()
    assert.notEqual(seen.home, realHome)
    assert.equal(seen.auth, AUTH)
    assert.match(Object.values(JSON.parse(seen.mcp).mcpServers)[0].url, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/)
    assert.equal(existsSync(seen.home), false)
    const files = readdirSync(outDir, { recursive: true }).map((f) => join(outDir, f)).filter((f) => statSync(f).isFile())
    assert.ok(files.length > 0)
    for (const f of files) assert.doesNotMatch(readFileSync(f, 'utf8'), /fake-oauth-token/, f)
  })

  test('other harnesses get no sandboxHome', async () => {
    let seen
    const spy = { ...fake, runOnce: (o) => ((seen = o), fake.runOnce(o)) }
    await runAttempt({ scenario, attempt: 1, harness: spy, timeoutMs: 10_000, outDir: tmp() })
    assert.equal('sandboxHome' in seen, false)
  })
})
