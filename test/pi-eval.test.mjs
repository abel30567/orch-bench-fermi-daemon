// DMN: pi adapter eval mode. With mcpConfig + sandboxHome, pi runs in a sandbox
// HOME whose mcp.json holds only the localhost eval worker; the copied auth.json
// is gone after the attempt; a non-localhost server refuses to start.
import { test, describe, after } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as pi from '../harness/pi.mjs'
import { runAttempt } from '../evals/lib/runner.mjs'
import * as fake from '../evals/harness/fake.mjs'

const FAKE = join(dirname(fileURLToPath(import.meta.url)), 'conformance/fake-pi.mjs')
const dirs = []
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'pi-eval-'))
  dirs.push(d)
  return d
}
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })))

// A fake pi that records HOME, its agent dir, the mcp.json and auth.json it sees, then speaks RPC.
function fakePi(dir) {
  const bin = join(dir, 'pi')
  writeFileSync(
    bin,
    `#!/bin/sh
{
  printf 'HOME=%s\\n' "$HOME"
  printf 'AGENT=%s\\n' "$PI_CODING_AGENT_DIR"
} > "${dir}/seen-env"
cp "$HOME/.pi/agent/mcp.json" "${dir}/seen-mcp.json"
cp "$HOME/.pi/agent/auth.json" "${dir}/seen-auth.json" 2>/dev/null
exec "${process.execPath}" "${FAKE}" "$@"
`,
  )
  chmodSync(bin, 0o755)
  return bin
}

// A real $HOME whose ~/.pi/agent points at production Fermi; its mcp.json is unreadable, so any read fails.
function realHome() {
  const home = tmp()
  const agent = join(home, '.pi/agent')
  mkdirSync(agent, { recursive: true })
  writeFileSync(join(agent, 'mcp.json'), JSON.stringify({ mcpServers: { fermi: { url: 'https://fermi.example.workers.dev/mcp' } } }))
  chmodSync(join(agent, 'mcp.json'), 0o000)
  writeFileSync(join(agent, 'auth.json'), JSON.stringify({ anthropic: { type: 'oauth', access: 'tok-real' } }))
  return home
}

async function withHome(home, fn) {
  const prev = process.env.HOME
  process.env.HOME = home
  try {
    return await fn()
  } finally {
    process.env.HOME = prev
  }
}

const LOCAL = { mcpServers: { fermi: { type: 'http', url: 'http://127.0.0.1:4567/mcp' } } }

describe('pi eval mode: sandbox HOME', () => {
  test('AC1: pi runs with HOME=<sandboxHome>; its mcp.json holds only the localhost eval worker; the real mcp.json is never read', async () => {
    const dir = tmp()
    const sandboxHome = tmp()
    const home = realHome()
    const cfg = join(dir, 'mcp.json')
    writeFileSync(cfg, JSON.stringify(LOCAL))
    const { code, outcome } = await withHome(home, () => pi.runOnce({ bin: fakePi(dir), prompt: 'turn', cwd: dir, mcpConfig: cfg, sandboxHome }).done)
    assert.equal(code, 0)
    assert.equal(outcome?.ok, true)
    assert.deepEqual(readFileSync(join(dir, 'seen-env'), 'utf8').trim().split('\n'), [`HOME=${sandboxHome}`, `AGENT=${join(sandboxHome, '.pi/agent')}`])
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'seen-mcp.json'), 'utf8')), { mcpServers: { fermi: { type: 'http', url: 'http://127.0.0.1:4567/mcp' } } })
    assert.doesNotMatch(readFileSync(join(dir, 'seen-mcp.json'), 'utf8'), /workers\.dev/)
    // Inference login: pi saw the copied credential.
    assert.equal(JSON.parse(readFileSync(join(dir, 'seen-auth.json'), 'utf8')).anthropic.access, 'tok-real')
  })

  test('AC2: the sandbox auth.json is removed after the attempt (runOnce and a closed session)', async () => {
    const home = realHome()
    for (const mode of ['runOnce', 'session']) {
      const dir = tmp()
      const sandboxHome = tmp()
      const auth = join(sandboxHome, '.pi/agent/auth.json')
      await withHome(home, async () => {
        if (mode === 'runOnce') {
          await pi.runOnce({ bin: fakePi(dir), prompt: 'turn', cwd: dir, mcpConfig: LOCAL, sandboxHome }).done
        } else {
          const s = pi.startSession({ bin: fakePi(dir), cwd: dir, mcpConfig: JSON.stringify(LOCAL), sandboxHome })
          assert.equal(existsSync(auth), true, 'copied for the attempt')
          const ended = new Promise((r) => s.events.on('event', (e) => e.type === 'turn_end' && r()))
          s.send('turn')
          await ended
          const exited = new Promise((r) => s.events.on('exit', r))
          s.close('SIGTERM')
          await exited
          await new Promise((r) => setImmediate(r))
        }
      })
      assert.ok(existsSync(join(dir, 'seen-auth.json')), `${mode}: pi had the credential during the attempt`)
      assert.equal(existsSync(auth), false, `${mode}: sandbox auth.json removed`)
      assert.equal(existsSync(join(home, '.pi/agent/auth.json')), true, `${mode}: the real auth.json is untouched`)
    }
  })

  test('AC3: a non-localhost or url-less server in the MCP config refuses to start', () => {
    const dir = tmp()
    const bin = fakePi(dir)
    const cases = [
      { fermi: { type: 'http', url: 'https://fermi.example.workers.dev/mcp' } },
      { fermi: LOCAL.mcpServers.fermi, prod: { url: 'http://10.0.0.5/mcp' } },
      { fermi: { type: 'http', url: 'http://localhost.evil.com/mcp' } },
      { shell: { command: 'npx', args: ['some-mcp'] } },
      { fermi: { url: 'http://127.0.0.1:1/mcp', headers: { 'X-Next': 'https://fermi.example.workers.dev' } } },
    ]
    for (const mcpServers of cases) {
      assert.throws(() => pi.piMcpConfig({ mcpServers }), /^Error: refusing to start: non-localhost/)
      const sandboxHome = tmp()
      assert.throws(() => pi.runOnce({ bin, prompt: 'turn', cwd: dir, mcpConfig: { mcpServers }, sandboxHome }), /refusing to start: non-localhost/)
      assert.equal(existsSync(join(sandboxHome, '.pi/agent/mcp.json')), false, 'nothing written')
      assert.equal(existsSync(join(sandboxHome, '.pi/agent/auth.json')), false, 'no credential copied')
    }
    assert.equal(existsSync(join(dir, 'seen-env')), false, 'pi never started')
  })

  test('mcpConfig without sandboxHome is refused; piMcpConfig keeps only localhost http servers', () => {
    assert.throws(() => pi.runOnce({ bin: fakePi(tmp()), prompt: 'turn', mcpConfig: LOCAL }), /mcpConfig without sandboxHome/)
    assert.deepEqual(pi.piMcpConfig(JSON.stringify(LOCAL)), LOCAL)
    assert.deepEqual(pi.piMcpConfig({ mcpServers: { a: { url: 'http://localhost:9/mcp' } } }), { mcpServers: { a: { type: 'http', url: 'http://localhost:9/mcp' } } })
  })

  test('the eval runner passes a temp sandboxHome to pi (and not to other harnesses), removed after the attempt', async () => {
    const seen = []
    const spy = (name) => ({ name, runOnce: (o) => (seen.push({ name, home: o.sandboxHome }), fake.runOnce(o)) })
    const s = {
      name: 'unit',
      fixtures: { bindings: [{ channel: 'sl', sender_id: 'U0EVALOWNER' }] },
      inbound: { channel: 'sl', sender: 'U0EVALOWNER', chat: 'D0EVAL', text: 'hi' },
      expect: [],
      fake: { script: [{ text: 'ok' }] },
    }
    for (const name of ['pi', 'fake']) await runAttempt({ scenario: s, attempt: 1, harness: spy(name), timeoutMs: 10_000, outDir: tmp() })
    assert.equal(seen[0].name, 'pi')
    assert.match(seen[0].home, /fermi-eval-home-/)
    assert.equal(existsSync(seen[0].home), false, 'temp HOME removed')
    assert.equal(seen[1].home, undefined)
  })
})
