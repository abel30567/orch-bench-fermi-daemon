import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Config } from '../src/config.ts'
import { type ForwardDeps, RETRY_DELAYS_MS, buildInbound, forwardToWorker } from '../src/inbound.ts'

const config: Config = {
	FERMI_URL: 'https://fermi.example.workers.dev',
	SLACK_BRIDGE_SECRET: 'test-secret',
	SLACK_BOT_TOKEN: 'xoxb-test',
	SLACK_APP_TOKEN: 'xapp-test',
	FERMI_BEARER_TOKEN: 'test-bearer',
	POLL_MS: 3000,
	DAEMON_HOME: '/nonexistent',
}

const baseEvent = { type: 'message', user: 'U1', channel: 'C1', text: 'hi', ts: '1700000000.000100' }

test('message_id is client_msg_id when present', () => {
	const msg = buildInbound({ ...baseEvent, client_msg_id: 'abc-123' }, 'Alice', 'T1')
	assert.deepEqual(msg, {
		author_id: 'U1',
		display_name: 'Alice',
		channel_id: 'C1',
		team_id: 'T1',
		is_im: false,
		text: 'hi',
		message_id: 'abc-123',
	})
})

test('message_id falls back to ts without client_msg_id', () => {
	const msg = buildInbound(baseEvent, 'Alice', 'T1')
	assert.equal(msg.message_id, '1700000000.000100')
})

test('is_im is set for DM channels', () => {
	assert.equal(buildInbound({ ...baseEvent, channel: 'D1' }, 'A', null).is_im, true)
	assert.equal(buildInbound({ ...baseEvent, channel_type: 'im' }, 'A', null).is_im, true)
})

function fakeDeps(statuses: number[]) {
	const calls: { url: string; init: RequestInit }[] = []
	let pokes = 0
	const deps: ForwardDeps = {
		fetch: (async (url: string, init: RequestInit) => {
			calls.push({ url, init })
			return new Response(null, { status: statuses[calls.length - 1] ?? 500 })
		}) as typeof fetch,
		sleep: async () => {},
		poke: () => {
			pokes++
		},
	}
	return { deps, calls, pokes: () => pokes }
}

test('POST body carries message_id', async () => {
	const { deps, calls, pokes } = fakeDeps([200])
	await forwardToWorker(config, buildInbound({ ...baseEvent, client_msg_id: 'abc-123' }, 'Alice', 'T1'), deps)
	assert.equal(calls.length, 1)
	assert.equal(calls[0].url, 'https://fermi.example.workers.dev/sl/webhook')
	assert.equal(JSON.parse(String(calls[0].init.body)).message_id, 'abc-123')
	assert.equal(pokes(), 1)
})

test('retries of the same event send the same message_id', async () => {
	const { deps, calls, pokes } = fakeDeps([500, 503, 200])
	await forwardToWorker(config, buildInbound(baseEvent, 'Alice', 'T1'), deps)
	assert.equal(calls.length, 3)
	const ids = calls.map((c) => JSON.parse(String(c.init.body)).message_id)
	assert.deepEqual(ids, ['1700000000.000100', '1700000000.000100', '1700000000.000100'])
	assert.equal(pokes(), 1)
})

test('gives up after all retries', async () => {
	const { deps, calls, pokes } = fakeDeps([])
	await forwardToWorker(config, buildInbound(baseEvent, 'Alice', 'T1'), deps)
	assert.equal(calls.length, RETRY_DELAYS_MS.length + 1)
	assert.equal(pokes(), 0)
})
