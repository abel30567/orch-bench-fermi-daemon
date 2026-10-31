import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ROOT, runWorker } from './run-worker.mjs'

const SUCCESS = { type: 'result', subtype: 'success', is_error: false, num_turns: 1, result: 'done', terminal_reason: 'completed' }

// The drain turn's raw log and normalized log, once both hold the finished turn (else null).
function drainLogs(daemon) {
  const runs = join(daemon, 'runs')
  const raw = readdirSync(runs).find((f) => /^warm-\d+\.log$/.test(f))
  if (!raw) return null
  const rawText = readFileSync(join(runs, raw), 'utf8')
  const eventsText = readFileSync(join(runs, raw.replace(/\.log$/, '.events.jsonl')), 'utf8')
  if (!rawText.includes('"type":"result"') || !eventsText.includes('"turn_end"')) return null
  return { rawText, eventsText }
}

describe('warm worker', () => {
  test('warm worker writes the raw log and the normalized log for a drain turn', async () => {
    const r = await runWorker({ result: SUCCESS, pending: 1, durationMs: 20000, until: (d) => drainLogs(d) != null })
    try {
      assert.equal(r.timedOut, false, `drain logs never completed; worker log:\n${r.log}`)
      const { rawText, eventsText } = drainLogs(r.daemon)
      const raw = rawText.split('\n').filter(Boolean).map((l) => JSON.parse(l))
      assert.deepEqual(
        raw.map((j) => j.type),
        ['system', 'result'],
      )
      const events = eventsText.split('\n').filter(Boolean).map((l) => JSON.parse(l))
      assert.deepEqual(
        events.map((e) => e.type),
        ['init', 'turn_end'],
      )
      assert.equal(events[1].ok, true)
      assert.equal(r.events.filter((e) => e.kind === 'turn' && e.drain).length, 1)
    } finally {
      rmSync(join(r.daemon, '..'), { recursive: true, force: true })
    }
  })
})

describe('bin/run-once.mjs', () => {
  test('a harness that cannot be spawned: the error lands in the run log and the lane is freed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'run-once-'))
    try {
      writeFileSync(join(dir, 'drain.md'), 'Drain.\n')
      const lane = join(dir, 'lanes/0')
      mkdirSync(lane, { recursive: true })
      const log = join(dir, 'run.log')
      const { HARNESS, ...env } = process.env
      const child = spawn(
        process.execPath,
        [join(ROOT, 'bin/run-once.mjs'), '--prompt', join(dir, 'drain.md'), '--log', log, '--lane', lane],
        { cwd: dir, env: { ...env, CLAUDE_BIN: '/nope' }, stdio: 'ignore' },
      )
      const code = await new Promise((r) => child.on('close', r))
      const text = readFileSync(log, 'utf8')
      assert.match(text, /^run-once: spawn error: spawn \/nope ENOENT$/m)
      assert.notEqual(code, 0)
      assert.equal(existsSync(lane), false, 'lane dir still exists')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
