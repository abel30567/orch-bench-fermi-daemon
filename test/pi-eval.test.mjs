// pi adapter eval mode: pi runs in a sandbox HOME that only knows the local eval
// worker, with a login copy that does not outlive the attempt. Uses a fake HOME and
// test/conformance/fake-pi.mjs; no real pi, config or credential is touched.
import { test, describe, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { piMcpConfig, runOnce, startSession } from '../harness/pi.mjs'
import * as pi from '../harness/pi.mjs'
import { runAttempt } from '../evals/lib/runner.mjs'

const FAKE = join(dirname(fileURLToPath(import.meta.url)), 'conformance/fake-pi.mjs')
const LOCAL = 'http://127.0.0.1:18001/mcp'
const PROD = 'https://fermi.example.workers.dev/mcp'
const AUTH = '{"anthropic":{"type":"oauth","access":"fake-token"}}'
const config = (url = LOCAL) => ({ mcpServers: { fermi: { type: 'http', url } } })

const dirs = []
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'pr60-'))
  dirs.push(d)
  return d
}
const realHomeEnv = process.env.HOME
let realHome, sandboxHome, cwd, bin, probe

const until = async (cond, ms = 5000) => {
  for (const t0 = Date.now(); !cond(); ) {
    if (Date.now() - t0 > ms) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 20))
  }
}
const opts = (extra = {}) => ({ bin, cwd, mcpConfig: config(), sandboxHome, env: { FAKE_PI_PROBE: probe }, ...extra })
const sandboxAuth = () => join(sandboxHome, '.pi/agent/auth.json')
const readProbe = () => JSON.parse(readFileSync(probe, 'utf8'))
// A pi that dies without reading stdin, and a prompt no socket buffer can swallow, so the write always fails.
const deadPi = (body) => {
  const p = join(tmp(), 'dead-pi')
  writeFileSync(p, `#!/bin/sh\n${body}\n`)
  chmodSync(p, 0o755)
  return p
}
const HUGE = 'x'.repeat(4 * 1024 * 1024)

before(() => {
  bin = join(tmp(), 'pi')
  writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${FAKE}" "$@"\n`)
  chmodSync(bin, 0o755)
})
beforeEach(() => {
  // The owner's HOME. Its mcp.json is a directory: anything that reads it throws.
  realHome = tmp()
  process.env.HOME = realHome
  mkdirSync(join(realHome, '.pi/agent/mcp.json'), { recursive: true })
  writeFileSync(join(realHome, '.pi/agent/auth.json'), AUTH)
  sandboxHome = tmp()
  cwd = tmp()
  probe = join(tmp(), 'probe.json')
})
after(() => {
  process.env.HOME = realHomeEnv
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

describe('piMcpConfig', () => {
  test('keeps only each server\'s url', () => {
    assert.deepEqual(piMcpConfig({ mcpServers: { fermi: { type: 'http', url: LOCAL, headers: { Referer: PROD } } } }), { mcpServers: { fermi: { url: LOCAL } } })
  })

  test('takes the runner\'s file path or JSON text as well as an object', () => {
    const file = join(tmp(), 'mcp.json')
    writeFileSync(file, JSON.stringify(config()))
    const want = { mcpServers: { fermi: { url: LOCAL } } }
    assert.deepEqual(piMcpConfig(file), want)
    assert.deepEqual(piMcpConfig(JSON.stringify(config())), want)
  })

  for (const [label, url] of [
    ['a production URL', PROD],
    ['a localhost lookalike', 'http://127.0.0.1.example.com/mcp'],
    ['localhost as userinfo', 'http://localhost@example.com/mcp'],
    ['not a URL', 'localhost'],
  ])
    test(`refuses ${label}`, () => assert.throws(() => piMcpConfig(config(url)), /refusing to start: non-localhost/))

  test('refuses a production URL hidden in an array', () => {
    assert.throws(() => piMcpConfig(config(['http://localhost/', PROD])), /refusing to start: non-localhost/)
  })

  test('refuses a url-less (stdio) server', () => {
    assert.throws(() => piMcpConfig({ mcpServers: { x: { command: 'npx', args: ['mcp-remote', PROD] } } }), /refusing to start: non-localhost/)
  })

  test('refuses one bad server among good ones', () => {
    const c = { mcpServers: { ...config().mcpServers, prod: { url: PROD } } }
    assert.throws(() => piMcpConfig(c), /refusing to start: non-localhost MCP server prod/)
  })
})

describe('AC1: pi runs in the sandbox HOME', () => {
  test('HOME, agent dir and mcp.json are the sandbox\'s; the real mcp.json is never read', async () => {
    const { outcome } = await runOnce({ ...opts(), prompt: 'turn' }).done
    assert.equal(outcome?.ok, true)
    const seen = readProbe()
    assert.equal(seen.HOME, sandboxHome)
    assert.equal(seen.PI_CODING_AGENT_DIR, join(sandboxHome, '.pi/agent'))
    assert.deepEqual(JSON.parse(seen.mcp), { mcpServers: { fermi: { url: LOCAL } } })
    assert.deepEqual(readdirSync(join(realHome, '.pi/agent/mcp.json')), [], 'the real path is untouched')
  })

  test('an inherited HOME or agent dir cannot point pi back at the real config', async () => {
    const realDir = join(realHome, '.pi/agent')
    process.env.PI_CODING_AGENT_DIR = realDir
    try {
      await runOnce({ ...opts({ env: { FAKE_PI_PROBE: probe, HOME: realHome, PI_CODING_AGENT_DIR: realDir } }), prompt: 'turn' }).done
    } finally {
      delete process.env.PI_CODING_AGENT_DIR
    }
    assert.equal(readProbe().HOME, sandboxHome)
    assert.equal(readProbe().PI_CODING_AGENT_DIR, join(sandboxHome, '.pi/agent'))
  })

  test('startSession runs in the sandbox too', async () => {
    const s = startSession(opts())
    await until(() => existsSync(probe) && readFileSync(probe, 'utf8').length)
    assert.equal(readProbe().HOME, sandboxHome)
    s.close()
  })

  test('sandboxHome that is the real HOME is refused and the login survives', () => {
    assert.throws(() => runOnce({ ...opts({ sandboxHome: realHome }), prompt: 'turn' }), /sandboxHome is the real HOME/)
    assert.equal(readFileSync(join(realHome, '.pi/agent/auth.json'), 'utf8'), AUTH)
  })

  test('a sandboxHome whose .pi links to the real one is refused and the login survives', () => {
    symlinkSync(join(realHome, '.pi'), join(sandboxHome, '.pi'))
    assert.throws(() => runOnce({ ...opts(), prompt: 'turn' }), /sandboxHome is the real HOME/)
    assert.equal(readFileSync(join(realHome, '.pi/agent/auth.json'), 'utf8'), AUTH)
  })

  test('a case variant of the real HOME is refused on a case-insensitive volume', (t) => {
    const variant = realHome.toUpperCase()
    if (!existsSync(variant)) return t.skip('case-sensitive volume')
    assert.throws(() => runOnce({ ...opts({ sandboxHome: variant }), prompt: 'turn' }), /sandboxHome is the real HOME/)
    assert.equal(readFileSync(join(realHome, '.pi/agent/auth.json'), 'utf8'), AUTH)
  })

  test('pre-seeded mcp.json and auth.json symlinks are replaced, not written through', async () => {
    const outside = tmp()
    mkdirSync(join(sandboxHome, '.pi/agent'), { recursive: true })
    for (const f of ['mcp.json', 'auth.json']) {
      writeFileSync(join(outside, f), 'untouched')
      symlinkSync(join(outside, f), join(sandboxHome, '.pi/agent', f))
    }
    await runOnce({ ...opts(), prompt: 'turn' }).done
    assert.deepEqual(JSON.parse(readProbe().mcp), { mcpServers: { fermi: { url: LOCAL } } })
    assert.equal(readProbe().auth, AUTH)
    for (const f of ['mcp.json', 'auth.json']) assert.equal(readFileSync(join(outside, f), 'utf8'), 'untouched')
  })

  test('mcpConfig without sandboxHome, or the reverse, is refused', () => {
    assert.throws(() => runOnce({ ...opts({ sandboxHome: undefined }), prompt: 'turn' }), /mcpConfig without sandboxHome/)
    assert.throws(() => startSession(opts({ mcpConfig: undefined })), /sandboxHome without mcpConfig/)
  })

  test('without eval options pi keeps the caller\'s HOME and agent dir', async () => {
    mkdirSync(join(sandboxHome, '.pi/agent'), { recursive: true })
    writeFileSync(join(sandboxHome, '.pi/agent/mcp.json'), '{}')
    const env = { FAKE_PI_PROBE: probe, HOME: sandboxHome }
    await runOnce({ bin, cwd, env, prompt: 'turn' }).done
    assert.equal(readProbe().HOME, sandboxHome)
    assert.equal(readProbe().PI_CODING_AGENT_DIR, null)
  })
})

describe('AC2: the login copy does not outlive the attempt', () => {
  test('pi gets the real login; it is gone after a clean run; the real file stays', async () => {
    await runOnce({ ...opts(), prompt: 'turn' }).done
    assert.equal(readProbe().auth, AUTH)
    assert.equal(existsSync(sandboxAuth()), false)
    assert.equal(readFileSync(join(realHome, '.pi/agent/auth.json'), 'utf8'), AUTH)
  })

  test('gone after a crash', async () => {
    await runOnce({ ...opts(), prompt: 'crash' }).done
    assert.equal(readProbe().auth, AUTH)
    assert.equal(existsSync(sandboxAuth()), false)
  })

  test('gone after a killed run and a closed session', async () => {
    const run = runOnce({ ...opts(), prompt: 'hang' })
    await until(() => existsSync(probe))
    run.close('SIGKILL')
    await run.done
    assert.equal(existsSync(sandboxAuth()), false)

    const s = startSession(opts())
    await new Promise((resolve) => {
      s.events.once('exit', resolve)
      s.close()
    })
    assert.equal(existsSync(sandboxAuth()), false)
  })

  for (const [label, body] of [
    ['at once', 'exit 1'],
    ['a moment after starting', 'sleep 0.2\nexit 1'],
  ])
    test(`pi that dies ${label} without reading stdin: no crash, copy gone, reported`, async () => {
      const stderr = []
      const run = runOnce({ ...opts({ bin: deadPi(body) }), prompt: HUGE })
      run.events.on('stderr', (s) => stderr.push(s))
      const { code, outcome } = await run.done
      assert.equal(code, 1)
      assert.equal(outcome, null)
      assert.equal(existsSync(sandboxAuth()), false)
      assert.match(stderr.join(''), /pi adapter: stdin: /)
    })

  test('a session whose pi dies without reading stdin does not crash the host', async () => {
    const s = startSession(opts({ bin: deadPi('exit 1') }))
    const failed = new Promise((resolve) => s.events.once('stderr', resolve))
    const exited = new Promise((resolve) => s.events.once('exit', resolve))
    s.send(HUGE)
    assert.match(await failed, /pi adapter: stdin: /)
    assert.equal(await exited, 1)
    assert.equal(existsSync(sandboxAuth()), false)
    assert.equal(s.send('again'), false)
  })

  test('gone when pi cannot be spawned', async () => {
    const stderr = []
    const run = runOnce({ ...opts({ bin: join(tmp(), 'no-such-pi') }), prompt: 'turn' })
    run.events.on('stderr', (s) => stderr.push(s))
    await run.done
    assert.equal(existsSync(sandboxAuth()), false)
    assert.match(stderr.join(''), /ENOENT/)
  })

  test('no real login: pi still starts, without a copy', async () => {
    rmSync(join(realHome, '.pi/agent/auth.json'))
    const { outcome } = await runOnce({ ...opts(), prompt: 'turn' }).done
    assert.equal(outcome?.ok, true)
    assert.equal(readProbe().auth, null)
  })
})

describe('AC3: a non-localhost URL refuses to start', () => {
  for (const [label, mcpConfig] of [
    ['a production URL', config(PROD)],
    ['a url-less server', { mcpServers: { x: { command: 'npx' } } }],
  ])
    test(`${label}: pi is not spawned and nothing lands in the sandbox`, () => {
      assert.throws(() => runOnce({ ...opts({ mcpConfig }), prompt: 'turn' }), /refusing to start: non-localhost/)
      assert.equal(existsSync(probe), false)
      assert.deepEqual(readdirSync(sandboxHome), [])
    })
})

describe('the eval runner passes a sandbox HOME for pi', () => {
  const scenario = {
    name: 's',
    fixtures: { bindings: [{ channel: 'sl', sender_id: 'U0EVALOWNER' }] },
    inbound: { channel: 'sl', sender: 'U0EVALOWNER', chat: 'D0EVAL', text: 'hi' },
    expect: [],
  }
  const finished = () => {
    const events = { on() {} }
    return { events, done: Promise.resolve({ code: 0, events: [] }), close() {} }
  }

  test('a throwaway HOME per attempt, removed when the attempt ends', async () => {
    const homes = []
    const harness = {
      name: 'pi',
      runOnce(o) {
        homes.push(o.sandboxHome)
        assert.ok(existsSync(o.sandboxHome))
        return finished()
      },
    }
    const attempt = (n) => runAttempt({ scenario, attempt: n, harness, timeoutMs: 5000, outDir: tmp() })
    await attempt(1)
    await attempt(2)
    assert.notEqual(homes[0], homes[1])
    for (const h of homes) assert.equal(existsSync(h), false)
  })

  test('removed, with any login in it, when the attempt fails or pi outlives it', async () => {
    let home
    const hang = {
      name: 'pi',
      runOnce(o) {
        home = o.sandboxHome
        writeFileSync(join(home, 'auth.json'), AUTH)
        return { events: { on() {} }, done: new Promise(() => {}), close() {} } // ignores the SIGTERM
      },
    }
    await runAttempt({ scenario, attempt: 1, harness: hang, timeoutMs: 50, outDir: tmp() })
    assert.ok(home, 'the harness ran')
    assert.equal(existsSync(home), false)

    home = undefined
    const boom = {
      name: 'pi',
      runOnce(o) {
        home = o.sandboxHome
        throw new Error('refusing to start: non-localhost')
      },
    }
    const r = await runAttempt({ scenario, attempt: 1, harness: boom, timeoutMs: 5000, outDir: tmp() })
    assert.equal(r.pass, false)
    assert.ok(home, 'the harness ran')
    assert.equal(existsSync(home), false)
  })

  test('the real adapter runs a drain end to end in that HOME', async () => {
    let home
    const harness = {
      ...pi,
      runOnce(o) {
        home = o.sandboxHome
        return pi.runOnce({ ...o, bin, prompt: 'turn', env: { ...o.env, FAKE_PI_PROBE: probe } })
      },
    }
    const r = await runAttempt({ scenario, attempt: 1, harness, timeoutMs: 15000, outDir: tmp() })
    assert.deepEqual(r.failed, [])
    const seen = readProbe()
    assert.equal(seen.HOME, home)
    assert.match(Object.values(JSON.parse(seen.mcp).mcpServers)[0].url, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/)
    assert.equal(existsSync(home), false)
  })

  test('a pi that dies before reading its prompt ends the attempt, not the eval run', async () => {
    let home
    const dead = deadPi('exit 1')
    const harness = {
      ...pi,
      runOnce(o) {
        home = o.sandboxHome
        return pi.runOnce({ ...o, bin: dead, prompt: HUGE })
      },
    }
    await runAttempt({ scenario, attempt: 1, harness, timeoutMs: 15000, outDir: tmp() })
    assert.ok(home, 'the harness ran')
    assert.equal(existsSync(home), false)
  })

  test('other harnesses get no sandboxHome', async () => {
    let seen = 'unset'
    const harness = {
      name: 'claude-code',
      runOnce(o) {
        seen = o.sandboxHome
        return finished()
      },
    }
    await runAttempt({ scenario, attempt: 1, harness, timeoutMs: 5000, outDir: tmp() })
    assert.equal(seen, undefined)
  })
})
