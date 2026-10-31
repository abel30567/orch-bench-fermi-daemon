import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { Config } from '../src/config.ts'
import { buildInbound, forwardToWorker } from '../src/inbound.ts'

const base = { type: 'message', user: 'U1', channel: 'C1', text: 'hi', ts: '1700000000.000100' }

test('message_id uses client_msg_id when present', () => {
	const msg = buildInbound({ ...base, client_msg_id: 'abc-123' }, 'Ann', 'T1')
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

test('message_id falls back to ts', () => {
	const msg = buildInbound({ ...base, channel: 'D9' }, 'Ann', null)
	assert.equal(msg.message_id, '1700000000.000100')
	assert.equal(msg.is_im, true)
	assert.equal(msg.team_id, null)
})

test('retries of the same event send the same message_id', async () => {
	const bodies: Record<string, unknown>[] = []
	const server = createServer((req, res) => {
		let data = ''
		req.on('data', (c) => (data += c))
		req.on('end', () => {
			bodies.push(JSON.parse(data))
			res.statusCode = bodies.length < 3 ? 503 : 200
			res.end()
		})
	})
	await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
	const { port } = server.address() as AddressInfo
	const config: Config = {
		FERMI_URL: `http://127.0.0.1:${port}`,
		SLACK_BRIDGE_SECRET: 's',
		SLACK_BOT_TOKEN: 'b',
		SLACK_APP_TOKEN: 'a',
		FERMI_BEARER_TOKEN: 't',
		POLL_MS: 1000,
		DAEMON_HOME: mkdtempSync(join(tmpdir(), 'fermi-daemon-')),
	}
	try {
		await forwardToWorker(config, buildInbound({ ...base, client_msg_id: 'abc-123' }, 'Ann', 'T1'), [0, 0, 0])
	} finally {
		server.close()
	}
	assert.equal(bodies.length, 3)
	for (const b of bodies) assert.equal(b.message_id, 'abc-123')
})
