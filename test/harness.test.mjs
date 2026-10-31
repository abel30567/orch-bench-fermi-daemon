import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ROOT, runWorker } from './run-worker.mjs'

const SUCCESS = { type: 'result', subtype: 'success', is_error: false, num_turns: 1, result: 'done', terminal_reason: 'completed' }
const read = (f) => (existsSync(f) ? readFileSync(f, 'utf8') : '')

// The drain turn's two logs, once both hold its end (raw `result` line, normalized turn_end).
function drainLogs(daemon) {
  const runs = join(daemon, 'runs')
  const raw = readdirSync(runs).find((f) => /^warm-\d+\.log$/.test(f))
  if (!raw) return null
  const rawText = read(join(runs, raw))
  const eventsText = read(join(runs, raw.replace(/\.log$/, '.events.jsonl')))
  if (!/"type":"result"/.test(rawText) || !/"type":"turn_end"/.test(eventsText)) return null
  return { rawText, eventsText }
}

describe('warm worker turn logs', () => {
  test('warm worker writes the raw log and the normalized log for a drain turn', async () => {
    let logs = null
    await runWorker({ result: SUCCESS, pending: 1, until: (daemon) => (logs = drainLogs(daemon)) != null })
    const raw = logs.rawText.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l))
    assert.ok(raw.some((j) => j.type === 'result' && j.subtype === 'success'))
    const events = logs.eventsText.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l))
    const end = events.find((e) => e.type === 'turn_end')
    assert.equal(end.ok, true)
  })
})

describe('bin/run-once.mjs', () => {
  test('a harness that cannot spawn: the error lands in the run log and the lane is freed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'run-once-'))
    try {
      writeFileSync(join(dir, 'p.md'), 'hello\n')
      const lane = join(dir, 'lanes/1')
      mkdirSync(lane, { recursive: true })
      const env = { ...process.env, CLAUDE_BIN: '/nope' }
      delete env.HARNESS
      const child = spawn(process.execPath, [join(ROOT, 'bin/run-once.mjs'), '--prompt', 'p.md', '--log', 'r.log', '--lane', lane], {
        cwd: dir,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let stderr = ''
      child.stderr.on('data', (d) => (stderr += d))
      const code = await new Promise((r) => child.on('close', r))
      const log = read(join(dir, 'r.log'))
      assert.match(log, /^run-once: spawn error: spawn \/nope ENOENT$/m, stderr)
      assert.equal(code, 127)
      assert.equal(existsSync(lane), false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
