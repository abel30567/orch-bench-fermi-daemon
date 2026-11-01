// DMN-12: the core scenario pack (evals/scenarios/core). Every scenario has a
// `<name>-neg` negative control with the same fixtures, faults, inbound and expect
// and a misbehaving fake script; the pack passes when every positive passes and
// every negative fails on its assertions.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ROOT } from './run-worker.mjs'
import { coreTools, PROFILE_BUDGETS } from '../evals/lib/fake-target-tools.mjs'
import { loadScenario } from '../evals/lib/scenario.mjs'
import { evaluate, falsePromises, internalToolCalls } from '../evals/lib/assertions.mjs'

const CORE = join(ROOT, 'evals/scenarios/core')
const PRELOAD = join(ROOT, 'test/fixtures/localhost-only.mjs')
const files = readdirSync(CORE).filter((f) => f.endsWith('.json')).sort()
const all = Object.fromEntries(files.map((f) => [f.replace(/\.json$/, ''), loadScenario(join(CORE, f))]))
const positives = Object.keys(all).filter((n) => !n.endsWith('-neg'))
// The runner refuses non-localhost URLs in these, so a developer's shell must not leak them in.
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(FERMI_URL|MACOS_MCP_URL|\w+_API_BASE)$/.test(k)))
const same = (s) => JSON.stringify({ fixtures: s.fixtures, faults: s.faults, inbound: s.inbound, expect: s.expect })

describe('core pack shape', () => {
  test('at least 20 scenarios, each with a negative control', () => {
    assert.ok(positives.length >= 20, `${positives.length} scenarios`)
    assert.equal(files.length, positives.length * 2, 'every file is a scenario or its -neg control')
    for (const n of positives) {
      const neg = all[`${n}-neg`]
      assert.ok(neg, `${n} has no ${n}-neg`)
      assert.equal(all[n].expectOutcome, undefined, `${n} must be expected to pass`)
      assert.equal(neg.expectOutcome, 'fail', `${n}-neg must be expected to fail`)
      assert.equal(same(neg), same(all[n]), `${n}-neg must differ from ${n} only in its script`)
      assert.notDeepEqual(neg.fake.script, all[n].fake.script, `${n}-neg needs a misbehaving script`)
    }
  })

  test('fixtures use placeholders only', () => {
    const text = files.map((f) => readFileSync(join(CORE, f), 'utf8')).join('\n')
    for (const [, num] of text.matchAll(/\+1(\d{10})/g)) assert.match(num, /^555555/, `non-placeholder number +1${num}`)
    for (const [host] of text.matchAll(/https?:\/\/([\w.-]+)/g)) assert.match(host, /example\.com|x\.com/, `non-placeholder host ${host}`)
  })
})

describe('fake target core tools (ported from fermi-mcp)', () => {
  const db = () => ({ profile: { user: 'Name: Eval Owner.' }, memories: [], schedules: [], skills: [{ slug: 'household-finance', name: 'household-finance', allowed_tools: null }] })

  test('profile_update: over_budget leaves the doc unchanged; consolidating then retrying succeeds', () => {
    const d = db()
    const t = coreTools(d, new Map())
    d.profile.user = 'Name: Eval Owner.\nNotes: ' + 'x'.repeat(PROFILE_BUDGETS.user - 30)
    const before = d.profile.user
    assert.deepEqual(t.profile_update({ target: 'user', action: 'add', content: 'No emoji sign-offs please.' }), { ok: false, error: 'over_budget', usage: before.length + 27, limit: PROFILE_BUDGETS.user })
    assert.equal(d.profile.user, before)
    assert.equal(t.profile_update({ target: 'user', action: 'replace', match: 'Notes:', content: 'Notes: short.' }).ok, true)
    assert.equal(t.profile_update({ target: 'user', action: 'add', content: 'No emoji sign-offs please.' }).ok, true)
    assert.equal(d.profile.user, 'Name: Eval Owner.\nNotes: short.\nNo emoji sign-offs please.')
  })

  test('schedule_create: cadence below 5 minutes is rejected and nothing is stored', () => {
    const d = db()
    const t = coreTools(d, new Map())
    const base = { channel: 'sl', chat_id: 'D0EVAL', prompt: 'Delivery: always message.' }
    assert.deepEqual(t.schedule_create({ ...base, every_minutes: 1 }), { ok: false, error: 'every_minutes_out_of_range' })
    assert.deepEqual(t.schedule_create({ ...base, every_minutes: 5, at: '2099-01-01T00:00:00Z' }), { ok: false, error: 'exactly_one_of_every_or_at' })
    assert.equal(d.schedules.length, 0)
    assert.equal(t.schedule_create({ ...base, every_minutes: 5 }).ok, true)
    assert.equal(d.schedules[0].every_minutes, 5)
  })

  test('skill_load returns the seeded body, or skill_not_found', () => {
    const t = coreTools(db(), new Map([['household-finance', 'never move money']]))
    assert.equal(t.skill_load({ slug: 'household-finance' }).body, 'never move money')
    assert.deepEqual(t.skill_load({ slug: 'finance' }), { error: 'skill_not_found', slug: 'finance' })
  })
})

describe('core pack under the fake harness', () => {
  test('positives pass, negatives fail on their assertions, exit 0', () => {
    const out = mkdtempSync(join(tmpdir(), 'dmn12-'))
    const r = spawnSync(process.execPath, ['--import', PRELOAD, join(ROOT, 'evals/run.mjs'), '--harness', 'fake', '--scenarios', `${CORE}/*`, '--out', out], {
      cwd: ROOT,
      env,
      encoding: 'utf8',
      timeout: 120_000,
    })
    assert.equal(r.status, 0, r.stdout + r.stderr)
    const summary = JSON.parse(readFileSync(join(out, 'summary.json'), 'utf8'))
    assert.equal(summary.ok, true)
    assert.equal(summary.scenarios, files.length)
    for (const res of JSON.parse(readFileSync(join(out, 'results.json'), 'utf8'))) {
      if (res.scenario.endsWith('-neg')) {
        assert.equal(res.pass, false, `${res.scenario} passed`)
        // A runner error or a broken run is not a valid negative control.
        assert.ok(res.failed.every((f) => f.assertion !== null), `${res.scenario}: ${JSON.stringify(res.failed)}`)
      } else assert.equal(res.pass, true, `${res.scenario}: ${JSON.stringify(res.failed)}`)
    }
  })
})

describe('grading fidelity (first live baseline triage)', () => {
  const runPack = (...scenarios) => {
    const out = mkdtempSync(join(tmpdir(), 'fidelity-'))
    const r = spawnSync(process.execPath, ['--import', PRELOAD, join(ROOT, 'evals/run.mjs'), '--harness', 'fake', '--scenarios', ...scenarios, '--out', out], { cwd: ROOT, env, encoding: 'utf8', timeout: 60_000 })
    assert.equal(r.status, 0, r.stdout + r.stderr)
    return JSON.parse(readFileSync(join(out, 'results.json'), 'utf8'))
  }

  test('maxToolCalls counts Fermi calls only; internal calls are reported as internalToolCalls', () => {
    const [res] = runPack(join(CORE, 'drain-stop-on-empty.json'))
    assert.equal(res.pass, true, JSON.stringify(res.failed))
    assert.deepEqual(res.internalToolCalls, ['ToolSearch'])
    assert.equal(res.toolCalls.length, 6) // ToolSearch + 5 Fermi calls under maxToolCalls: 5
    assert.equal(res.toolCalls[0], 'ToolSearch')
    const [neg] = runPack(join(CORE, 'drain-stop-on-empty-neg.json'))
    assert.deepEqual(neg.internalToolCalls, [])
  })

  test('internalToolCalls names the non-Fermi calls; maxToolCalls still trips on Fermi calls', () => {
    const fermi = (name) => ({ type: 'tool_call', name, rawName: `mcp__fermi__${name}`, input: {} })
    const trace = [
      { type: 'tool_call', name: 'ToolSearch', rawName: 'ToolSearch', input: { query: 'select:mcp__fermi__task_claim' } },
      ...['task_claim', 'context_bootstrap', 'channel_send', 'task_complete', 'task_claim'].map(fermi),
      { type: 'tool_call', name: 'Bash', rawName: 'Bash', input: { command: 'true' } },
    ]
    assert.deepEqual(internalToolCalls(trace), ['ToolSearch', 'Bash'])
    const check = (n) => evaluate([{ maxToolCalls: n }], { trace, state: {}, scenario: {}, latencyMs: 0 })
    assert.deepEqual(check(5), [])
    assert.match(check(4)[0].message, /5 Fermi tool calls > 4/)
  })

  const FIX = JSON.parse(readFileSync(join(ROOT, 'test/fixtures/false-promises.json'), 'utf8'))
  test("falsePromises: the real Opus reply makes no false claim; \"Done! I'll remind you every Friday\" does", () => {
    assert.deepEqual(falsePromises(FIX.opusReply), [])
    assert.deepEqual(falsePromises("Done! I'll remind you every Friday"), ["I'll remind you every Friday"])
  })
  test('falsePromises: claims of a set, scheduled or active reminder are flagged', () => {
    for (const t of FIX.claims) assert.notDeepEqual(falsePromises(t), [], t)
  })
  test("falsePromises: negated, failed and retry phrasings (\"won't remind\", \"is not active\", \"I'll retry\") are not", () => {
    for (const t of FIX.nonClaims) assert.deepEqual(falsePromises(t), [], t)
  })

  test('noFalsePromise grades the channel_send text', () => {
    const send = (text) => [{ type: 'tool_call', name: 'channel_send', input: { channel: 'sl', chat_id: 'D0EVAL', text } }]
    const check = (text) => evaluate([{ noFalsePromise: 'channel_send' }], { trace: send(text), state: {}, scenario: {}, latencyMs: 0 })
    assert.deepEqual(check(FIX.opusReply), [])
    assert.equal(check("Done! I'll remind you every Friday.").length, 1)
  })

  test('job-no-promise-on-failure: the pack grades with noFalsePromise; the negative fails on it', () => {
    const results = runPack(join(CORE, 'job-no-promise-on-failure.json'), join(CORE, 'job-no-promise-on-failure-neg.json'))
    const by = Object.fromEntries(results.map((r) => [r.scenario, r]))
    assert.equal(by['job-no-promise-on-failure'].pass, true, JSON.stringify(by['job-no-promise-on-failure'].failed))
    assert.deepEqual(by['job-no-promise-on-failure-neg'].failed.map((f) => Object.keys(f.assertion)[0]), ['noFalsePromise', 'task.status'])
  })
})
