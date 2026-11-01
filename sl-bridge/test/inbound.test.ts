import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Config } from '../src/config.ts'
import { buildInbound, type ForwardDeps, forwardToWorker, RETRY_DELAYS_MS } from '../src/inbound.ts'

const config: Config = {
	FERMI_URL: 'https://fermi.example.workers.dev',
	SLACK_BRIDGE_SECRET: 'test-secret',
	SLACK_BOT_TOKEN: 'xoxb-test',
	SLACK_APP_TOKEN: 'xapp-test',
	FERMI_BEARER_TOKEN: 'test-bearer',
	POLL_MS: 3000,
	DAEMON_HOME: '/nonexistent/fermi-daemon',
}

const baseEvent = { type: 'message', user: 'U1', channel: 'C1', text: 'hi' }

test('buildInbound uses client_msg_id as message_id when present', () => {
	const msg = buildInbound({ ...baseEvent, client_msg_id: 'abc-123', ts: '1700000000.000100' }, 'Ann', 'T1')
	assert.deepEqual(msg, {
		author_id: 'U1',
		display_name: 'Ann',
		channel_id: 'C1',
		team_id: 'T1',
		is_im: false,
		text: 'hi',
		message_id: 'abc-123',
	})
	assert.equal(JSON.parse(JSON.stringify(msg)).message_id, 'abc-123')
})

test('buildInbound falls back to ts when client_msg_id is missing or empty', () => {
	assert.equal(buildInbound({ ...baseEvent, ts: '1700000000.000100' }, 'Ann', 'T1').message_id, '1700000000.000100')
	assert.equal(
		buildInbound({ ...baseEvent, client_msg_id: '', ts: '1700000000.000200' }, 'Ann', null).message_id,
		'1700000000.000200',
	)
})

test('buildInbound keeps is_im detection', () => {
	assert.equal(buildInbound({ ...baseEvent, channel: 'D1', ts: '1' }, 'Ann', null).is_im, true)
	assert.equal(buildInbound({ ...baseEvent, channel_type: 'im', ts: '1' }, 'Ann', null).is_im, true)
})

type Call = { url: string; init: RequestInit }

function fakeDeps(statuses: (number | Error)[]): { deps: ForwardDeps; calls: Call[]; pokes: number[] } {
	const calls: Call[] = []
	const pokes: number[] = []
	let i = 0
	const deps: ForwardDeps = {
		fetch: (async (url: string, init: RequestInit) => {
			calls.push({ url, init })
			const s = statuses[i++] ?? 200
			if (s instanceof Error) throw s
			return new Response(null, { status: s })
		}) as unknown as typeof fetch,
		sleep: async () => {},
		poke: () => {
			pokes.push(1)
		},
	}
	return { deps, calls, pokes }
}

test('every retry of the same event sends the same message_id', async () => {
	const msg = buildInbound({ ...baseEvent, client_msg_id: 'abc-123', ts: '1.1' }, 'Ann', 'T1')
	const { deps, calls, pokes } = fakeDeps([503, new Error('ECONNRESET'), 500, 200])
	await forwardToWorker(config, msg, deps)
	assert.equal(calls.length, 4)
	assert.equal(pokes.length, 1)
	for (const c of calls) {
		assert.equal(c.url, 'https://fermi.example.workers.dev/sl/webhook')
		assert.equal(c.init.method, 'POST')
		const headers = c.init.headers as Record<string, string>
		assert.equal(headers['x-sl-bridge-secret'], 'test-secret')
		assert.equal(JSON.parse(String(c.init.body)).message_id, 'abc-123')
	}
	assert.equal(new Set(calls.map((c) => c.init.body)).size, 1)
})

test('rebuilding the payload for a redelivered event yields the same message_id', () => {
	const event = { ...baseEvent, client_msg_id: 'abc-123', ts: '1.1' }
	assert.equal(buildInbound(event, 'Ann', 'T1').message_id, buildInbound({ ...event }, 'Ann', 'T1').message_id)
	const tsOnly = { ...baseEvent, ts: '1.2' }
	assert.equal(buildInbound(tsOnly, 'Ann', 'T1').message_id, buildInbound({ ...tsOnly }, 'Ann', 'T1').message_id)
})

test('forwardToWorker gives up after all retries without poking', async () => {
	const msg = buildInbound({ ...baseEvent, ts: '1.3' }, 'Ann', 'T1')
	const { deps, calls, pokes } = fakeDeps(Array(RETRY_DELAYS_MS.length + 1).fill(500))
	await forwardToWorker(config, msg, deps)
	assert.equal(calls.length, RETRY_DELAYS_MS.length + 1)
	assert.equal(pokes.length, 0)
})
