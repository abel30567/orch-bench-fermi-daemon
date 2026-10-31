import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import type { Config } from '../src/config.ts'
import { buildInbound, forwardToWorker } from '../src/inbound.ts'

const config: Config = {
	FERMI_URL: 'https://fermi.example.workers.dev',
	SLACK_BRIDGE_SECRET: 'test-secret',
	SLACK_BOT_TOKEN: 'xoxb-test',
	SLACK_APP_TOKEN: 'xapp-test',
	FERMI_BEARER_TOKEN: 'bearer-test',
	POLL_MS: 3000,
	DAEMON_HOME: '/nonexistent',
}
const event = { type: 'message', user: 'U1', channel: 'D1', text: 'hi', ts: '1700000000.000100' }
const realFetch = globalThis.fetch

afterEach(() => {
	globalThis.fetch = realFetch
})

test('message_id is client_msg_id when present', () => {
	const msg = buildInbound({ ...event, client_msg_id: 'abc-123' }, 'Alice', 'T1')
	assert.deepEqual(msg, {
		author_id: 'U1',
		display_name: 'Alice',
		channel_id: 'D1',
		team_id: 'T1',
		is_im: true,
		text: 'hi',
		message_id: 'abc-123',
	})
})

test('message_id falls back to ts without client_msg_id', () => {
	assert.equal(buildInbound(event, 'Alice', null).message_id, '1700000000.000100')
	assert.equal(buildInbound({ ...event, client_msg_id: '' }, 'Alice', null).message_id, '1700000000.000100')
})

test('retries of the same event send the same message_id', async () => {
	const bodies: string[] = []
	const statuses = [500, 502, 200]
	globalThis.fetch = (async (_url: string, init: RequestInit) => {
		bodies.push(String(init.body))
		return new Response(null, { status: statuses[bodies.length - 1] })
	}) as typeof fetch
	let delivered = 0
	await forwardToWorker(config, buildInbound({ ...event, client_msg_id: 'abc-123' }, 'Alice', 'T1'), {
		retryDelaysMs: [0, 0, 0],
		onDelivered: () => delivered++,
	})
	assert.equal(bodies.length, 3)
	assert.equal(delivered, 1)
	for (const body of bodies) assert.equal(JSON.parse(body).message_id, 'abc-123')
})

test('a redelivered event builds the same message_id', () => {
	const a = buildInbound({ ...event }, 'Alice', 'T1')
	const b = buildInbound({ ...event }, 'Alice (renamed)', 'T1')
	assert.equal(a.message_id, b.message_id)
})
