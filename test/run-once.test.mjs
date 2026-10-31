import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const RUN_ONCE = join(import.meta.dirname, '../bin/run-once.mjs')

test('run-once logs a harness spawn error to the run log and frees the lane', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'run-once-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const prompt = join(dir, 'drain.md')
  const log = join(dir, 'run.log')
  const lane = join(dir, 'lanes/0')
  writeFileSync(prompt, 'drain\n')
  mkdirSync(lane, { recursive: true })

  const r = spawnSync(process.execPath, [RUN_ONCE, '--prompt', prompt, '--log', log, '--lane', lane], {
    cwd: dir,
    env: { ...process.env, HARNESS: 'claude-code', CLAUDE_BIN: '/nope' },
    encoding: 'utf8',
    timeout: 20_000,
  })

  assert.equal(r.signal, null)
  assert.doesNotMatch(r.stderr, /Unhandled 'error' event/)
  assert.notEqual(r.status, 0)
  assert.match(readFileSync(log, 'utf8'), /^run-once: spawn error: spawn \/nope ENOENT$/m)
  assert.equal(existsSync(lane), false)
})
