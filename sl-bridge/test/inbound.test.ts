import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'node:test'
import type { Config } from '../src/config.ts'
import { buildInbound, forwardToWorker } from '../src/inbound.ts'

// forwardToWorker pokes poll.sh on success, so give it a harmless one.
const home = realpathSync(mkdtempSync(join(tmpdir(), 'fermi-daemon-')))
const pollScript = join(home, 'poll.sh')
writeFileSync(pollScript, '#!/bin/sh\nexit 0\n')
chmodSync(pollScript, 0o755)

const config: Config = {
	FERMI_URL: 'https://fermi.example.workers.dev',
	SLACK_BRIDGE_SECRET: 'test-secret',
	SLACK_BOT_TOKEN: 'test-bot',
	SLACK_APP_TOKEN: 'test-app',
	FERMI_BEARER_TOKEN: 'test-bearer',
	POLL_MS: 3000,
	DAEMON_HOME: home,
}
const event = { user: 'U1', channel: 'C1', text: 'hello', ts: '1730000000.000100' }

const realFetch = globalThis.fetch
afterEach(() => {
	globalThis.fetch = realFetch
})

function stubFetch(statuses: number[]): RequestInit[] {
	const calls: RequestInit[] = []
	globalThis.fetch = (async (_url: string, init: RequestInit) => {
		calls.push(init)
		return new Response(null, { status: statuses[calls.length - 1] })
	}) as typeof fetch
	return calls
}

test('message_id is client_msg_id when present', () => {
	assert.deepEqual(buildInbound({ ...event, client_msg_id: 'cm-1' }, 'Ana', 'T1'), {
		author_id: 'U1',
		display_name: 'Ana',
		channel_id: 'C1',
		team_id: 'T1',
		is_im: false,
		text: 'hello',
		message_id: 'cm-1',
	})
})

test('message_id falls back to ts when client_msg_id is absent or empty', () => {
	assert.equal(buildInbound(event, 'Ana', 'T1').message_id, event.ts)
	assert.equal(buildInbound({ ...event, client_msg_id: '' }, 'Ana', 'T1').message_id, event.ts)
})

test('is_im is set for DMs by channel_type or D-prefixed channel', () => {
	assert.equal(buildInbound({ ...event, channel_type: 'im' }, 'Ana', null).is_im, true)
	assert.equal(buildInbound({ ...event, channel: 'D1' }, 'Ana', null).is_im, true)
})

test('rebuilding the same event gives the same message_id', () => {
	const redelivered = { ...event, client_msg_id: 'cm-1' }
	assert.equal(
		buildInbound(redelivered, 'Ana', 'T1').message_id,
		buildInbound(redelivered, 'Renamed', 'T1').message_id,
	)
})

test('the POST body carries message_id and a retry resends it unchanged', async () => {
	const calls = stubFetch([503, 200])
	await forwardToWorker(config, buildInbound({ ...event, client_msg_id: 'cm-1' }, 'Ana', 'T1'))
	assert.equal(calls.length, 2)
	assert.equal(JSON.parse(calls[0].body as string).message_id, 'cm-1')
	assert.equal(calls[1].body, calls[0].body)
})
