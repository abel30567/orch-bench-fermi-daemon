// A claude that exits before reading stdin used to take the process down with an unhandled
// `write EPIPE` (the bug DMN-32 fixed for pi). Its exit code and stderr now just come through.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import * as claude from '../harness/claude-code.mjs'

const bin = join(mkdtempSync(join(tmpdir(), 'claude-early-')), 'claude')
writeFileSync(bin, '#!/bin/sh\necho "claude: bad config" >&2\nexit 3\n')
chmodSync(bin, 0o755)
const BIG = 'x'.repeat(1 << 20)

describe('claude exiting before reading stdin is never an uncaught exception', () => {
  test('runOnce', async () => {
    const res = await claude.runOnce({ bin, prompt: BIG }).done
    assert.equal(res.code, 3)
    assert.equal(res.outcome, null)
    assert.match(res.stderr, /bad config/)
  })

  test('startSession', async () => {
    const s = claude.startSession({ bin })
    let stderr = ''
    s.events.on('stderr', (d) => (stderr += d))
    const exited = once(s.events, 'exit')
    assert.equal(s.send(BIG), true)
    assert.deepEqual(await exited, [3])
    await new Promise((r) => setTimeout(r, 100)) // the failed write reports after the exit
    assert.match(stderr, /bad config/)
  })
})
