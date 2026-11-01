// The conformance suite (./suite.mjs) for the Claude Code adapter, against ./fake-claude-code.mjs.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runConformance } from './suite.mjs'
import { runOnce, startSession } from '../../harness/claude-code.mjs'

const bin = join(mkdtempSync(join(tmpdir(), 'dmn4-bin-')), 'claude')
const fake = join(dirname(fileURLToPath(import.meta.url)), 'fake-claude-code.mjs')
writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${fake}" "$@"\n`)
chmodSync(bin, 0o755)

runConformance(() => import('../../harness/claude-code.mjs'), { name: 'claude-code', options: { bin } })

// pr-95: a harness that exits before reading its stdin used to crash the caller with an
// uncaught `write EPIPE`. The prompt is larger than a pipe buffer, so the write always fails.
describe('claude-code adapter: early exit', () => {
  const early = join(mkdtempSync(join(tmpdir(), 'dmn4-bin-')), 'claude')
  writeFileSync(early, '#!/bin/sh\necho "claude: early" >&2\nexit 3\n')
  chmodSync(early, 0o755)
  const BIG = 'x'.repeat(1 << 20)

  test('runOnce: exits before reading stdin, done resolves with its code and stderr', async () => {
    const r = await runOnce({ bin: early, prompt: BIG }).done
    assert.equal(r.code, 3)
    assert.equal(r.outcome, null)
    assert.match(r.stderr, /claude: early/)
  })

  test('startSession: exits before reading stdin, a send is not thrown', async () => {
    const s = startSession({ bin: early })
    let stderr = ''
    s.events.on('stderr', (d) => (stderr += d))
    const exited = new Promise((resolve) => s.events.once('exit', resolve))
    s.send(BIG)
    assert.equal(await exited, 3)
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.match(stderr, /claude: early/)
    assert.equal(s.alive, false)
    assert.equal(s.send('again'), false)
  })
})
