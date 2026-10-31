import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { Config } from '../src/config.ts'
import { buildInbound, forwardToWorker } from '../src/inbound.ts'

const event = { user: 'U1', channel: 'C1', text: 'hello', ts: '1700000000.000100' }

function fakeConfig(): Config {
	const home = realpathSync(mkdtempSync(join(tmpdir(), 'fermi-daemon-')))
	writeFileSync(join(home, 'poll.sh'), '#!/bin/sh\n')
	chmodSync(join(home, 'poll.sh'), 0o755)
	return {
		FERMI_URL: 'https://fermi.example.workers.dev',
		SLACK_BRIDGE_SECRET: 'secret',
		SLACK_BOT_TOKEN: 'bot',
		SLACK_APP_TOKEN: 'app',
		FERMI_BEARER_TOKEN: 'bearer',
		POLL_MS: 3000,
		DAEMON_HOME: home,
	}
}

test('message_id is client_msg_id when present', () => {
	const msg = buildInbound({ ...event, client_msg_id: 'abc-123' }, 'Ada', 'T1')
	assert.deepEqual(msg, {
		author_id: 'U1',
		display_name: 'Ada',
		channel_id: 'C1',
		team_id: 'T1',
		is_im: false,
		text: 'hello',
		message_id: 'abc-123',
	})
})

test('message_id falls back to ts without client_msg_id', () => {
	assert.equal(buildInbound(event, 'Ada', 'T1').message_id, event.ts)
	assert.equal(buildInbound({ ...event, client_msg_id: '' }, 'Ada', 'T1').message_id, event.ts)
})

test('DM channels are flagged is_im', () => {
	assert.equal(buildInbound({ ...event, channel: 'D1' }, 'Ada', null).is_im, true)
	assert.equal(buildInbound({ ...event, channel_type: 'im' }, 'Ada', null).is_im, true)
})

test('a retried delivery posts the same message_id', async (t) => {
	const bodies: string[] = []
	t.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
		bodies.push(String(init.body))
		return new Response(null, { status: bodies.length === 1 ? 500 : 200 })
	})
	t.mock.method(console, 'log', () => {})
	const msg = buildInbound({ ...event, client_msg_id: 'abc-123' }, 'Ada', 'T1')
	await forwardToWorker(fakeConfig(), msg)
	assert.equal(bodies.length, 2)
	assert.equal(JSON.parse(bodies[0]).message_id, 'abc-123')
	assert.equal(bodies[1], bodies[0])
})

test('a redelivered event builds the same message_id', () => {
	assert.equal(buildInbound(event, 'Ada', 'T1').message_id, buildInbound({ ...event }, 'Ada', 'T1').message_id)
})
