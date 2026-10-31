// The real eval worker's seed fixture: fixtures.history goes to MCP-24's
// eval-seed.mjs as a `conversation` section for the inbound chat.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { ROOT } from './run-worker.mjs'
import { expandVariants, loadScenario, seedFixture as fakeFixture } from '../evals/lib/scenario.mjs'
import { seedFixture } from '../evals/lib/wrangler-target.mjs'

const history = [
  { role: 'user', text: 'call the dentist', minutes_ago: 12 },
  { role: 'assistant', text: 'Reply yes to place the call.' },
]

describe('wrangler target seedFixture', () => {
  test('a DM history becomes conversation { channel, chat_id, sender, history } with no history key', () => {
    const f = seedFixture({ profile: { agent: 'a' }, history }, { channel: 'sl', sender: 'U0EVALOWNER', chat: 'D0EVAL', text: 'yes' })
    assert.equal('history' in f, false)
    assert.deepEqual(f.conversation, {
      channel: 'sl',
      chat_id: 'D0EVAL',
      sender: 'U0EVALOWNER',
      history: [
        { role: 'user', text: 'call the dentist', minutes_ago: 12 },
        { role: 'assistant', text: 'Reply yes to place the call.' },
      ],
    })
    assert.deepEqual(f.profile, { agent: 'a' })
  })

  test('a group chat carries the group sender', () => {
    const f = seedFixture({ history }, { channel: 'wa', sender: '15555550100', chat: '120363000000000000@g.us', text: 'go ahead' })
    assert.equal(f.conversation.chat_id, '120363000000000000@g.us')
    assert.equal(f.conversation.sender, '15555550100')
    assert.equal('history' in f, false)
  })

  test('without history there is no conversation and the rest matches the fake target fixture', () => {
    const fixtures = { memories: [{ kind: 'fact', body: 'x' }], bindings: [{ channel: 'sl', sender_id: 'U0EVALOWNER' }] }
    const inbound = { channel: 'sl', sender: 'U0EVALOWNER', chat: 'D0EVAL', text: 'hi' }
    const f = seedFixture(fixtures, inbound)
    assert.equal('conversation' in f, false)
    assert.deepEqual(f, fakeFixture(fixtures, inbound))
  })

  test('every critical phone scenario with history seeds a conversation', () => {
    let seeded = 0
    for (const name of ['phone-no-ai-intro', 'phone-redial-needs-confirmation', 'phone-owner-redial-within-30-min', 'phone-brief-no-card', 'phone-brief-no-password']) {
      for (const s of expandVariants(loadScenario(join(ROOT, `evals/scenarios/critical/${name}.json`)))) {
        if (!s.fixtures?.history?.length) continue
        const f = seedFixture(s.fixtures, s.inbound)
        assert.equal('history' in f, false, s.name)
        assert.equal(f.conversation.channel, s.inbound.channel, s.name)
        assert.equal(f.conversation.chat_id, s.inbound.chat, s.name)
        assert.equal(f.conversation.sender, s.inbound.sender, s.name)
        assert.equal(f.conversation.history.length, s.fixtures.history.length, s.name)
        seeded++
      }
    }
    assert.ok(seeded >= 5, `${seeded} scenarios with history`)
  })
})
