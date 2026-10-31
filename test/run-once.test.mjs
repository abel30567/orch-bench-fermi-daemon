// bin/run-once.mjs when the harness binary cannot be spawned: the reason lands in
// the run log and the lane is still freed.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const RUN_ONCE = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'run-once.mjs')

test('a missing harness binary writes the spawn error to the run log and frees the lane', () => {
  const dir = mkdtempSync(join(tmpdir(), 'run-once-'))
  const prompt = join(dir, 'drain.md')
  const log = join(dir, 'run.log')
  const lane = join(dir, 'lanes', '0')
  writeFileSync(prompt, 'Drain the queue.\n')
  mkdirSync(lane, { recursive: true })

  const r = spawnSync(process.execPath, [RUN_ONCE, '--prompt', prompt, '--log', log, '--lane', lane], {
    cwd: dir,
    env: { ...process.env, HARNESS: 'claude-code', CLAUDE_BIN: '/nope' },
    encoding: 'utf8',
    timeout: 10_000,
  })

  const text = readFileSync(log, 'utf8')
  assert.match(text, /^run-once: spawn error: spawn \/nope ENOENT$/m)
  assert.equal(r.status, 127, r.stderr)
  assert.equal(existsSync(lane), false, 'lane dir is removed')
})
