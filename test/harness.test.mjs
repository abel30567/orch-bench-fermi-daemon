// The harness seam end to end: the warm worker's per-turn logs and bin/run-once.mjs.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ROOT, runWorker } from './run-worker.mjs'

const STREAM = join(ROOT, 'test/fixtures/claude-stream.jsonl')
const GOLDEN = JSON.parse(readFileSync(join(ROOT, 'test/fixtures/claude-stream.events.golden.json'), 'utf8'))
const SUCCESS = { type: 'result', subtype: 'success', is_error: false, num_turns: 1, result: 'done', terminal_reason: 'completed' }
const read = (f) => (existsSync(f) ? readFileSync(f, 'utf8') : '')

// The drain turn's two logs in runs/: warm-<t0>.log (raw) and warm-<t0>.events.jsonl.
function turnLogs(daemon) {
  const runs = join(daemon, 'runs')
  const raw = readdirSync(runs).find((f) => /^warm-\d+\.log$/.test(f))
  if (!raw) return null
  return { raw: join(runs, raw), events: join(runs, raw.replace(/\.log$/, '.events.jsonl')) }
}

describe('warm worker', () => {
  test('warm worker writes the raw log and the normalized log for a drain turn', async () => {
    const expectedRaw = readFileSync(STREAM, 'utf8')
    let served = 0
    // Wait on the condition (both logs hold the whole turn), never on a fixed sleep:
    // the turn log streams are flushed asynchronously after the turn ends.
    const done = ({ daemon }) => {
      const l = turnLogs(daemon)
      if (!l) return false
      const events = read(l.events)
      return read(l.raw) === expectedRaw && events.endsWith('\n') && events.includes('"type":"turn_end"')
    }
    const r = await runWorker({
      result: SUCCESS,
      pending: () => (served++ === 0 ? 1 : 0), // exactly one drain turn
      env: { FAKE_STREAM: STREAM },
      until: done,
      timeoutMs: 30000,
    })
    assert.equal(r.timedOut, false, `drain turn logs never completed; worker log:\n${r.log}`)
    const l = turnLogs(r.daemon)
    assert.equal(readFileSync(l.raw, 'utf8'), expectedRaw)
    const events = readFileSync(l.events, 'utf8').trim().split('\n').map((x) => JSON.parse(x))
    assert.deepEqual(events, GOLDEN)
    assert.equal(r.events.filter((e) => e.kind === 'turn' && e.drain).length, 1)
  })
})

describe('bin/run-once.mjs', () => {
  function runOnce(env) {
    const dir = mkdtempSync(join(tmpdir(), 'run-once-'))
    const lane = join(dir, 'lanes/1')
    mkdirSync(lane, { recursive: true })
    writeFileSync(join(lane, 'pid'), '1\n')
    writeFileSync(join(dir, 'p.md'), 'Drain.\n')
    const log = join(dir, 'run.log')
    const child = spawn(process.execPath, [join(ROOT, 'bin/run-once.mjs'), '--prompt', join(dir, 'p.md'), '--log', log, '--lane', lane], {
      cwd: dir,
      env: { ...process.env, HARNESS: 'claude-code', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    child.stdout.on('data', (d) => (output += d))
    child.stderr.on('data', (d) => (output += d))
    return new Promise((resolve) => child.on('close', (code) => resolve({ code, output, log: read(log), lane })))
  }

  test('a harness that cannot spawn: the error is in the run log and the lane is freed', async () => {
    const r = await runOnce({ CLAUDE_BIN: '/nope' })
    assert.match(r.log, /^run-once: spawn error: spawn \/nope ENOENT$/m)
    assert.doesNotMatch(r.output, /Unhandled 'error' event/)
    assert.notEqual(r.code, 0)
    assert.equal(existsSync(r.lane), false, 'lane dir removed')
  })
})
