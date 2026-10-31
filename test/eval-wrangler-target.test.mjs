import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { seedFixture, startWranglerTarget } from '../evals/lib/wrangler-target.mjs'
import { startFakeTarget } from '../evals/lib/fake-target.mjs'
import { mcpConnect, resultText } from '../evals/lib/mcp-client.mjs'

const tmp = () => mkdtempSync(join(tmpdir(), 'pr81-'))
const HISTORY = [
  { role: 'user', text: 'call the dentist for me', minutes_ago: 12 },
  { role: 'assistant', text: 'Reply yes to place the call.', minutes_ago: 11 },
]

describe('seedFixture: fixtures.history → eval-seed conversation (MCP-24)', () => {
  test('a DM history is seeded on the inbound channel, chat and sender, with no history key', () => {
    const f = seedFixture({ history: HISTORY }, { channel: 'sl', sender: 'U0EVALOWNER', chat: 'D0EVAL', text: 'yes' })
    assert.equal('history' in f, false)
    assert.deepEqual(f.conversation, { channel: 'sl', chat_id: 'D0EVAL', sender: 'U0EVALOWNER', history: HISTORY })
  })

  test('a group chat history carries the group sender', () => {
    const inbound = { channel: 'wa', sender: '15555550112', chat: '120363000000000000@g.us', text: 'yes' }
    const f = seedFixture({ history: [{ role: 'user', text: 'hi' }] }, inbound)
    assert.deepEqual(f.conversation, { channel: 'wa', chat_id: '120363000000000000@g.us', sender: '15555550112', history: [{ role: 'user', text: 'hi' }] })
  })

  test('no history, no conversation section', () => {
    const f = seedFixture({ profile: { user: 'u' } }, { channel: 'sl', sender: 'U0EVALOWNER', chat: 'D0EVAL', text: 'hi' })
    assert.deepEqual(f, { profile: { user: 'u' } })
  })
})

// A fermi-mcp checkout stand-in: an `npx` on PATH that answers /health like
// `wrangler dev`, and an eval-seed.mjs that records the fixture it was given.
function fakeCheckout() {
  const root = tmp()
  const bin = join(root, 'bin')
  mkdirSync(bin)
  mkdirSync(join(root, 'scripts'))
  writeFileSync(join(root, 'wrangler.eval.jsonc'), '{}\n')
  writeFileSync(
    join(root, 'scripts/eval-seed.mjs'),
    "import { copyFileSync } from 'node:fs'\ncopyFileSync(process.argv[2], new URL('../seeded.json', import.meta.url))\n",
  )
  const npx = join(bin, 'npx')
  writeFileSync(
    npx,
    `#!${process.execPath}\nconst a = process.argv\nconst port = +a[a.indexOf('--port') + 1]\nrequire('node:http').createServer((q, s) => s.end('ok')).listen(port, '127.0.0.1')\n`,
  )
  chmodSync(npx, 0o755)
  return { root, bin }
}

describe('wrangler target seeds conversation history', () => {
  test('seed() hands the conversation section to eval-seed.mjs instead of throwing', async () => {
    const { root, bin } = fakeCheckout()
    const path = process.env.PATH
    process.env.PATH = `${bin}${delimiter}${path}`
    let target
    try {
      target = await startWranglerTarget({ worker: root, env: {}, logDir: root, bootTimeoutMs: 20_000 })
      const fixture = seedFixture({ history: HISTORY }, { channel: 'sl', sender: 'U0EVALOWNER', chat: 'D0EVAL', text: 'yes' })
      await target.seed(fixture)
      assert.deepEqual(JSON.parse(readFileSync(join(root, 'seeded.json'), 'utf8')), fixture)
    } finally {
      process.env.PATH = path
      await target?.close()
    }
  })
})

describe('fake target reads the same conversation section', () => {
  test('conversation_history returns the seeded transcript for the inbound chat', async () => {
    const target = await startFakeTarget({ env: {} })
    try {
      await target.seed(seedFixture({ history: HISTORY }, { channel: 'sl', sender: 'U0EVALOWNER', chat: 'D0EVAL', text: 'yes' }))
      const mcp = await mcpConnect(`${target.url}/mcp`, { clientName: 'pr81-test' })
      const res = JSON.parse(resultText(await mcp.callTool('conversation_history', { channel: 'sl', chat_id: 'D0EVAL' })))
      const msgs = res.messages
      assert.deepEqual(msgs.map((m) => [m.role, m.text]), HISTORY.map((m) => [m.role, m.text]))
      assert.ok(msgs[0].created_at < msgs[1].created_at)
    } finally {
      await target.close()
    }
  })
})
