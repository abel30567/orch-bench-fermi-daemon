// fixtures.history reaches the real eval worker as eval-seed.mjs's `conversation`
// section (MCP-24). The checkout here is a stub: `wrangler` answers /health and
// eval-seed.mjs records the fixture it was handed.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runAttempt } from '../evals/lib/runner.mjs'
import { seedFixture as scenarioFixture } from '../evals/lib/scenario.mjs'
import { seedFixture } from '../evals/lib/wrangler-target.mjs'
import * as fake from '../evals/harness/fake.mjs'

const tmp = () => mkdtempSync(join(tmpdir(), 'history-seed-'))
const HISTORY = [
  { role: 'user', text: 'Call the bistro', minutes_ago: 3 },
  { role: 'assistant', text: 'Reply yes to place the call.', minutes_ago: 2 },
]
const DM = { channel: 'sl', sender: 'U0EVALOWNER', chat: 'D0EVAL', text: 'yes' }
const GROUP = { channel: 'wa', sender: '15555550100', chat: '120363000000000000@g.us', text: 'yes' }

function stubCheckout() {
  const dir = tmp()
  mkdirSync(join(dir, 'scripts'))
  mkdirSync(join(dir, 'node_modules/.bin'), { recursive: true })
  writeFileSync(join(dir, 'wrangler.eval.jsonc'), '{}')
  writeFileSync(join(dir, 'scripts/eval-seed.mjs'), `import { copyFileSync } from 'node:fs'\ncopyFileSync(process.argv[2], 'seeded.json')\n`)
  const wrangler = join(dir, 'node_modules/.bin/wrangler')
  writeFileSync(
    wrangler,
    `#!/usr/bin/env node
const { createServer } = require('node:http')
const port = Number(process.argv[process.argv.indexOf('--port') + 1])
createServer((req, res) => res.writeHead(req.url === '/health' ? 200 : 404).end('{}')).listen(port, '127.0.0.1')
`,
  )
  chmodSync(wrangler, 0o755)
  return dir
}

describe('seedFixture for the real eval worker', () => {
  test('history becomes conversation with the inbound channel, chat_id and sender, and no history key', () => {
    const f = seedFixture({ history: HISTORY }, DM)
    assert.deepEqual(f, { conversation: { channel: 'sl', chat_id: 'D0EVAL', sender: 'U0EVALOWNER', history: HISTORY } })
    assert.ok(!('history' in f))
  })

  test('a group chat carries the group sender', () => {
    assert.deepEqual(seedFixture({ history: HISTORY }, GROUP).conversation, { channel: 'wa', chat_id: GROUP.chat, sender: GROUP.sender, history: HISTORY })
  })

  test('no history, no conversation; every other section is unchanged', () => {
    const fixtures = { profile: { agent: 'a' }, bindings: [{ channel: 'sl', sender_id: 'U0EVALOWNER' }] }
    assert.deepEqual(seedFixture(fixtures, DM), scenarioFixture(fixtures, DM))
    assert.deepEqual(seedFixture({ history: [] }, DM), {})
    assert.deepEqual(seedFixture(), {})
  })

  test('other sections survive next to the conversation', () => {
    const f = seedFixture({ profile: { agent: 'a' }, history: HISTORY }, { ...DM, via: 'task' })
    assert.deepEqual(f.profile, { agent: 'a' })
    assert.equal(f.tasks[0].id, 'eval-inbound')
    assert.equal(f.conversation.history.length, 2)
  })
})

describe('the runner against a wrangler checkout', () => {
  test('a scenario with history is seeded through eval-seed.mjs as conversation', async () => {
    const worker = stubCheckout()
    await runAttempt({
      scenario: { name: 'history', category: 'test', fixtures: { history: HISTORY }, inbound: { ...DM, via: 'task' }, expect: [{ called: 'channel_send' }], fake: { script: [] } },
      attempt: 1,
      harness: fake,
      worker,
      timeoutMs: 10_000,
      outDir: tmp(),
    })
    const seeded = JSON.parse(readFileSync(join(worker, 'seeded.json'), 'utf8'))
    assert.deepEqual(seeded.conversation, { channel: 'sl', chat_id: 'D0EVAL', sender: 'U0EVALOWNER', history: HISTORY })
    assert.ok(!('history' in seeded))
  })
})
