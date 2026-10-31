// bin/run-once.mjs: a harness that cannot be spawned is reported in the run log.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const runOnce = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'run-once.mjs')

test('run-once logs a spawn error and frees the lane', () => {
  const dir = mkdtempSync(join(tmpdir(), 'run-once-'))
  const prompt = join(dir, 'drain.md')
  const log = join(dir, 'run.log')
  const lane = join(dir, 'lanes', '1')
  writeFileSync(prompt, 'drain\n')
  mkdirSync(lane, { recursive: true })
  const r = spawnSync(process.execPath, [runOnce, '--prompt', prompt, '--log', log, '--lane', lane], {
    cwd: dir,
    env: { ...process.env, HARNESS: 'claude-code', CLAUDE_BIN: '/nope' },
    encoding: 'utf8',
    timeout: 10_000,
  })
  assert.equal(r.status, 127, r.stderr)
  assert.doesNotMatch(r.stderr, /Unhandled 'error' event/)
  assert.match(readFileSync(log, 'utf8'), /^run-once: spawn error: spawn \/nope ENOENT$/m)
  assert.equal(existsSync(lane), false)
})
