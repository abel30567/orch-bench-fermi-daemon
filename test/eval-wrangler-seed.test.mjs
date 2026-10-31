import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { seedFixture } from '../evals/lib/wrangler-target.mjs'
import { runAttempt } from '../evals/lib/runner.mjs'
import { loadScenario } from '../evals/lib/scenario.mjs'
import * as fake from '../evals/harness/fake.mjs'
import { ROOT } from './run-worker.mjs'

const tmp = () => mkdtempSync(join(tmpdir(), 'pr81-'))
const HISTORY = [
  { role: 'user', text: 'Call Example Bistro and book a table.', minutes_ago: 3 },
  { role: 'assistant', text: 'Reply yes to place the call.', minutes_ago: 2 },
]

describe('wrangler target seedFixture: fixtures.history → MCP-24 conversation', () => {
  test('a DM history becomes conversation { channel, chat_id, sender, history } with no history key', () => {
    const inbound = { channel: 'sl', sender: 'U0EVALOWNER', chat: 'D0EVAL', text: 'yes please' }
    const f = seedFixture({ profile: { agent: 'a' }, bindings: [{ channel: 'sl', sender_id: 'U0EVALOWNER' }], history: HISTORY }, inbound)
    assert.equal('history' in f, false)
    assert.deepEqual(f.conversation, { channel: 'sl', chat_id: 'D0EVAL', sender: 'U0EVALOWNER', history: HISTORY })
    assert.deepEqual(f.profile, { agent: 'a' })
    assert.deepEqual(f.allowlist, [{ channel: 'sl', sender_id: 'U0EVALOWNER' }])
  })

  test('a group chat history carries the group sender, and minutes_ago stays optional', () => {
    const inbound = { channel: 'wa', sender: '15555550112', chat: '120363000000000000@g.us', text: 'yes' }
    const f = seedFixture({ history: [{ role: 'assistant', text: 'Reply yes.' }] }, inbound)
    assert.deepEqual(f.conversation, { channel: 'wa', chat_id: '120363000000000000@g.us', sender: '15555550112', history: [{ role: 'assistant', text: 'Reply yes.' }] })
  })

  test('no history → no conversation section', () => {
    const f = seedFixture({ profile: { agent: 'a' } }, { channel: 'sl', sender: 'U', chat: 'D', text: 'x' })
    assert.equal('conversation' in f, false)
    assert.equal('history' in f, false)
  })
})

// A fake fermi-mcp checkout and a fake `npx` on PATH: `wrangler dev` becomes a
// loopback server answering /health, eval-seed.mjs records the fixture it gets.
function fakeWorker() {
  const root = tmp()
  const worker = join(root, 'packages/worker')
  mkdirSync(join(worker, 'scripts'), { recursive: true })
  writeFileSync(join(worker, 'wrangler.eval.jsonc'), '{}\n')
  const capture = join(root, 'seeded.json')
  writeFileSync(join(worker, 'scripts/eval-seed.mjs'), `import { copyFileSync } from 'node:fs'\ncopyFileSync(process.argv[2], ${JSON.stringify(capture)})\nprocess.exit(1)\n`)
  writeFileSync(join(worker, 'scripts/eval-dump.mjs'), 'console.log("{}")\n')
  const bin = join(root, 'bin')
  mkdirSync(bin)
  writeFileSync(
    join(bin, 'npx'),
    `#!${process.execPath}\nconst port = Number(process.argv[process.argv.indexOf('--port') + 1])\nrequire('node:http').createServer((q, s) => s.end('ok')).listen(port, '127.0.0.1')\n`,
  )
  chmodSync(join(bin, 'npx'), 0o755)
  return { root, capture, bin }
}

test('the runner seeds a scenario history into the real eval worker as a conversation (no throw)', async () => {
  const { root, capture, bin } = fakeWorker()
  const scenario = loadScenario(join(ROOT, 'evals/scenarios/critical/phone-no-ai-intro.json'))
  const path = process.env.PATH
  process.env.PATH = `${bin}:${path}`
  let res
  try {
    res = await runAttempt({ scenario, attempt: 1, harness: fake, worker: root, timeoutMs: 10_000, outDir: tmp() })
  } finally {
    process.env.PATH = path
  }
  assert.ok(existsSync(capture), `eval-seed.mjs never ran: ${JSON.stringify(res.failed)}`)
  const seeded = JSON.parse(readFileSync(capture, 'utf8'))
  assert.equal('history' in seeded, false)
  assert.deepEqual(seeded.conversation, {
    channel: scenario.inbound.channel,
    chat_id: scenario.inbound.chat,
    sender: scenario.inbound.sender,
    history: scenario.fixtures.history,
  })
})
