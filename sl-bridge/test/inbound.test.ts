import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'node:test'
import type { Config } from '../src/config.ts'
import { buildInbound, forwardToWorker } from '../src/inbound.ts'

const event = { type: 'message', user: 'U1', channel: 'C1', text: 'hi', ts: '1700000000.000100' }

test('message_id is client_msg_id when present', () => {
	const msg = buildInbound({ ...event, client_msg_id: 'abc-123' }, 'Ann', 'T1')
	assert.deepEqual(msg, {
		author_id: 'U1',
		display_name: 'Ann',
		channel_id: 'C1',
		team_id: 'T1',
		is_im: false,
		text: 'hi',
		message_id: 'abc-123',
	})
})

test('message_id falls back to ts without client_msg_id', () => {
	const msg = buildInbound(event, 'Ann', null)
	assert.equal(msg.message_id, '1700000000.000100')
	assert.equal(JSON.parse(JSON.stringify(msg)).message_id, '1700000000.000100')
})

test('message_id falls back to ts when client_msg_id is empty', () => {
	assert.equal(buildInbound({ ...event, client_msg_id: '' }, 'Ann', null).message_id, '1700000000.000100')
})

const realFetch = globalThis.fetch
afterEach(() => {
	globalThis.fetch = realFetch
})

test('a retried delivery sends the same message_id', async () => {
	const home = mkdtempSync(join(tmpdir(), 'sl-bridge-'))
	const poll = join(home, 'poll.sh')
	writeFileSync(poll, '#!/bin/sh\nexit 0\n')
	chmodSync(poll, 0o755)
	const config = {
		FERMI_URL: 'http://fermi.invalid',
		SLACK_BRIDGE_SECRET: 's',
		DAEMON_HOME: home,
	} as Config

	const bodies: Array<Record<string, unknown>> = []
	globalThis.fetch = (async (_url: string, init: RequestInit) => {
		bodies.push(JSON.parse(String(init.body)))
		return new Response(null, { status: bodies.length === 1 ? 503 : 200 })
	}) as typeof fetch

	await forwardToWorker(config, buildInbound({ ...event, client_msg_id: 'abc-123' }, 'Ann', 'T1'))
	assert.equal(bodies.length, 2)
	assert.equal(bodies[0]!.message_id, 'abc-123')
	assert.equal(bodies[1]!.message_id, 'abc-123')
})
