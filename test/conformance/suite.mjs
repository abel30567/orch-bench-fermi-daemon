// Harness adapter conformance suite (harness/index.mjs contract), run once per
// adapter against its fake (./fake-*.mjs), which replays the shared fixtures in
// test/fixtures/harness/<name>/.
//
//   runConformance(load, { name, options }, { expectedFail? })
//
// load          () => import(adapter module)
// options       extra adapter options (at least `bin`, the fake's launcher)
// expectedFail  { caseName: reason }: a known gap. The case still runs and must
//               FAIL (node:test `todo`); one that starts passing is reported, so
//               a closed gap gets its entry removed.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const TURN_KINDS = ['ok', 'spend_limit', 'rate_limit', 'context_overflow', 'api_error', 'auth', 'unknown_error']
const ERRORS = ['spend_limit', 'rate_limit', 'context_overflow', 'api_error', 'auth', 'unknown_error']

const withTimeout = (p, ms, what) =>
  Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${what}: no answer in ${ms}ms`)), ms).unref())])

// Send one session turn and resolve with its events up to turn_end.
function sessionTurn(s, text, ms = 8000) {
  const seen = []
  return withTimeout(
    new Promise((resolve) => {
      const on = (ev) => {
        seen.push(ev)
        if (ev.type === 'turn_end') {
          s.events.off('event', on)
          resolve(seen)
        }
      }
      s.events.on('event', on)
      s.send(text)
    }),
    ms,
    `turn "${text}"`,
  )
}

const exitOf = (s) => new Promise((r) => s.events.once('exit', r))

export function runConformance(load, { name, options = {} }, { expectedFail = {} } = {}) {
  const fakeDir = () => mkdtempSync(join(tmpdir(), `conf-${name}-`))
  const opts = (extra = {}) => {
    const dir = fakeDir()
    return { dir, o: { cwd: dir, ...options, ...extra, env: { FAKE_DIR: dir, ...options.env, ...extra.env } } }
  }
  const cases = {}
  const add = (id, fn) => (cases[id] = fn)

  add('session_turn', async (a) => {
    const { o } = opts()
    const s = a.startSession(o)
    try {
      assert.equal(typeof s.pid, 'number')
      assert.equal(s.alive, true)
      const evs = await sessionTurn(s, 'turn')
      assert.deepEqual(evs.filter((e) => e.type === 'text').map((e) => e.text), ['OK'])
      const end = evs.at(-1)
      assert.equal(end.ok, true)
      assert.equal(end.kind, 'ok')
      assert.equal(typeof end.durationMs, 'number')
      // the same session takes a second turn
      assert.equal((await sessionTurn(s, 'turn')).at(-1).kind, 'ok')
    } finally {
      s.close('SIGKILL')
    }
  })

  add('raw_lines', async (a) => {
    const { o } = opts()
    const s = a.startSession(o)
    const raw = []
    s.events.on('raw', (l) => raw.push(l))
    try {
      await sessionTurn(s, 'turn')
      assert.ok(raw.length > 0)
      for (const l of raw) assert.doesNotThrow(() => JSON.parse(l), l)
    } finally {
      s.close('SIGKILL')
    }
  })

  add('tool_names', async (a) => {
    const { o } = opts()
    const s = a.startSession(o)
    try {
      const evs = await sessionTurn(s, 'tools')
      const calls = evs.filter((e) => e.type === 'tool_call')
      assert.deepEqual(calls.map((e) => e.name), ['task_claim', 'skill_load', 'browser_navigate', 'Bash'])
      const results = evs.filter((e) => e.type === 'tool_result')
      assert.equal(results.length, calls.length)
      for (const r of results) assert.ok(calls.some((c) => c.id === r.id), `tool_result ${r.id} has a tool_call`)
      assert.equal(results.find((r) => r.id === calls[3].id).ok, false)
      for (const r of results) assert.equal(typeof r.content, 'string')
    } finally {
      s.close('SIGKILL')
    }
  })

  for (const kind of ERRORS) {
    add(`error_${kind}`, async (a) => {
      const { o } = opts()
      const s = a.startSession(o)
      try {
        const end = (await sessionTurn(s, `error-${kind}`)).at(-1)
        assert.equal(end.ok, false)
        assert.equal(end.kind, kind)
        assert.ok(TURN_KINDS.includes(end.kind))
      } finally {
        s.close('SIGKILL')
      }
    })
  }

  add('interrupt', async (a) => {
    const { o } = opts()
    const s = a.startSession(o)
    try {
      const turn = sessionTurn(s, 'slow', 5000)
      await new Promise((r) => {
        const on = (ev) => ev.type === 'text' && (s.events.off('event', on), r())
        s.events.on('event', on)
      })
      s.interrupt()
      const end = (await turn).at(-1)
      assert.equal(end.ok, false)
      assert.equal(s.alive, true, 'the session survives an interrupt')
      assert.equal((await sessionTurn(s, 'turn')).at(-1).kind, 'ok')
    } finally {
      s.close('SIGKILL')
    }
  })

  add('crash_exit', async (a) => {
    const { o } = opts()
    const s = a.startSession(o)
    const exit = exitOf(s)
    s.send('crash')
    assert.equal(await withTimeout(exit, 8000, 'exit'), 1)
  })

  add('close', async (a) => {
    const { o } = opts()
    const s = a.startSession(o)
    const exit = exitOf(s)
    s.send('hang')
    s.close('SIGKILL')
    await withTimeout(exit, 8000, 'exit')
  })

  add('run_once', async (a) => {
    const { o } = opts()
    const run = a.runOnce({ ...o, prompt: 'turn' })
    const r = await withTimeout(run.done, 8000, 'runOnce')
    assert.equal(r.code, 0)
    assert.equal(r.outcome?.kind, 'ok')
    assert.ok(r.events.some((e) => e.type === 'text' && e.text === 'OK'))
    assert.equal(typeof r.stderr, 'string')
  })

  add('run_once_crash', async (a) => {
    const { o } = opts()
    const r = await withTimeout(a.runOnce({ ...o, prompt: 'crash' }).done, 8000, 'runOnce')
    assert.equal(r.code, 1)
    assert.equal(r.outcome, null)
  })

  add('run_once_spawn_error', async (a) => {
    const { o } = opts()
    const run = a.runOnce({ ...o, bin: join(fakeDir(), 'missing-bin'), prompt: 'turn' })
    const err = new Promise((r) => run.events.once('error', r))
    const r = await withTimeout(run.done, 8000, 'runOnce')
    assert.equal(r.outcome, null)
    assert.match(String((await withTimeout(err, 1000, 'error event')).message), /ENOENT/)
  })

  add('credential_isolation', async (a) => {
    const { dir, o } = opts()
    const token = 'conformance-token-' + process.pid
    const tokFile = join(dir, 'token')
    writeFileSync(tokFile, token)
    const fd = openSync(tokFile, 'r')
    let s
    try {
      s = a.startSession({ ...o, tokenFd: fd })
      await sessionTurn(s, 'credentials')
    } finally {
      s?.close('SIGKILL')
      closeSync(fd)
    }
    const cred = JSON.parse(readFileSync(join(dir, 'cred.json'), 'utf8'))
    assert.equal(cred.tokenSha256, createHash('sha256').update(token).digest('hex'), 'the harness got the credential')
    assert.ok(!cred.argv.join(' ').includes(token), 'not in argv')
    assert.ok(existsSync(join(dir, 'child-env.json')))
    assert.ok(!readFileSync(join(dir, 'child-env.json'), 'utf8').includes(token), 'not visible to tool children')
  })

  describe(`harness conformance: ${name}`, () => {
    for (const id of Object.keys(expectedFail))
      if (!cases[id]) test(`expectedFail names a known case: ${id}`, () => assert.fail(`no case "${id}"`))
    for (const [id, fn] of Object.entries(cases)) {
      const reason = expectedFail[id]
      if (reason) test(`${id} (expected fail: ${reason})`, { todo: reason }, async () => fn(await load()))
      else test(id, async () => fn(await load()))
    }
  })
}
