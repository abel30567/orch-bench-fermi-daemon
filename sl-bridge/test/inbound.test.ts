import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import type { Config } from '../src/config.ts'
import { buildInbound, forwardToWorker } from '../src/inbound.ts'

const event = {
	type: 'message',
	user: 'U1',
	channel: 'C1',
	text: 'hello',
	ts: '1700000000.000100',
	client_msg_id: 'b3a1c2d4-0000-4000-8000-000000000001',
}

const config: Config = {
	FERMI_URL: 'https://fermi.example.workers.dev',
	SLACK_BRIDGE_SECRET: 'test-secret',
	SLACK_BOT_TOKEN: 'xoxb-test',
	SLACK_APP_TOKEN: 'xapp-test',
	FERMI_BEARER_TOKEN: 'test-bearer',
	POLL_MS: 3000,
	DAEMON_HOME: '/nonexistent',
}

const realFetch = globalThis.fetch
afterEach(() => {
	globalThis.fetch = realFetch
})

test('message_id is the Slack client_msg_id when present', () => {
	const msg = buildInbound(event, 'Ada', 'T1')
	assert.deepEqual(msg, {
		author_id: 'U1',
		display_name: 'Ada',
		channel_id: 'C1',
		team_id: 'T1',
		is_im: false,
		text: 'hello',
		message_id: 'b3a1c2d4-0000-4000-8000-000000000001',
	})
})

test('message_id falls back to ts without client_msg_id', () => {
	const { client_msg_id: _, ...noClientId } = event
	assert.equal(buildInbound(noClientId, 'Ada', 'T1').message_id, '1700000000.000100')
	assert.equal(buildInbound({ ...event, client_msg_id: '' }, 'Ada', 'T1').message_id, '1700000000.000100')
})

test('is_im is true for DM channels', () => {
	assert.equal(buildInbound({ ...event, channel: 'D1' }, 'Ada', null).is_im, true)
	assert.equal(buildInbound({ ...event, channel_type: 'im' }, 'Ada', null).is_im, true)
})

test('a retried delivery sends the same message_id in the POST body', async () => {
	const bodies: Record<string, unknown>[] = []
	const statuses = [500, 503, 200]
	globalThis.fetch = (async (url: string, init: RequestInit) => {
		assert.equal(url, 'https://fermi.example.workers.dev/sl/webhook')
		bodies.push(JSON.parse(String(init.body)))
		return new Response(null, { status: statuses[bodies.length - 1] })
	}) as typeof fetch
	let delivered = 0
	await forwardToWorker(config, buildInbound(event, 'Ada', 'T1'), {
		retryDelaysMs: [0, 0, 0],
		onDelivered: () => delivered++,
	})
	assert.equal(bodies.length, 3)
	assert.equal(delivered, 1)
	for (const body of bodies) assert.equal(body.message_id, event.client_msg_id)
})
