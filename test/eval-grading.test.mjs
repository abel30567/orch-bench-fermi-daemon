// Grading fidelity fixes from the first live baseline triage: tool budgets count
// Fermi calls only (harness-internal calls are reported as internalToolCalls), and
// the job pack's "no promise on failure" checks for a false claim of success.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ROOT } from './run-worker.mjs'
import { evaluate, falsePromises, internalToolCalls } from '../evals/lib/assertions.mjs'
import { validate } from '../evals/lib/json-schema.mjs'

const RUN = join(ROOT, 'evals/run.mjs')
const PRELOAD = join(ROOT, 'test/fixtures/localhost-only.mjs')
const SCHEMA = JSON.parse(readFileSync(join(ROOT, 'evals/schema/results.schema.json'), 'utf8'))
const FIXTURE = JSON.parse(readFileSync(join(ROOT, 'evals/fixtures/false-promises.json'), 'utf8'))
const tmp = () => mkdtempSync(join(tmpdir(), 'grading-'))
const readJson = (...p) => JSON.parse(readFileSync(join(...p), 'utf8'))
const runCli = (args) => {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(FERMI_URL|MACOS_MCP_URL|\w+_API_BASE)$/.test(k)))
  return spawnSync(process.execPath, ['--import', PRELOAD, RUN, ...args], { cwd: ROOT, env, encoding: 'utf8', timeout: 60_000 })
}

const call = (name, rawName = `mcp__fermi__${name}`) => ({ type: 'tool_call', id: name, name, rawName, input: {} })

describe('maxToolCalls counts Fermi calls only', () => {
  const fermi = ['task_claim', 'context_bootstrap', 'channel_send', 'task_complete', 'task_claim'].map((n) => call(n))
  const trace = [call('ToolSearch', 'ToolSearch'), ...fermi]
  const run = (expect, t = trace) => evaluate(expect, { trace: t, state: {}, scenario: {}, latencyMs: 0 })

  test('internalToolCalls lists the non-Fermi calls by raw name', () => {
    assert.deepEqual(internalToolCalls(trace), ['ToolSearch'])
    assert.deepEqual(internalToolCalls([...trace, call('Bash', 'Bash'), call('browser_navigate', 'mcp__playwright__browser_navigate')]), ['ToolSearch', 'Bash', 'mcp__playwright__browser_navigate'])
    assert.deepEqual(internalToolCalls(fermi), [])
  })

  test('one ToolSearch plus 5 Fermi calls is within maxToolCalls: 5; a sixth Fermi call is not', () => {
    assert.deepEqual(run([{ maxToolCalls: 5 }]), [])
    const [f] = run([{ maxToolCalls: 5 }], [...trace, call('task_claim')])
    assert.equal(f.message, '6 Fermi tool calls > 5 (plus 1 harness-internal, not counted)')
  })

  test('fake harness: one internal ToolSearch plus 5 Fermi calls passes maxToolCalls: 5, and results.json reports internalToolCalls', () => {
    const dir = tmp()
    const scenario = {
      name: 'tool-search-budget',
      fixtures: { bindings: [{ channel: 'sl', sender_id: 'U0EVALOWNER' }] },
      inbound: { channel: 'sl', sender: 'U0EVALOWNER', chat: 'D0EVAL', text: 'Ping' },
      expect: [{ maxToolCalls: 5 }, { 'task.status': 'done' }],
      fake: {
        script: [
          { internal: 'ToolSearch', input: { query: 'select:mcp__fermi__task_claim' }, result: 'loaded' },
          { tool: 'task_claim', args: { limit: 1, stale_minutes: 25 } },
          { tool: 'context_bootstrap', args: { channel: '${task.channel}', chat_id: '${task.chat_id}' } },
          { tool: 'channel_send', args: { channel: '${task.channel}', chat_id: '${task.chat_id}', text: 'Pong.' } },
          { tool: 'task_complete', args: { id: '${task.id}', status: 'done', result: 'ponged' } },
          { tool: 'task_claim', args: { limit: 1, stale_minutes: 25 } },
        ],
      },
    }
    writeFileSync(join(dir, 's.json'), JSON.stringify(scenario))
    const out = tmp()
    const r = runCli(['--harness', 'fake', '--scenarios', join(dir, 's.json'), '--out', out])
    assert.equal(r.status, 0, r.stdout + r.stderr)
    const results = readJson(out, 'results.json')
    assert.deepEqual(validate(SCHEMA, results), [])
    const [res] = results
    assert.equal(res.pass, true, JSON.stringify(res.failed))
    assert.deepEqual(res.internalToolCalls, ['ToolSearch'])
    assert.equal(res.toolCalls.length, 6)
    assert.deepEqual(Object.keys(res).slice(Object.keys(res).indexOf('toolCalls'), Object.keys(res).indexOf('toolCalls') + 2), ['toolCalls', 'internalToolCalls'])
  })

  test('every result carries internalToolCalls, empty without internal calls', () => {
    const out = tmp()
    const r = runCli(['--harness', 'fake', '--scenarios', join(ROOT, 'evals/scenarios/examples/reply-contract.json'), '--out', out])
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.deepEqual(readJson(out, 'results.json')[0].internalToolCalls, [])
  })
})

describe('falsePromises / noFalsePromise', () => {
  test("the real Opus 5.5 baseline reply makes no false promise (the old regex failed it on \"won't remind\" and \"I'll retry\")", () => {
    assert.deepEqual(falsePromises(FIXTURE.opusBaseline), [])
    const old = /^(?![\s\S]*(\bI'll\b|\bI will\b|\bremind you\b|\bscheduled\b|\ball set\b))/i
    assert.equal(old.test(FIXTURE.opusBaseline), false)
  })

  test('"Done! I\'ll remind you every Friday" is a false promise', () => {
    assert.deepEqual(falsePromises("Done! I'll remind you every Friday"), ['Done', "I'll remind you every Friday"])
  })

  for (const text of FIXTURE.honest) test(`honest: ${text}`, () => assert.deepEqual(falsePromises(text), []))
  for (const text of FIXTURE.false) test(`false: ${text}`, () => assert.ok(falsePromises(text).length, 'no false claim found'))

  test('noFalsePromise checks the text of every call of the tool', () => {
    const send = (text) => ({ type: 'tool_call', name: 'channel_send', input: { text } })
    const run = (...texts) => evaluate([{ noFalsePromise: 'channel_send' }], { trace: texts.map(send), state: {}, scenario: {}, latencyMs: 0 })
    assert.deepEqual(run(FIXTURE.opusBaseline), [])
    const [f] = run('Checking the scheduler…', "Done! I'll remind you every Friday.")
    assert.match(f.message, /channel_send falsely claims success: "Done", "I'll remind you every Friday"/)
  })
})
