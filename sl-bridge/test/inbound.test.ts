import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Config } from '../src/config.ts'
import { buildInbound, forwardToWorker } from '../src/inbound.ts'

const event = {
	type: 'message',
	user: 'U1',
	channel: 'D123',
	text: 'hello',
	ts: '1730419200.000100',
	client_msg_id: '6f1c2e0a-1111-4222-8333-444455556666',
}

const config: Config = {
	FERMI_URL: 'http://fermi.test',
	SLACK_BRIDGE_SECRET: 'secret',
	SLACK_BOT_TOKEN: 'xoxb',
	SLACK_APP_TOKEN: 'xapp',
	FERMI_BEARER_TOKEN: 'bearer',
	POLL_MS: 3000,
	DAEMON_HOME: '/nonexistent',
}

test('message_id is client_msg_id when present', () => {
	const msg = buildInbound(event, 'Ada', 'T1')
	assert.deepEqual(msg, {
		author_id: 'U1',
		display_name: 'Ada',
		channel_id: 'D123',
		team_id: 'T1',
		is_im: true,
		text: 'hello',
		message_id: event.client_msg_id,
	})
})

test('message_id falls back to ts when client_msg_id is absent', () => {
	const { client_msg_id: _omit, ...noClientId } = event
	assert.equal(buildInbound({ ...noClientId, channel: 'C9' }, 'Ada', null).message_id, event.ts)
	assert.equal(buildInbound({ ...event, client_msg_id: '' }, 'Ada', null).message_id, event.ts)
})

test('buildInbound throws when there is no id at all', () => {
	const { client_msg_id: _a, ts: _b, ...noIds } = event
	assert.throws(() => buildInbound(noIds, 'Ada', null))
})

test('the same event builds the same message_id', () => {
	assert.equal(buildInbound(event, 'Ada', 'T1').message_id, buildInbound({ ...event }, 'Ada', 'T1').message_id)
})

test('retries of one delivery send the same message_id in every POST body', async () => {
	const bodies: string[] = []
	const statuses = [500, 503, 200]
	let delivered = 0
	const ok = await forwardToWorker(config, buildInbound(event, 'Ada', 'T1'), {
		retryDelaysMs: [0, 0, 0],
		fetch: (async (url: string | URL | Request, init?: RequestInit) => {
			assert.equal(String(url), 'http://fermi.test/sl/webhook')
			bodies.push(String(init?.body))
			return new Response(null, { status: statuses[bodies.length - 1] })
		}) as typeof fetch,
		onDelivered: () => {
			delivered++
		},
	})
	assert.equal(ok, true)
	assert.equal(delivered, 1)
	assert.equal(bodies.length, 3)
	for (const b of bodies) assert.equal(JSON.parse(b).message_id, event.client_msg_id)
})

test('network errors are retried with the same message_id, then dropped', async () => {
	const ids: string[] = []
	const ok = await forwardToWorker(config, buildInbound({ ...event, client_msg_id: undefined }, 'Ada', 'T1'), {
		retryDelaysMs: [0, 0],
		fetch: (async (_url: string | URL | Request, init?: RequestInit) => {
			ids.push(JSON.parse(String(init?.body)).message_id)
			throw new Error('ECONNREFUSED')
		}) as typeof fetch,
		onDelivered: () => assert.fail('should not deliver'),
	})
	assert.equal(ok, false)
	assert.deepEqual(ids, [event.ts, event.ts, event.ts])
})
