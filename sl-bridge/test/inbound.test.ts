import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'node:test'
import type { Config } from '../src/config.ts'
import { buildInbound, forwardToWorker } from '../src/inbound.ts'

const event = {
	type: 'message',
	user: 'U1',
	channel: 'C1',
	channel_type: 'channel',
	text: 'hello',
	ts: '1700000000.000100',
}

test('message_id is client_msg_id when present', () => {
	const msg = buildInbound({ ...event, client_msg_id: 'abc-123' }, 'Ann', 'T1')
	assert.deepEqual(msg, {
		author_id: 'U1',
		display_name: 'Ann',
		channel_id: 'C1',
		team_id: 'T1',
		is_im: false,
		text: 'hello',
		message_id: 'abc-123',
	})
})

test('message_id falls back to ts without client_msg_id', () => {
	const msg = buildInbound(event, 'Ann', null)
	assert.equal(msg.message_id, '1700000000.000100')
	assert.equal(JSON.parse(JSON.stringify(msg)).message_id, '1700000000.000100')
})

test('is_im is set for DM channels', () => {
	assert.equal(buildInbound({ ...event, channel: 'D1', channel_type: undefined }, 'Ann', null).is_im, true)
	assert.equal(buildInbound({ ...event, channel_type: 'im' }, 'Ann', null).is_im, true)
})

const realFetch = globalThis.fetch
afterEach(() => {
	globalThis.fetch = realFetch
})

test('a retried delivery sends the same message_id', async () => {
	// Fake poll.sh so the post-success poke does not spawn anything real.
	const home = realpathSync(mkdtempSync(join(tmpdir(), 'fermi-daemon-')))
	const poll = join(home, 'poll.sh')
	writeFileSync(poll, '#!/bin/sh\nexit 0\n')
	chmodSync(poll, 0o755)
	const config: Config = {
		FERMI_URL: 'https://fermi.example.workers.dev',
		SLACK_BRIDGE_SECRET: 'test-secret',
		SLACK_BOT_TOKEN: 'xoxb-test',
		SLACK_APP_TOKEN: 'xapp-test',
		FERMI_BEARER_TOKEN: 'test-bearer',
		POLL_MS: 3000,
		DAEMON_HOME: home,
	}
	const calls: { url: string; body: Record<string, unknown> }[] = []
	globalThis.fetch = (async (url: string, init: RequestInit) => {
		calls.push({ url, body: JSON.parse(String(init.body)) })
		return new Response(null, { status: calls.length === 1 ? 503 : 200 })
	}) as typeof fetch

	await forwardToWorker(config, buildInbound({ ...event, client_msg_id: 'abc-123' }, 'Ann', 'T1'))

	assert.equal(calls.length, 2)
	assert.equal(calls[0].url, 'https://fermi.example.workers.dev/sl/webhook')
	assert.equal(calls[0].body.message_id, 'abc-123')
	assert.equal(calls[1].body.message_id, 'abc-123')
	assert.deepEqual(calls[1].body, calls[0].body)
})
