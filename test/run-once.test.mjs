// bin/run-once.mjs against a harness binary that cannot be spawned, and one that can.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const RUN_ONCE = join(dirname(fileURLToPath(import.meta.url)), '../bin/run-once.mjs')

function runOnce(env) {
  const dir = mkdtempSync(join(tmpdir(), 'run-once-'))
  try {
    const lane = join(dir, 'lanes/1')
    mkdirSync(lane, { recursive: true })
    writeFileSync(join(dir, 'prompt.md'), 'Drain the queue.\n')
    const r = spawnSync(process.execPath, [RUN_ONCE, '--prompt', 'prompt.md', '--log', 'run.log', '--lane', lane], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, ...env(dir) },
    })
    return { ...r, log: readFileSync(join(dir, 'run.log'), 'utf8'), laneFreed: !existsSync(lane) }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('run-once', () => {
  for (const [harness, binVar] of [['claude-code', 'CLAUDE_BIN'], ['pi', 'PI_BIN'], ['codex', 'CODEX_BIN']]) {
    test(`${harness}: a spawn failure lands in the run log and frees the lane`, () => {
      const r = runOnce(() => ({ HARNESS: harness, [binVar]: '/nope' }))
      assert.match(r.log, /^run-once: spawn error: spawn \/nope ENOENT$/m)
      assert.doesNotMatch(r.log, /harness pid/)
      assert.equal(r.laneFreed, true)
      assert.equal(r.status, 127, r.stderr)
      assert.equal(r.stderr, '')
    })
  }

  test('a harness that spawns logs no spawn error and keeps its exit code', () => {
    const r = runOnce((dir) => {
      const bin = join(dir, 'claude')
      writeFileSync(bin, '#!/bin/sh\ncat >/dev/null\necho \'{"type":"system"}\'\nexit 3\n')
      chmodSync(bin, 0o755)
      return { HARNESS: 'claude-code', CLAUDE_BIN: bin }
    })
    assert.doesNotMatch(r.log, /spawn error/)
    assert.match(r.log, /^run-once: harness pid \d+$/m)
    assert.match(r.log, /^\{"type":"system"\}$/m)
    assert.match(r.log, /^run-once: exit 3$/m)
    assert.equal(r.laneFreed, true)
    assert.equal(r.status, 3, r.stderr)
  })
})
