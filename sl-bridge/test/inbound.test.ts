import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mock, test } from 'node:test'
import type { Config } from '../src/config.ts'
import { buildInbound, forwardToWorker } from '../src/inbound.ts'

const event = { type: 'message', user: 'U1', channel: 'C1', text: 'hi', ts: '1700000000.000100' }

test('message_id is client_msg_id when present', () => {
	const msg = buildInbound({ ...event, client_msg_id: 'b7e1c2d4-0000-4000-8000-000000000001' }, 'Ada', 'T1')
	assert.deepEqual(msg, {
		author_id: 'U1',
		display_name: 'Ada',
		channel_id: 'C1',
		team_id: 'T1',
		is_im: false,
		text: 'hi',
		message_id: 'b7e1c2d4-0000-4000-8000-000000000001',
	})
})

test('message_id falls back to ts without client_msg_id', () => {
	const msg = buildInbound({ ...event, channel: 'D1' }, 'Ada', null)
	assert.equal(msg.message_id, '1700000000.000100')
	assert.equal(msg.is_im, true)
	assert.equal(msg.team_id, null)
})

test('a retried delivery posts the same message_id every attempt', async () => {
	const home = mkdtempSync(join(tmpdir(), 'sl-bridge-'))
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
	const statuses = [503, 502, 200]
	const bodies: unknown[] = []
	const fetchMock = mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
		assert.equal(url, 'https://fermi.example.workers.dev/sl/webhook')
		bodies.push(JSON.parse(String(init.body)))
		return new Response(null, { status: statuses[bodies.length - 1] })
	})
	try {
		const msg = buildInbound({ ...event, client_msg_id: 'cmid-1' }, 'Ada', 'T1')
		await forwardToWorker(config, msg, [0, 0, 0])
	} finally {
		fetchMock.mock.restore()
	}
	assert.equal(bodies.length, 3)
	for (const body of bodies) assert.equal((body as { message_id: string }).message_id, 'cmid-1')
})
