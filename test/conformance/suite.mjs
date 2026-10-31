// Harness adapter conformance suite (see harness/index.mjs for the contract).
// Each adapter test file runs it against a fake harness binary
// (./fake-<harness>.mjs) that replays test/fixtures/harness/<harness>/<name>.jsonl,
// the fixture being named by the turn's text (session) or prompt (runOnce).
//
//   runConformance(loadAdapter, { name, options }, { expectedFail })
//     loadAdapter  () => Promise<adapter module>
//     options      merged into every startSession/runOnce call (e.g. { bin })
//     expectedFail { [checkId]: reason } — those checks still run and must fail;
//                  one that starts passing fails the suite (drop it from the list).
import { describe, test, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { supervise } from '../../harness/supervise.mjs'

const NARRATOR = join(dirname(fileURLToPath(import.meta.url)), '../../narrator.py')
const TURN_MS = 5000 // fixture turns finish in milliseconds; this only bounds a broken adapter
const ERROR_KINDS = ['api_error', 'auth', 'context_overflow', 'rate_limit', 'spend_limit', 'unknown_error']
const hasPython = spawnSync('python3', ['-c', ''], { stdio: 'ignore' }).status === 0

// Resolve with the first event of `type` matching `pred` (rejects after ms).
function waitFor(emitter, type, pred = () => true, ms = TURN_MS) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      emitter.off('event', on)
      reject(new Error(`no ${type} event within ${ms}ms`))
    }, ms)
    const on = (ev) => {
      if (ev.type !== type || !pred(ev)) return
      clearTimeout(timer)
      emitter.off('event', on)
      resolve(ev)
    }
    emitter.on('event', on)
  })
}

const waitExit = (emitter, ms = TURN_MS) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no exit within ${ms}ms`)), ms)
    emitter.once('exit', (code) => {
      clearTimeout(timer)
      resolve(code)
    })
  })

// Send one turn; resolve with { events, end } (every event up to and including its turn_end).
async function turn(session, text) {
  const events = []
  const on = (ev) => events.push(ev)
  session.events.on('event', on)
  try {
    const ended = waitFor(session.events, 'turn_end')
    assert.notEqual(session.send(text), false, 'send() refused')
    const end = await ended
    return { events, end }
  } finally {
    session.events.off('event', on)
  }
}

export function runConformance(loadAdapter, { name, options = {} }, { expectedFail = {} } = {}) {
  const fakeDir = mkdtempSync(join(tmpdir(), `conformance-${name}-`))
  process.env.FAKE_DIR = fakeDir
  const open = [] // sessions to close when the suite ends
  let adapter

  const session = async (extra = {}) => {
    adapter ??= await loadAdapter()
    const s = adapter.startSession({ model: 'claude-sonnet-5', systemPrompt: 'conformance', cwd: fakeDir, ...options, ...extra })
    open.push(s)
    return s
  }
  // Run fn with a fresh session, always closing it.
  const withSession = async (fn, extra) => {
    const s = await session(extra)
    try {
      return await fn(s)
    } finally {
      s.close('SIGKILL')
    }
  }

  const checks = {
    // init is optional (pi has none); when emitted it comes first and is well-formed.
    init: () =>
      withSession(async (s) => {
        const { events } = await turn(s, 'turn')
        const inits = events.filter((e) => e.type === 'init')
        assert.ok(inits.length <= 1, 'at most one init per turn')
        if (inits.length) {
          assert.equal(events[0].type, 'init', 'init precedes the turn')
          assert.equal(inits[0].harness, adapter.name)
          assert.ok(Array.isArray(inits[0].tools), 'init.tools is an array')
        }
      }),

    turn: () =>
      withSession(async (s) => {
        const raw = []
        s.events.on('raw', (l) => raw.push(l))
        const { events, end } = await turn(s, 'turn')
        assert.ok(raw.length > 0, "native lines are emitted as 'raw'")
        assert.deepEqual(events.filter((e) => e.type === 'text').map((e) => e.text), ['OK'])
        assert.equal(events.at(-1), end, 'turn_end is the last event of the turn')
        assert.equal(end.ok, true)
        assert.equal(end.kind, 'ok')
        assert.equal(typeof end.detail, 'string')
        assert.ok(Number.isFinite(end.durationMs) && end.durationMs >= 0, 'durationMs is a number')
        assert.ok('raw' in end, 'turn_end carries the raw record')
        assert.equal(s.alive, true, 'session stays alive between turns')
        const again = await turn(s, 'turn')
        assert.equal(again.end.ok, true, 'a second turn on the same session ends ok')
      }),

    // Tool names are bare (MCP prefixes stripped) and match Claude Code's spelling.
    tool_names: () =>
      withSession(async (s) => {
        const calls = (await turn(s, 'tools')).events.filter((e) => e.type === 'tool_call')
        assert.deepEqual(calls.map((c) => c.name), ['task_claim', 'skill_load', 'browser_navigate', 'Bash'])
        for (const c of calls) assert.ok(c.rawName.endsWith(c.name) && c.rawName.length >= c.name.length, `rawName ${c.rawName} keeps the native name`)
        assert.deepEqual(calls.find((c) => c.name === 'skill_load').input, { slug: 'web-forms' })
      }),

    // Every tool_result pairs with an earlier tool_call by id (even out of order), content is a string, ok reflects errors.
    tool_results: () =>
      withSession(async (s) => {
        const { events, end } = await turn(s, 'tools')
        const seen = new Set()
        const results = []
        for (const e of events) {
          if (e.type === 'tool_call') seen.add(e.id)
          if (e.type === 'tool_result') {
            assert.ok(seen.has(e.id), `tool_result ${e.id} follows its tool_call`)
            assert.equal(typeof e.content, 'string')
            results.push(e)
          }
        }
        assert.equal(results.length, seen.size, 'one result per call')
        const ids = [...seen]
        assert.ok(results.findIndex((r) => r.id === ids[2]) < results.findIndex((r) => r.id === ids[1]), 'out-of-order results keep their ids')
        assert.deepEqual(results.map((r) => r.ok), [true, true, true, false])
        assert.match(results.at(-1).content, /command not found/)
        assert.match(results[0].content, /task_1/)
        assert.equal(end.ok, true, 'a failed tool does not fail the turn')
      }),

    interrupt: () =>
      withSession(async (s) => {
        const texts = []
        s.events.on('event', (e) => e.type === 'text' && texts.push(e.text))
        const ended = waitFor(s.events, 'turn_end')
        const started = waitFor(s.events, 'text', (e) => e.text === 'Working on it')
        s.send('slow')
        await started
        const t0 = Date.now()
        assert.notEqual(s.interrupt(), false)
        const end = await ended
        assert.ok(Date.now() - t0 < 3000, 'interrupt ends the turn promptly')
        assert.equal(end.ok, false, 'an interrupted turn is not ok')
        assert.ok(!texts.includes('late'), 'the rest of the turn is dropped')
        assert.equal(s.alive, true, 'the session survives the interrupt')
        assert.equal((await turn(s, 'turn')).end.ok, true, 'the next turn runs normally')
      }),

    timeout: () =>
      withSession(async (raw) => {
        const s = supervise(raw, { turnTimeoutMs: 300 })
        const exited = waitExit(s.events)
        const { end } = await turn(s, 'hang')
        assert.equal(end.ok, false)
        assert.equal(end.kind, 'timeout')
        await exited
      }),

    crash: () =>
      withSession(async (raw) => {
        const s = supervise(raw)
        const exited = waitExit(s.events)
        const { events, end } = await turn(s, 'crash')
        assert.ok(events.some((e) => e.type === 'text' && e.text === 'About to crash'))
        assert.equal(end.ok, false)
        assert.equal(end.kind, 'crash')
        assert.equal(await exited, 1, "'exit' carries the code")
      }),

    error_kinds: () =>
      withSession(async (s) => {
        for (const kind of ERROR_KINDS) {
          const { end } = await turn(s, `error-${kind}`)
          assert.equal(end.ok, false, kind)
          assert.equal(end.kind, kind, `error-${kind} classifies as ${kind} (detail: ${end.detail})`)
        }
        assert.equal((await turn(s, 'turn')).end.ok, true, 'the session recovers after errors')
      }),

    run_once: async () => {
      adapter ??= await loadAdapter()
      const ok = adapter.runOnce({ prompt: 'turn', cwd: fakeDir, ...options })
      const r = await withTimeout(ok.done)
      assert.equal(r.code, 0)
      assert.equal(r.outcome?.type, 'turn_end')
      assert.equal(r.outcome.ok, true)
      assert.ok(r.events.some((e) => e.type === 'text' && e.text === 'OK'))
      assert.equal(typeof r.stderr, 'string')
      const bad = await withTimeout(adapter.runOnce({ prompt: 'error-auth', cwd: fakeDir, ...options }).done)
      assert.equal(bad.outcome?.kind, 'auth')
    },

    // The narrator (narrator.py) reading this adapter's normalized event log never posts a secret.
    secrets: async () => {
      const dir = mkdtempSync(join(fakeDir, 'narrator-'))
      const { events } = await withSession((s) => turn(s, 'secrets'))
      const log = join(dir, 'run.log')
      writeFileSync(join(dir, 'run.events.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n')
      mkdirSync(join(dir, 'home/fermi-daemon'), { recursive: true })
      writeFileSync(join(dir, 'home/fermi-daemon/.env'), 'FERMI_URL=http://127.0.0.1:9\nFERMI_BEARER_TOKEN=narrator-test\n')
      mkdirSync(join(dir, 'bin'))
      const posts = join(dir, 'posts')
      writeFileSync(join(dir, 'bin/curl'), '#!/bin/sh\nwhile [ $# -gt 0 ]; do [ "$1" = "-d" ] && printf \'%s\\n\' "$2" >> "$POSTS"; shift; done\n')
      chmodSync(join(dir, 'bin/curl'), 0o755)
      const r = spawnSync('python3', [NARRATOR, log], {
        env: { ...process.env, HOME: join(dir, 'home'), PATH: `${join(dir, 'bin')}:${process.env.PATH}`, POSTS: posts, NARRATOR_MIN_INTERVAL: '0' },
        encoding: 'utf8',
        timeout: 10_000,
      })
      assert.equal(r.status, 0, r.stderr)
      const sent = readFileSync(posts, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
      assert.equal(sent.length, 3, 'two shell commands and one navigation are narrated')
      for (const p of sent) assert.deepEqual([p.channel, p.chat_id], ['wa', '+15555550100'])
      const all = sent.map((p) => p.text).join('\n')
      assert.doesNotMatch(all, /s3cr3t/)
      assert.equal(all.match(/«redacted»/g)?.length, 3)
    },

    // The OAuth token reaches the harness only through tokenFd: never argv, never the env its tools inherit.
    credential_isolation: async () => {
      const token = `sk-ant-oat01-conformance-${process.pid}-${Date.now()}`
      const file = join(fakeDir, 'token')
      writeFileSync(file, token + '\n', { mode: 0o600 })
      const fd = openSync(file, 'r')
      rmSync(join(fakeDir, 'cred.json'), { force: true })
      rmSync(join(fakeDir, 'child-env.json'), { force: true })
      try {
        await withSession(async (s) => assert.equal((await turn(s, 'credentials')).end.ok, true), { tokenFd: fd })
      } finally {
        closeSync(fd)
      }
      const cred = JSON.parse(readFileSync(join(fakeDir, 'cred.json'), 'utf8'))
      assert.equal(cred.tokenSha256, createHash('sha256').update(token).digest('hex'), 'the harness got the token')
      assert.ok(!cred.argv.some((a) => a.includes(token)), 'token not in argv')
      assert.ok(!readFileSync(join(fakeDir, 'child-env.json'), 'utf8').includes(token), "token not in the tool's environment")
    },
  }

  describe(`harness conformance: ${name}`, () => {
    after(() => {
      for (const s of open) s.close('SIGKILL')
      rmSync(fakeDir, { recursive: true, force: true })
    })
    for (const id of Object.keys(expectedFail)) assert.ok(id in checks, `expectedFail names unknown check ${id}`)
    for (const [id, check] of Object.entries(checks)) {
      if (id in expectedFail)
        test(`${id} (expected failure: ${expectedFail[id]})`, () =>
          assert.rejects(check, `${id} now passes: remove it from expectedFail`))
      else test(id, { skip: id === 'secrets' && !hasPython && 'python3 not found' }, check)
    }
  })
}

function withTimeout(p, ms = TURN_MS) {
  let timer
  return Promise.race([p, new Promise((_, rej) => (timer = setTimeout(() => rej(new Error(`not done within ${ms}ms`)), ms)))]).finally(() =>
    clearTimeout(timer),
  )
}
