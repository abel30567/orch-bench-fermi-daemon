// pr-60: the pi adapter's eval mode runs pi in a sandboxed HOME that only knows
// the localhost eval worker, with a temporary copy of auth.json.
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { piMcpConfig, removeOnExit, runOnce, startSession } from '../harness/pi.mjs'
import { runAttempt } from '../evals/lib/runner.mjs'
import { loadScenario } from '../evals/lib/scenario.mjs'
import { ROOT } from './run-worker.mjs'
import * as fake from '../evals/harness/fake.mjs'

const tmp = () => mkdtempSync(join(tmpdir(), 'pr60-'))
const LOCAL = { mcpServers: { fermi: { type: 'http', url: 'http://127.0.0.1:4100/mcp' } } }
const until = async (cond, ms = 15000) => {
  for (const t0 = Date.now(); !cond(); ) {
    if (Date.now() - t0 > ms) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 20))
  }
}
const AUTH = '{"anthropic":{"type":"oauth","access":"fake-access-token"}}'

// A fake pi that records what it sees on start (HOME, its agent dir, the
// mcp.json and auth.json there), then answers each prompt with an empty run.
const FAKE = `
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
const read = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : null)
const home = process.env.HOME
writeFileSync(process.env.PROBE_OUT, JSON.stringify({
  home, agentDir: process.env.PI_CODING_AGENT_DIR,
  mcp: read(home + '/.pi/agent/mcp.json'), auth: read(home + '/.pi/agent/auth.json'),
}))
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n')
createInterface({ input: process.stdin }).on('line', (l) => {
  const m = JSON.parse(l)
  if (m.type === 'prompt') { out({ type: 'response', command: 'prompt', success: true }); out({ type: 'agent_settled' }) }
})
`

let realHome, savedHome, bin
before(() => {
  // The owner's real HOME: a production mcp.json (unreadable, so any read throws) and an auth.json.
  realHome = tmp()
  const agent = join(realHome, '.pi', 'agent')
  mkdirSync(agent, { recursive: true })
  writeFileSync(join(agent, 'mcp.json'), JSON.stringify({ mcpServers: { fermi: { url: 'https://fermi.example.workers.dev/mcp' } } }))
  chmodSync(join(agent, 'mcp.json'), 0o000)
  writeFileSync(join(agent, 'auth.json'), AUTH)
  savedHome = process.env.HOME
  process.env.HOME = realHome
  const d = tmp()
  writeFileSync(join(d, 'fake.mjs'), FAKE)
  bin = join(d, 'pi')
  writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${join(d, 'fake.mjs')}" "$@"\n`)
  chmodSync(bin, 0o755)
})
after(() => {
  process.env.HOME = savedHome
  chmodSync(join(realHome, '.pi', 'agent', 'mcp.json'), 0o600)
})

describe('pr-60: pi eval mode', () => {
  test('pi runs with HOME=<sandboxHome> and an mcp.json holding only the localhost eval worker', async () => {
    const sandboxHome = tmp()
    const probe = join(tmp(), 'probe.json')
    const mcpFile = join(tmp(), 'mcp.json')
    writeFileSync(mcpFile, JSON.stringify(LOCAL))
    const { outcome } = await runOnce({ bin, prompt: 'x', mcpConfig: mcpFile, sandboxHome, env: { PROBE_OUT: probe, HOME: '/nope', PI_CODING_AGENT_DIR: '/nope' } }).done
    assert.equal(outcome.ok, true)
    const seen = JSON.parse(readFileSync(probe, 'utf8'))
    assert.equal(seen.home, sandboxHome)
    assert.equal(seen.agentDir, join(sandboxHome, '.pi', 'agent'))
    assert.deepEqual(JSON.parse(seen.mcp), { mcpServers: { fermi: { url: 'http://127.0.0.1:4100/mcp' } } })
    assert.doesNotMatch(seen.mcp, /workers\.dev/)
  })

  test('the sandbox auth.json is a copy of the real one during the attempt and is removed after it', async () => {
    const sandboxHome = tmp()
    const probe = join(tmp(), 'probe.json')
    await runOnce({ bin, prompt: 'x', mcpConfig: LOCAL, sandboxHome, env: { PROBE_OUT: probe } }).done
    assert.equal(JSON.parse(readFileSync(probe, 'utf8')).auth, AUTH)
    assert.equal(existsSync(join(sandboxHome, '.pi', 'agent', 'auth.json')), false)
    assert.equal(readFileSync(join(realHome, '.pi', 'agent', 'auth.json'), 'utf8'), AUTH) // the real one is untouched
  })

  test('a closed session removes the sandbox auth.json', async () => {
    const sandboxHome = tmp()
    const probe = join(tmp(), 'probe.json')
    const s = startSession({ bin, mcpConfig: JSON.stringify(LOCAL), sandboxHome, env: { PROBE_OUT: probe } })
    const exited = new Promise((r) => s.events.on('exit', r))
    await until(() => existsSync(probe))
    assert.equal(existsSync(join(sandboxHome, '.pi', 'agent', 'auth.json')), true)
    s.close('SIGTERM')
    await exited
    assert.equal(existsSync(join(sandboxHome, '.pi', 'agent', 'auth.json')), false)
  })

  // removeOnExit's listeners, called in-process with process.kill mocked: a parent
  // process per case slows the suite's timing tests. SIGINT interrupts an attempt
  // with a pi that hangs; the other cases hold a registered sandbox HOME.
  test('an attempt interrupted by SIGINT, SIGTERM, SIGHUP or exit removes the sandbox auth.json and HOME', async (t) => {
    const d = tmp()
    const hang = join(d, 'hang-pi')
    writeFileSync(hang, '#!/bin/sh\nexec cat >/dev/null\n') // cat ends on stdin EOF
    chmodSync(hang, 0o755)
    const evs = ['SIGINT', 'SIGTERM', 'SIGHUP', 'exit']
    const before = Object.fromEntries(evs.map((e) => [e, process.listeners(e)]))
    for (const s of evs.slice(0, 3)) for (const l of before[s]) process.off(s, l)
    t.after(() => {
      for (const e of evs) for (const l of process.listeners(e)) if (!before[e].includes(l)) process.off(e, l)
      for (const s of evs.slice(0, 3)) for (const l of before[s]) process.on(s, l)
    })
    const kills = []
    t.mock.method(process, 'kill', (...a) => kills.push(a))
    const own = () => {} // the process's own SIGTERM listener: no re-raise
    process.on('SIGTERM', own)
    const added = (e) => process.listeners(e).filter((l) => !before[e].includes(l) && l !== own)
    for (const how of evs) {
      const sandboxHome = join(d, how)
      mkdirSync(sandboxHome)
      const auth = join(sandboxHome, '.pi', 'agent', 'auth.json')
      // The attempt registers its auth.json itself; the caller (the runner) registers the HOME.
      const run = how === 'SIGINT' && runOnce({ bin: hang, prompt: 'x', mcpConfig: LOCAL, sandboxHome })
      if (run) {
        const exited = new Promise((r) => run.events.once('exit', r))
        t.after(() => (run.close('SIGKILL'), exited)) // also after a failed assertion, so the hanging pi cannot stall the suite
        assert.equal(readFileSync(auth, 'utf8'), AUTH) // the copy is in place mid-attempt
      } else t.after(removeOnExit(sandboxHome))
      assert.equal(added(how).length, 1, how)
      kills.length = 0
      added(how)[0](how === 'exit' ? 0 : how)
      assert.equal(existsSync(run ? auth : sandboxHome), false, how)
      // A signal nobody else listens for is re-raised, so its default action (termination) still applies.
      assert.deepEqual(kills, how === 'SIGINT' || how === 'SIGHUP' ? [[process.pid, how]] : [], how)
    }
  })

  test('a non-localhost or url-less MCP server refuses to start, before pi or the sandbox', () => {
    for (const server of [{ url: 'https://fermi.example.workers.dev/mcp' }, { url: 'http://10.0.0.5/mcp' }, { command: 'npx', args: ['some-mcp'] }]) {
      const sandboxHome = tmp()
      const cfg = { mcpServers: { ...LOCAL.mcpServers, other: server } }
      assert.throws(() => piMcpConfig(cfg), /refusing to start: non-localhost/)
      assert.throws(() => runOnce({ bin, prompt: 'x', mcpConfig: cfg, sandboxHome }), /refusing to start: non-localhost/)
      assert.equal(existsSync(join(sandboxHome, '.pi')), false)
    }
  })

  test('mcpConfig without sandboxHome, or the real HOME as sandboxHome, is refused', () => {
    assert.throws(() => runOnce({ bin, prompt: 'x', mcpConfig: LOCAL }), /mcpConfig without sandboxHome/)
    assert.throws(() => runOnce({ bin, prompt: 'x', mcpConfig: LOCAL, sandboxHome: realHome }), /real HOME/)
    assert.equal(readFileSync(join(realHome, '.pi', 'agent', 'auth.json'), 'utf8'), AUTH)
  })

  test('the eval runner gives pi a temporary sandboxHome and removes it after the attempt', async () => {
    const seen = []
    const asHarness = (name) => ({ name, runOnce: (o) => (seen.push({ name, home: o.sandboxHome, existed: o.sandboxHome && existsSync(o.sandboxHome) }), fake.runOnce(o)) })
    const scenario = loadScenario(join(ROOT, 'evals/scenarios/examples', 'reply-contract.json'))
    for (const name of ['pi', 'claude-code']) {
      const r = await runAttempt({ scenario, attempt: 1, harness: asHarness(name), timeoutMs: 10_000, outDir: tmp() })
      assert.equal(r.pass, true, JSON.stringify(r.failed))
    }
    assert.equal(seen[0].existed, true)
    assert.equal(existsSync(seen[0].home), false)
    assert.equal(seen[1].home, undefined)
  })
})
