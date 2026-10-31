// pi adapter eval mode: pi runs in a sandbox HOME and only sees the localhost eval
// server. Uses test/conformance/fake-pi.mjs and a throwaway "real" HOME; nothing
// here touches the machine's pi config.
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runAttempt } from '../evals/lib/runner.mjs'
import { piMcpConfig, runOnce, startSession } from '../harness/pi.mjs'
import * as pi from '../harness/pi.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PRODUCTION = 'https://fermi.example.workers.dev/mcp'
const LOCAL = 'http://127.0.0.1:18005/mcp'
const AUTH = '{"anthropic":{"type":"oauth","access":"fake-access"}}\n'
const fixed = realpathSync(mkdtempSync(join(tmpdir(), 'pi-eval-')))
const tmp = () => mkdtempSync(join(fixed, 'd-'))

const bin = join(fixed, 'pi')
writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${join(ROOT, 'test/conformance/fake-pi.mjs')}" "$@"\n`)
chmodSync(bin, 0o755)

const fermi = (url = LOCAL) => ({ mcpServers: { fermi: { type: 'http', url } } })
const realAgent = () => join(process.env.HOME, '.pi/agent')
const sandboxAuth = (home) => join(home, '.pi/agent/auth.json')
const started = (dir) => JSON.parse(readFileSync(join(dir, 'pi-start.json'), 'utf8'))
const until = async (cond, ms = 5000) => {
  for (const t0 = Date.now(); !cond(); ) {
    if (Date.now() - t0 > ms) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 20))
  }
}

function attempt(extra = {}) {
  const cwd = tmp()
  const sandboxHome = tmp()
  const mcpConfig = join(cwd, 'runner-mcp.json')
  writeFileSync(mcpConfig, JSON.stringify(fermi()))
  return { bin, cwd, mcpConfig, sandboxHome, env: { FAKE_DIR: cwd }, prompt: 'turn', ...extra }
}

describe('pi adapter eval mode', () => {
  const homeBefore = process.env.HOME
  const agentDirBefore = process.env.PI_CODING_AGENT_DIR
  before(() => {
    process.env.HOME = tmp()
    process.env.PI_CODING_AGENT_DIR = realAgent() // pi would honor this over HOME
    mkdirSync(realAgent(), { recursive: true })
    writeFileSync(join(realAgent(), 'auth.json'), AUTH)
    writeFileSync(join(realAgent(), 'mcp.json'), JSON.stringify(fermi(PRODUCTION)))
    chmodSync(join(realAgent(), 'mcp.json'), 0o000) // reading it fails the attempt
  })
  after(() => {
    process.env.HOME = homeBefore
    if (agentDirBefore === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = agentDirBefore
    rmSync(fixed, { recursive: true, force: true })
  })

  test('piMcpConfig keeps only each server url', () => {
    const config = { mcpServers: { fermi: { type: 'http', url: LOCAL, headers: { Authorization: '!cat ~/.ssh/id_rsa' } } } }
    assert.deepEqual(piMcpConfig(config), { mcpServers: { fermi: { url: LOCAL } } })
    assert.deepEqual(piMcpConfig({ mcpServers: {} }), { mcpServers: {} })
  })

  test('pi runs with HOME=<sandboxHome> and an mcp.json that holds only the eval worker', async () => {
    const o = attempt()
    const { outcome } = await runOnce(o).done
    assert.equal(outcome.ok, true)
    const s = started(o.cwd)
    assert.equal(s.home, o.sandboxHome)
    assert.equal(s.agentDir, join(o.sandboxHome, '.pi/agent'))
    assert.deepEqual(JSON.parse(s.mcp), { mcpServers: { fermi: { url: LOCAL } } })
    assert.ok(!s.mcp.includes('workers.dev'))
    assert.equal(s.auth, AUTH)
  })

  test('the sandbox wins over HOME and PI_CODING_AGENT_DIR in the env option', async () => {
    const o = attempt()
    await runOnce({ ...o, env: { ...o.env, HOME: realAgent(), PI_CODING_AGENT_DIR: realAgent() } }).done
    assert.equal(started(o.cwd).home, o.sandboxHome)
    assert.equal(started(o.cwd).agentDir, join(o.sandboxHome, '.pi/agent'))
  })

  test('the real mcp.json is not touched and the real auth.json survives', async () => {
    const o = attempt()
    await runOnce(o).done
    assert.equal(statSync(join(realAgent(), 'mcp.json')).mode & 0o777, 0)
    assert.equal(readFileSync(join(realAgent(), 'auth.json'), 'utf8'), AUTH)
  })

  test('without mcpConfig the adapter keeps the ambient HOME and writes nothing', async () => {
    const cwd = tmp()
    const home = tmp()
    const { outcome } = await runOnce({ bin, cwd, env: { FAKE_DIR: cwd, HOME: home, PI_CODING_AGENT_DIR: '' }, prompt: 'turn' }).done
    assert.equal(outcome.ok, true)
    assert.equal(started(cwd).home, home)
    assert.equal(started(cwd).agentDir, join(home, '.pi/agent'))
    assert.deepEqual(readdirSync(home), [])
  })

  test('mcpConfig may be inline JSON', async () => {
    const o = attempt({ mcpConfig: JSON.stringify(fermi()) })
    await runOnce(o).done
    assert.deepEqual(JSON.parse(started(o.cwd).mcp), { mcpServers: { fermi: { url: LOCAL } } })
  })

  test('the sandbox auth.json is private while the attempt runs and removed by runOnce', async () => {
    chmodSync(join(realAgent(), 'auth.json'), 0o644)
    const s = attempt()
    const session = startSession(s)
    await until(() => existsSync(join(s.cwd, 'pi-start.json')))
    assert.equal(statSync(sandboxAuth(s.sandboxHome)).mode & 0o777, 0o600)
    session.close('SIGKILL')

    const o = attempt()
    await runOnce(o).done
    assert.equal(started(o.cwd).auth, AUTH)
    assert.equal(existsSync(sandboxAuth(o.sandboxHome)), false)
  })

  test('auth.json is removed when a session closes, a turn crashes or runOnce is killed', async () => {
    const s = attempt()
    const session = startSession(s)
    assert.equal(existsSync(sandboxAuth(s.sandboxHome)), true)
    session.close('SIGKILL')
    await once(session.events, 'exit')
    assert.equal(existsSync(sandboxAuth(s.sandboxHome)), false)

    const c = attempt({ prompt: 'crash' })
    await runOnce(c).done
    assert.equal(existsSync(sandboxAuth(c.sandboxHome)), false)

    const h = attempt({ prompt: 'hang' })
    const run = runOnce(h)
    run.close('SIGTERM')
    await run.done
    assert.equal(existsSync(sandboxAuth(h.sandboxHome)), false)
  })

  test('a failed spawn removes auth.json and ends the attempt with the error on stderr', async () => {
    const o = attempt({ bin: join(fixed, 'no-such-pi') })
    const { outcome, stderr } = await runOnce(o).done
    assert.equal(outcome, null)
    assert.match(stderr, /ENOENT/)
    assert.equal(existsSync(sandboxAuth(o.sandboxHome)), false)
  })

  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP', 'SIGQUIT', 'SIGABRT'])
    test(`auth.json is removed when the runner dies of ${signal} mid-attempt`, async () => {
      const o = attempt()
      const script = join(o.cwd, 'runner.mjs')
      writeFileSync(
        script,
        `import { startSession } from ${JSON.stringify(join(ROOT, 'harness/pi.mjs'))}\n` +
          `startSession(${JSON.stringify({ ...o, prompt: undefined })}).send('hang')\nconsole.log('up')\nsetInterval(() => {}, 1000)\n`,
      )
      const runner = spawn(process.execPath, [script], { stdio: ['ignore', 'pipe', 'inherit'] })
      await once(runner.stdout, 'data')
      assert.equal(existsSync(sandboxAuth(o.sandboxHome)), true)
      runner.kill(signal)
      const [code, killedBy] = await once(runner, 'exit')
      assert.deepEqual([code, killedBy], [null, signal]) // still dies of the signal
      assert.equal(existsSync(sandboxAuth(o.sandboxHome)), false)
    })

  test('no real auth.json is not an error (an API key may be in the env)', async () => {
    const auth = join(realAgent(), 'auth.json')
    rmSync(auth)
    try {
      const o = attempt()
      assert.equal((await runOnce(o).done).outcome.ok, true)
      assert.equal(started(o.cwd).auth, null)
    } finally {
      writeFileSync(auth, AUTH)
    }
  })

  for (const [label, url] of [
    ['production', PRODUCTION],
    ['a userinfo trick', 'http://localhost@fermi.example.workers.dev/mcp'],
    ['a localhost prefix', 'http://localhost.example.com/mcp'],
    ['a non-http scheme', 'file://localhost/etc/passwd'],
  ])
    test(`${label} refuses to start before anything is written or spawned`, () => {
      const o = attempt()
      writeFileSync(o.mcpConfig, JSON.stringify(fermi(url)))
      assert.throws(() => runOnce(o), /^Error: refusing to start: non-localhost /)
      assert.equal(existsSync(join(o.cwd, 'pi-start.json')), false)
      assert.deepEqual(readdirSync(o.sandboxHome), [])
    })

  test('one bad server among good ones refuses, and so does a url-less server', () => {
    const local = fermi().mcpServers.fermi
    assert.throws(() => piMcpConfig({ mcpServers: { fermi: local, other: { url: PRODUCTION } } }), /refusing to start: non-localhost .*other/)
    assert.throws(() => piMcpConfig({ mcpServers: { tool: { command: 'npx', args: [PRODUCTION] } } }), /refusing to start: non-localhost .*tool/)
    assert.throws(() => piMcpConfig({ mcpServers: { list: { url: ['http://localhost/'] } } }), /refusing to start: non-localhost .*list/)
  })

  test('mcpConfig without sandboxHome and sandboxHome without mcpConfig both refuse', () => {
    const o = attempt()
    assert.throws(() => runOnce({ ...o, sandboxHome: undefined }), /mcpConfig without sandboxHome/)
    assert.throws(() => runOnce({ ...o, sandboxHome: '' }), /mcpConfig without sandboxHome/)
    assert.throws(() => runOnce({ ...o, mcpConfig: undefined }), /sandboxHome without mcpConfig/)
    assert.equal(existsSync(join(o.cwd, 'pi-start.json')), false)
  })

  test('a sandboxHome that resolves to the real HOME refuses and leaves the real files alone', () => {
    const link = join(tmp(), 'home')
    symlinkSync(process.env.HOME, link)
    const dotPi = join(tmp(), 'home')
    mkdirSync(dotPi)
    symlinkSync(join(process.env.HOME, '.pi'), join(dotPi, '.pi'))
    const homes = [process.env.HOME, link, dotPi]
    // Only a case-insensitive volume (the macOS default) has this second spelling of HOME.
    const upper = process.env.HOME.toUpperCase()
    if (existsSync(upper)) homes.push(upper)
    for (const sandboxHome of homes) {
      assert.throws(() => runOnce(attempt({ sandboxHome })), /sandboxHome is the real HOME/)
      assert.equal(readFileSync(join(realAgent(), 'auth.json'), 'utf8'), AUTH)
      assert.equal(statSync(join(realAgent(), 'mcp.json')).mode & 0o777, 0)
    }
  })

  test('a real HOME that has no pi config yet refuses and stays empty', () => {
    const before = process.env.HOME
    process.env.HOME = tmp()
    try {
      assert.throws(() => runOnce(attempt({ sandboxHome: process.env.HOME })), /sandboxHome is the real HOME/)
      assert.deepEqual(readdirSync(process.env.HOME), [])
    } finally {
      process.env.HOME = before
    }
  })

  test('the eval runner gives pi a fresh sandboxHome outside <out> and removes it; other harnesses get none', async () => {
    const scenario = { name: 's', inbound: { channel: 'sl', sender: 'U1', chat: 'D1', text: 'hi' }, expect: [] }
    const run = async (name) => {
      const out = tmp()
      let seen
      const harness = {
        name,
        runOnce(o) {
          seen = { ...o, existed: o.sandboxHome && existsSync(o.sandboxHome) }
          return pi.runOnce({ ...o, bin, env: { ...o.env, FAKE_DIR: o.cwd }, sandboxHome: o.sandboxHome ?? tmp(), prompt: 'turn' })
        },
      }
      const r = await runAttempt({ scenario, attempt: 1, harness, timeoutMs: 10_000, outDir: out })
      return { r, seen, out }
    }
    const { r, seen, out } = await run('pi')
    assert.equal(r.pass, true, JSON.stringify(r.failed))
    assert.equal(seen.existed, true)
    assert.ok(!seen.sandboxHome.startsWith(out))
    assert.equal(existsSync(seen.sandboxHome), false)
    assert.equal((await run('claude-code')).seen.sandboxHome, undefined)
  })
})
