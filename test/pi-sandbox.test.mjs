// harness/pi.mjs eval mode: pi runs in a sandbox HOME that only knows the local
// eval worker, against ./conformance/fake-pi.mjs behind a probe that records what
// pi would see. No inference.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ROOT } from './run-worker.mjs'
import { runAttempt } from '../evals/lib/runner.mjs'
import * as pi from '../harness/pi.mjs'

const FAKE = join(ROOT, 'test/conformance/fake-pi.mjs')
const LOCAL = 'http://127.0.0.1:18005/mcp'
const CONFIG = { mcpServers: { fermi: { type: 'http', url: LOCAL } } }
const tmp = () => mkdtempSync(join(tmpdir(), 'pr60-'))

// A pi binary that dumps its HOME, agent dir and sandbox files, then behaves as fake-pi.
function setup() {
  const dir = tmp()
  const bin = join(dir, 'pi')
  writeFileSync(
    bin,
    `#!/bin/sh
echo "$HOME" > "${dir}/seen-home"
echo "$PI_CODING_AGENT_DIR" > "${dir}/seen-agent-dir"
cp "$PI_CODING_AGENT_DIR/mcp.json" "${dir}/seen-mcp.json"
cp "$PI_CODING_AGENT_DIR/auth.json" "${dir}/seen-auth.json"
exec "${process.execPath}" "${FAKE}" "$@"
`,
  )
  chmodSync(bin, 0o755)
  const realHome = join(dir, 'real-home')
  const sandboxHome = join(dir, 'sandbox')
  mkdirSync(join(realHome, '.pi/agent'), { recursive: true })
  mkdirSync(sandboxHome)
  writeFileSync(join(realHome, '.pi/agent/auth.json'), '{"anthropic":"fake-login"}')
  writeFileSync(join(realHome, '.pi/agent/mcp.json'), '{"mcpServers":{"fermi":{"url":"https://fermi.example.workers.dev/mcp"}}}')
  const opts = { bin, cwd: dir, mcpConfig: CONFIG, sandboxHome, env: { HOME: realHome, PI_CODING_AGENT_DIR: '' } }
  return { dir, bin, realHome, sandboxHome, opts, auth: join(sandboxHome, '.pi/agent/auth.json') }
}
const seen = (dir, f) => readFileSync(join(dir, f), 'utf8').trim()

describe('piMcpConfig', () => {
  test('translates the runner config to url-only servers', () => {
    assert.deepEqual(pi.piMcpConfig(CONFIG), { mcpServers: { fermi: { url: LOCAL } } })
  })
  test('reads the runner config from a path or JSON text', () => {
    const file = join(tmp(), 'mcp.json')
    writeFileSync(file, JSON.stringify(CONFIG))
    assert.deepEqual(pi.piMcpConfig(file), pi.piMcpConfig(CONFIG))
    assert.deepEqual(pi.piMcpConfig(JSON.stringify(CONFIG)), pi.piMcpConfig(CONFIG))
  })
  test('refuses non-localhost, lookalike and url-less servers', () => {
    for (const s of [{ url: 'https://fermi.example.workers.dev/mcp' }, { url: 'http://127.0.0.1.example.com/mcp' }, { url: 'http://localhost@example.com/mcp' }, { command: 'fermi-mcp' }]) {
      assert.throws(() => pi.piMcpConfig({ mcpServers: { local: CONFIG.mcpServers.fermi, fermi: s } }), /refusing to start: non-localhost/)
    }
  })
  test('carries no other field into mcp.json, so no unchecked URL can reach it', () => {
    const c = { mcpServers: { fermi: { url: LOCAL, oauth: { tokenUrl: 'https://example.com/t' }, headers: { 'x-url': 'https://example.com' } } } }
    assert.deepEqual(pi.piMcpConfig(c), { mcpServers: { fermi: { url: LOCAL } } })
  })
})

describe('pi eval mode', () => {
  test('pi runs with HOME=<sandboxHome> and an mcp.json holding only the eval worker', async () => {
    const t = setup()
    const { outcome } = await pi.runOnce({ ...t.opts, prompt: 'turn' }).done
    assert.equal(outcome.ok, true)
    assert.equal(seen(t.dir, 'seen-home'), t.sandboxHome)
    assert.equal(seen(t.dir, 'seen-agent-dir'), join(t.sandboxHome, '.pi/agent'))
    assert.deepEqual(JSON.parse(seen(t.dir, 'seen-mcp.json')), { mcpServers: { fermi: { url: LOCAL } } })
  })

  test('options.env cannot move pi out of the sandbox', async () => {
    const t = setup()
    t.opts.env.PI_CODING_AGENT_DIR = join(t.realHome, '.pi/agent')
    await pi.runOnce({ ...t.opts, prompt: 'turn' }).done
    assert.equal(seen(t.dir, 'seen-agent-dir'), join(t.sandboxHome, '.pi/agent'))
  })

  test('the login is copied for the attempt, owner-only, then removed; the real one stays', async () => {
    const t = setup()
    const run = pi.runOnce({ ...t.opts, prompt: 'turn' })
    assert.equal(statSync(t.auth).mode & 0o777, 0o600)
    await run.done
    assert.equal(seen(t.dir, 'seen-auth.json'), '{"anthropic":"fake-login"}')
    assert.equal(existsSync(t.auth), false)
    assert.equal(existsSync(join(t.realHome, '.pi/agent/auth.json')), true)
  })

  test('the copy comes from PI_CODING_AGENT_DIR when that is set', async () => {
    const t = setup()
    const other = join(t.dir, 'other-agent')
    mkdirSync(other)
    writeFileSync(join(other, 'auth.json'), 'other-login')
    await pi.runOnce({ ...t.opts, env: { ...t.opts.env, PI_CODING_AGENT_DIR: other }, prompt: 'turn' }).done
    assert.equal(seen(t.dir, 'seen-auth.json'), 'other-login')
  })

  test('the copy is removed when a session is closed mid-turn', async () => {
    const t = setup()
    const s = pi.startSession(t.opts)
    assert.equal(existsSync(t.auth), true)
    s.send('hang')
    s.close('SIGKILL')
    await once(s.events, 'exit')
    assert.equal(existsSync(t.auth), false)
  })

  test('the copy is removed when pi crashes', async () => {
    const t = setup()
    await pi.runOnce({ ...t.opts, prompt: 'crash' }).done
    assert.equal(existsSync(t.auth), false)
  })

  test('the copy is removed when pi cannot be spawned', async () => {
    const t = setup()
    const { code } = await pi.runOnce({ ...t.opts, bin: join(t.dir, 'missing'), prompt: 'turn' }).done
    assert.notEqual(code, 0)
    assert.equal(existsSync(t.auth), false)
  })

  test('no login to copy: pi still starts', async () => {
    const t = setup()
    const { outcome } = await pi.runOnce({ ...t.opts, env: { HOME: join(t.dir, 'nobody'), PI_CODING_AGENT_DIR: '' }, prompt: 'turn' }).done
    assert.equal(outcome.ok, true)
    assert.equal(existsSync(t.auth), false)
  })

  test('a non-localhost URL refuses to start: nothing written, nothing spawned', () => {
    const t = setup()
    const mcpConfig = { mcpServers: { fermi: { url: 'https://fermi.example.workers.dev/mcp' } } }
    assert.throws(() => pi.runOnce({ ...t.opts, mcpConfig, prompt: 'turn' }), /refusing to start: non-localhost/)
    assert.equal(existsSync(join(t.sandboxHome, '.pi')), false)
    assert.equal(existsSync(join(t.dir, 'seen-home')), false)
  })

  test('mcpConfig and sandboxHome only work together', () => {
    const t = setup()
    assert.throws(() => pi.startSession({ ...t.opts, sandboxHome: undefined }), /mcpConfig without sandboxHome/)
    assert.throws(() => pi.startSession({ ...t.opts, mcpConfig: undefined }), /sandboxHome without mcpConfig/)
    assert.equal(existsSync(join(t.dir, 'seen-home')), false)
  })

  test("the owner's home is refused as a sandbox: its config and login survive", () => {
    const t = setup()
    assert.throws(() => pi.startSession({ ...t.opts, sandboxHome: t.realHome }), /sandboxHome is the real home/)
    assert.match(readFileSync(join(t.realHome, '.pi/agent/mcp.json'), 'utf8'), /fermi\.example/)
    assert.equal(existsSync(join(t.realHome, '.pi/agent/auth.json')), true)
  })

  test('outside eval mode pi keeps the caller HOME and writes nothing', async () => {
    const t = setup()
    const { sandboxHome, mcpConfig, ...plain } = t.opts
    await pi.runOnce({ ...plain, prompt: 'turn' }).done.catch(() => {})
    assert.equal(seen(t.dir, 'seen-home'), t.realHome)
    assert.equal(existsSync(join(sandboxHome, '.pi')), false)
  })
})

describe('the eval runner and pi', () => {
  const scenario = {
    name: 'unit',
    fixtures: { bindings: [{ channel: 'sl', sender_id: 'U0EVALOWNER' }] },
    inbound: { channel: 'sl', sender: 'U0EVALOWNER', chat: 'D0EVAL', text: 'hi' },
    expect: [],
  }

  test('passes a temp sandboxHome pointing at its local proxy and removes it', async () => {
    const t = setup()
    let home
    const harness = {
      name: 'pi',
      runOnce(o) {
        home = o.sandboxHome
        return pi.runOnce({ ...o, bin: t.bin, env: { ...o.env, HOME: t.realHome }, prompt: 'turn' })
      },
    }
    const r = await runAttempt({ scenario, attempt: 1, harness, timeoutMs: 10_000, outDir: tmp() })
    assert.deepEqual(r.failed, [])
    assert.equal(seen(t.dir, 'seen-home'), home)
    assert.ok(!home.startsWith(t.realHome))
    const { fermi } = JSON.parse(seen(t.dir, 'seen-mcp.json')).mcpServers
    assert.match(fermi.url, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/)
    assert.equal(existsSync(home), false)
  })

  test('other harnesses get no sandboxHome', async () => {
    let opts
    const events = { on() {} }
    const harness = {
      name: 'claude-code',
      runOnce(o) {
        opts = o
        return { events, done: Promise.resolve({}), close() {} }
      },
    }
    await runAttempt({ scenario, attempt: 1, harness, timeoutMs: 10_000, outDir: tmp() })
    assert.equal('sandboxHome' in opts, false)
  })
})
