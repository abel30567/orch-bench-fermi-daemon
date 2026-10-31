import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mock, test } from 'node:test'
import type { Config } from '../src/config.ts'
import { buildInbound, forwardToWorker, inboundFromEnvelope } from '../src/inbound.ts'

const event = { type: 'message', user: 'U1', channel: 'C1', text: 'hello', ts: '1700000000.000100' }

const home = realpathSync(mkdtempSync(join(tmpdir(), 'fermi-daemon-')))
writeFileSync(join(home, 'poll.sh'), '#!/bin/sh\nexit 0\n')
chmodSync(join(home, 'poll.sh'), 0o755)
const config: Config = {
	FERMI_URL: 'https://fermi.example.workers.dev',
	SLACK_BRIDGE_SECRET: 'test-secret',
	SLACK_BOT_TOKEN: 'test-bot',
	SLACK_APP_TOKEN: 'test-app',
	FERMI_BEARER_TOKEN: 'test-bearer',
	POLL_MS: 1000,
	DAEMON_HOME: home,
}

// Records every POST body; each entry of `script` is one attempt's outcome.
function stubWorker(t: { after(fn: () => void): void }, script: Array<number | Error>): string[] {
	const bodies: string[] = []
	const fetchMock = mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
		bodies.push(init.body as string)
		const step = script[bodies.length - 1]
		if (step instanceof Error) throw step
		return new Response(null, { status: step })
	})
	const timerMock = mock.method(globalThis, 'setTimeout', (fn: () => void) => {
		fn()
	})
	const logMock = mock.method(console, 'log', () => {})
	t.after(() => {
		fetchMock.mock.restore()
		timerMock.mock.restore()
		logMock.mock.restore()
	})
	return bodies
}

test('message_id is client_msg_id when present', () => {
	const msg = buildInbound({ ...event, client_msg_id: 'client-1' }, 'Test User', 'T1')
	assert.equal(msg.message_id, 'client-1')
})

test('message_id falls back to ts when client_msg_id is absent or empty', () => {
	assert.equal(buildInbound(event, 'Test User', 'T1').message_id, event.ts)
	assert.equal(buildInbound({ ...event, client_msg_id: '' }, 'Test User', 'T1').message_id, event.ts)
})

test('buildInbound keeps the existing payload fields', () => {
	assert.deepEqual(buildInbound({ ...event, channel: 'D1' }, 'Test User', null), {
		author_id: 'U1',
		display_name: 'Test User',
		channel_id: 'D1',
		team_id: null,
		is_im: true,
		text: 'hello',
		message_id: event.ts,
	})
	assert.equal(buildInbound(event, 'Test User', 'T1').is_im, false)
	assert.equal(buildInbound({ ...event, channel_type: 'im' }, 'Test User', 'T1').is_im, true)
})

test('a redelivered event builds the same message_id', () => {
	const redelivered = { ...event, client_msg_id: 'client-1' }
	assert.equal(
		buildInbound(redelivered, 'Test User', 'T1').message_id,
		buildInbound(structuredClone(redelivered), 'Test User', 'T1').message_id,
	)
})

test('inboundFromEnvelope carries the raw event ids into message_id', async () => {
	const resolveName = async (userId: string) => `name-${userId}`
	const withClientId = await inboundFromEnvelope(
		{ team_id: 'T1', event: { ...event, client_msg_id: 'client-1' } },
		'B1',
		resolveName,
	)
	assert.deepEqual(withClientId, {
		author_id: 'U1',
		display_name: 'name-U1',
		channel_id: 'C1',
		team_id: 'T1',
		is_im: false,
		text: 'hello',
		message_id: 'client-1',
	})
	const tsOnly = await inboundFromEnvelope({ event }, 'B1', resolveName)
	assert.equal(tsOnly?.message_id, event.ts)
})

test('inboundFromEnvelope skips what the bridge does not forward', async () => {
	const lookups: string[] = []
	const resolveName = async (userId: string) => {
		lookups.push(userId)
		return userId
	}
	const skipped = [
		{},
		{ event: { ...event, type: 'reaction_added' } },
		{ event: { ...event, bot_id: 'B9' } },
		{ event: { ...event, subtype: 'message_changed' } },
		{ event: { ...event, hidden: true } },
		{ event: { ...event, text: '' } },
		{ event: { ...event, user: undefined } },
		{ event: { ...event, channel: undefined } },
		{ event: { ...event, user: 'B1' } },
	]
	for (const envelope of skipped) {
		assert.equal(await inboundFromEnvelope(envelope, 'B1', resolveName), null)
	}
	assert.deepEqual(lookups, [])
})

test('every retry of a delivery posts the same message_id', async (t) => {
	const bodies = stubWorker(t, [503, new Error('network down'), 200])
	await forwardToWorker(config, buildInbound({ ...event, client_msg_id: 'client-1' }, 'Test User', 'T1'))
	assert.equal(bodies.length, 3)
	for (const body of bodies) {
		assert.equal(JSON.parse(body).message_id, 'client-1')
	}
})

test('the ts fallback also survives retries until the delivery is dropped', async (t) => {
	const bodies = stubWorker(t, [500, 500, 500, 500])
	await forwardToWorker(config, buildInbound(event, 'Test User', 'T1'))
	assert.equal(bodies.length, 4)
	for (const body of bodies) {
		assert.equal(JSON.parse(body).message_id, event.ts)
	}
})
