// pr-81: the wrangler target seeds fixtures.history through eval-seed.mjs's
// `conversation` section (fermi-mcp MCP-24) instead of refusing the scenario.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { seedFixture, startWranglerTarget } from '../evals/lib/wrangler-target.mjs'
import { startFakeTarget } from '../evals/lib/fake-target.mjs'

const history = [
  { role: 'user', text: 'Call +15555550111 for me.', minutes_ago: 12 },
  { role: 'assistant', text: 'Reply yes to place the call.' },
]

describe('seedFixture conversation', () => {
  test('a DM history becomes conversation on the inbound channel, chat and sender', () => {
    const f = seedFixture({ history }, { channel: 'sl', sender: 'U0EVALOWNER', chat: 'D0EVAL', text: 'yes' })
    assert.equal('history' in f, false)
    assert.deepEqual(f.conversation, {
      channel: 'sl',
      chat_id: 'D0EVAL',
      sender: 'U0EVALOWNER',
      history: [
        { role: 'user', text: 'Call +15555550111 for me.', minutes_ago: 12 },
        { role: 'assistant', text: 'Reply yes to place the call.', minutes_ago: 0 },
      ],
    })
  })

  test('a group history carries the group member as sender', () => {
    const f = seedFixture({ history }, { channel: 'wa', sender: '15555550112', chat: '120363000000000000@g.us', text: 'yes' })
    assert.equal(f.conversation.chat_id, '120363000000000000@g.us')
    assert.equal(f.conversation.sender, '15555550112')
  })

  test('no history, no conversation section', () => {
    const f = seedFixture({ profile: { agent: 'a', user: 'u' } }, { channel: 'sl', sender: 'U0EVALOWNER', chat: 'D0EVAL' })
    assert.deepEqual(f, { profile: { agent: 'a', user: 'u' } })
  })

  test('the fake target seeds the conversation as chat messages', async () => {
    const target = await startFakeTarget({})
    try {
      await target.seed(seedFixture({ history }, { channel: 'sl', sender: 'U0EVALOWNER', chat: 'D0EVAL' }))
      const res = await fetch(`${target.url}/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'conversation_history', arguments: { channel: 'sl', chat_id: 'D0EVAL' } } }),
      })
      const body = await res.text()
      assert.match(body, /Call \+15555550111 for me\./)
      assert.match(body, /Reply yes to place the call\./)
    } finally {
      await target.close()
    }
  })
})

test('the wrangler target hands the conversation to eval-seed.mjs instead of throwing', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wrangler-seed-'))
  const worker = join(root, 'packages/worker')
  mkdirSync(join(worker, 'scripts'), { recursive: true })
  writeFileSync(join(worker, 'wrangler.eval.jsonc'), '{}\n')
  const captured = join(root, 'seeded.json')
  writeFileSync(join(worker, 'scripts/eval-seed.mjs'), `import { copyFileSync } from 'node:fs'\ncopyFileSync(process.argv[2], ${JSON.stringify(captured)})\n`)
  // A fake `npx wrangler dev` that only answers /health on the given port.
  const bin = join(root, 'bin')
  mkdirSync(bin)
  writeFileSync(
    join(bin, 'npx'),
    `#!${process.execPath}\nconst a = process.argv\nconst port = Number(a[a.indexOf('--port') + 1])\nrequire('node:http').createServer((q, r) => r.end('ok')).listen(port, '127.0.0.1')\n`,
  )
  chmodSync(join(bin, 'npx'), 0o755)
  const logDir = join(root, 'logs')
  mkdirSync(logDir)
  const PATH = process.env.PATH
  process.env.PATH = `${bin}${delimiter}${PATH}`
  let target
  try {
    target = await startWranglerTarget({ worker: root, env: { EVAL: '1' }, logDir, bootTimeoutMs: 15_000 })
    await target.seed(seedFixture({ history }, { channel: 'wa', sender: '15555550112', chat: '120363000000000000@g.us' }))
    const seeded = JSON.parse(readFileSync(captured, 'utf8'))
    assert.equal('history' in seeded, false)
    assert.equal(seeded.conversation.channel, 'wa')
    assert.equal(seeded.conversation.chat_id, '120363000000000000@g.us')
    assert.equal(seeded.conversation.sender, '15555550112')
    assert.equal(seeded.conversation.history.length, 2)
  } finally {
    process.env.PATH = PATH
    await target?.close()
  }
})
