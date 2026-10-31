import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const RUN_ONCE = join(dirname(fileURLToPath(import.meta.url)), '../bin/run-once.mjs')

// bin/run-once.mjs in a throwaway daemon home, the way poll.sh's spawn_run calls it.
function runOnce(env) {
  const home = mkdtempSync(join(tmpdir(), 'run-once-'))
  const lane = join(home, 'lanes/1')
  mkdirSync(lane, { recursive: true })
  writeFileSync(join(home, 'drain.md'), 'test prompt\n')
  const { status, stderr } = spawnSync(
    process.execPath,
    [RUN_ONCE, '--prompt', 'drain.md', '--log', 'run.log', '--lane', lane, '--timeout-s', '10'],
    { cwd: home, env: { PATH: process.env.PATH, HOME: home, ...env }, encoding: 'utf8' },
  )
  return { lane, status, stderr, log: readFileSync(join(home, 'run.log'), 'utf8') }
}

describe('run-once spawn errors', () => {
  for (const [harness, env] of [
    ['claude-code', { CLAUDE_BIN: '/nope' }],
    ['pi', { HARNESS: 'pi', PI_BIN: '/nope' }],
    ['codex', { HARNESS: 'codex', CODEX_BIN: '/nope' }],
  ]) {
    test(`${harness}: a missing binary lands in the run log and frees the lane`, () => {
      const { lane, status, stderr, log } = runOnce(env)
      assert.match(log, /^run-once: spawn error: spawn \/nope ENOENT$/m)
      assert.ok(!existsSync(lane), 'lane freed')
      assert.notEqual(status, 0)
      assert.doesNotMatch(stderr, /Unhandled 'error' event/)
    })
  }

  test('a binary that is not executable reports its own error', () => {
    const dir = mkdtempSync(join(tmpdir(), 'run-once-bin-'))
    const bin = join(dir, 'claude')
    writeFileSync(bin, '')
    chmodSync(bin, 0o644)
    const { lane, status, log } = runOnce({ CLAUDE_BIN: bin })
    assert.ok(log.includes(`run-once: spawn error: spawn ${bin} EACCES\n`), log)
    assert.ok(!existsSync(lane), 'lane freed')
    assert.notEqual(status, 0)
  })

  test('a harness that spawns logs no spawn error, whatever its exit code', () => {
    const dir = mkdtempSync(join(tmpdir(), 'run-once-bin-'))
    const bin = join(dir, 'claude')
    writeFileSync(bin, `#!/bin/sh\ncat >/dev/null\necho '{"type":"system","session_id":"s1"}'\nexit 3\n`)
    chmodSync(bin, 0o755)
    const { lane, status, log } = runOnce({ CLAUDE_BIN: bin })
    assert.equal(status, 3)
    assert.doesNotMatch(log, /spawn error/)
    assert.match(log, /^\{"type":"system","session_id":"s1"\}$/m)
    assert.match(log, /^run-once: exit 3$/m)
    assert.ok(!existsSync(lane), 'lane freed')
  })
})
