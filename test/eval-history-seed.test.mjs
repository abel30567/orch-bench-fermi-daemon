// pr-81: fixtures.history reaches the real eval worker's seed as MCP-24's
// `conversation` section. The checkout and `npx wrangler` are local fakes.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { startFakeTarget } from '../evals/lib/fake-target.mjs'
import { mcpConnect, resultText } from '../evals/lib/mcp-client.mjs'
import { seedFixture as fromScenario } from '../evals/lib/scenario.mjs'
import { seedFixture, startWranglerTarget } from '../evals/lib/wrangler-target.mjs'

const history = [
  { role: 'user', text: 'Call Example Bistro', minutes_ago: 3 },
  { role: 'assistant', text: 'Reply yes to place the call.', minutes_ago: 2 },
]
const group = { channel: 'wa', sender: '15555550100', chat: '120363000000000001@g.us', text: 'yes' }

// A fermi-mcp checkout whose eval-seed.mjs copies the fixture it gets to seeded.json.
function fakeCheckout() {
  const root = mkdtempSync(join(tmpdir(), 'pr81-'))
  const worker = join(root, 'packages/worker')
  mkdirSync(join(worker, 'scripts'), { recursive: true })
  writeFileSync(join(worker, 'wrangler.eval.jsonc'), '{}\n')
  writeFileSync(join(worker, 'scripts/eval-seed.mjs'), `import { copyFileSync } from 'node:fs'\ncopyFileSync(process.argv[2], 'seeded.json')\n`)
  const bin = join(root, 'bin')
  mkdirSync(bin)
  writeFileSync(join(bin, 'npx'), `#!/usr/bin/env node
const { createServer } = require('node:http')
const port = Number(process.argv[process.argv.indexOf('--port') + 1])
createServer((_, res) => res.end('ok')).listen(port, '127.0.0.1')
`)
  chmodSync(join(bin, 'npx'), 0o755)
  return { root, worker, bin }
}

describe('fixtures.history', () => {
  test('seedFixture nests it under conversation with the inbound chat', () => {
    const fixture = seedFixture({ history }, group)
    assert.deepEqual(fixture.conversation, { channel: 'wa', chat_id: group.chat, sender: group.sender, history })
    assert.equal('history' in fixture, false)
    assert.equal(seedFixture, fromScenario)
  })

  test('seedFixture leaves conversation out without history', () => {
    assert.equal('conversation' in seedFixture({ history: [] }, group), false)
    assert.equal('conversation' in seedFixture({}, group), false)
  })

  test('the wrangler target hands the conversation to eval-seed.mjs', async () => {
    const { root, worker, bin } = fakeCheckout()
    const path = process.env.PATH
    process.env.PATH = bin + delimiter + path
    const target = await startWranglerTarget({ worker: root, env: {}, logDir: root, bootTimeoutMs: 15_000 })
    process.env.PATH = path
    try {
      const fixture = seedFixture({ history }, group)
      await target.seed(fixture)
      assert.deepEqual(JSON.parse(readFileSync(join(worker, 'seeded.json'), 'utf8')), fixture)
    } finally {
      await target.close()
    }
  })

  test('the fake target serves it from the inbound chat with its age', async () => {
    const target = await startFakeTarget({ env: {} })
    try {
      const before = Date.now()
      await target.seed(seedFixture({ history }, group))
      const mcp = await mcpConnect(`${target.url}/mcp`)
      const read = async (chat_id) => JSON.parse(resultText(await mcp.callTool('conversation_history', { channel: 'wa', chat_id }))).messages
      const messages = await read(group.chat)
      assert.deepEqual(messages.map((m) => [m.role, m.text]), history.map((m) => [m.role, m.text]))
      assert.ok(messages[0].created_at <= before - 3 * 60_000 + 1000)
      assert.deepEqual(await read('another-chat'), [])
    } finally {
      await target.close()
    }
  })
})
