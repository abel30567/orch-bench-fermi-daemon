// A claude that exits before reading its prompt used to crash the caller with an uncaught
// `write EPIPE` on its stdin (as pi did before DMN-32 and codex after DMN-1).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import * as claude from '../harness/claude-code.mjs'

const bin = join(mkdtempSync(join(tmpdir(), 'cc-early-')), 'claude')
writeFileSync(bin, '#!/bin/sh\necho "claude: exiting early" >&2\nexit 3\n')
chmodSync(bin, 0o755)
const BIG = 'x'.repeat(1 << 20) // larger than any pipe buffer: the write cannot complete before the exit

test('runOnce: claude exits before reading its prompt', async () => {
  const res = await claude.runOnce({ bin, prompt: BIG }).done
  assert.equal(res.code, 3)
  assert.match(res.stderr, /claude: exiting early/)
})

test('startSession: claude exits before reading its first message', async () => {
  const s = claude.startSession({ bin })
  s.send(BIG)
  const [code] = await once(s.events, 'exit')
  assert.equal(code, 3)
  await new Promise((r) => setTimeout(r, 100))
  assert.equal(s.alive, false)
})
