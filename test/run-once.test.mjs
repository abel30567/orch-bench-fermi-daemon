import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const RUN_ONCE = join(dirname(fileURLToPath(import.meta.url)), '../bin/run-once.mjs')

test('a harness that cannot spawn leaves the spawn error in the run log and frees the lane', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'run-once-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  writeFileSync(join(dir, 'p.md'), 'hello\n') // no placeholders, so no local.json needed
  const lane = join(dir, 'lanes/1')
  mkdirSync(lane, { recursive: true })
  const log = join(dir, 'run.log')

  const r = spawnSync(process.execPath, [RUN_ONCE, '--prompt', 'p.md', '--log', log, '--lane', lane], {
    cwd: dir,
    env: { ...process.env, HARNESS: 'claude-code', CLAUDE_BIN: '/nope' },
    encoding: 'utf8',
    timeout: 10000,
  })

  assert.doesNotMatch(r.stderr, /Unhandled 'error' event/)
  assert.notEqual(r.status, 0)
  assert.match(readFileSync(log, 'utf8'), /^run-once: spawn error: spawn \/nope ENOENT$/m)
  assert.equal(existsSync(lane), false)
})
