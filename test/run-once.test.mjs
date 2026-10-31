import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const RUN_ONCE = join(dirname(fileURLToPath(import.meta.url)), '../bin/run-once.mjs')

describe('run-once: a harness binary that cannot be spawned', () => {
  test('CLAUDE_BIN=/nope writes the spawn error to the run log and frees the lane', () => {
    const dir = mkdtempSync(join(tmpdir(), 'run-once-'))
    try {
      const prompt = join(dir, 'prompt.md')
      const log = join(dir, 'run.log')
      const lane = join(dir, 'lanes/1')
      writeFileSync(prompt, 'drain the queue\n')
      mkdirSync(lane, { recursive: true })
      const r = spawnSync(process.execPath, [RUN_ONCE, '--prompt', prompt, '--log', log, '--lane', lane], {
        cwd: dir,
        env: { ...process.env, HARNESS: 'claude-code', CLAUDE_BIN: '/nope' },
        encoding: 'utf8',
        timeout: 10_000,
      })
      assert.doesNotMatch(r.stderr, /Unhandled 'error' event/)
      assert.notEqual(r.status, 0)
      assert.match(readFileSync(log, 'utf8'), /^run-once: spawn error: spawn \/nope ENOENT$/m)
      assert.equal(existsSync(lane), false, 'lane dir is removed')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
