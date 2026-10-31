import { spawn } from 'node:child_process'
import { join } from 'node:path'
import type { Config } from './config.ts'
import { log } from './log.ts'

const RETRY_DELAYS_MS = [1000, 3000, 9000]

export type SlackMessageEvent = {
	type?: string
	subtype?: string
	bot_id?: string
	user?: string
	channel?: string
	channel_type?: string
	team?: string
	text?: string
	hidden?: boolean
	ts?: string
	client_msg_id?: string
}

export type Inbound = {
	author_id: string
	display_name: string
	channel_id: string
	team_id: string | null
	is_im: boolean
	text: string
	// Stable per Slack message so the worker can dedupe retried deliveries.
	message_id: string | null
}

export type ForwardOptions = {
	retryDelaysMs?: readonly number[]
	onDelivered?: (config: Config) => void
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms))
}

function pokeDaemon(config: Config): void {
	try {
		const pollScript = join(config.DAEMON_HOME, 'poll.sh')
		spawn(pollScript, [], { detached: true, stdio: 'ignore' }).unref()
	} catch (err) {
		log(`warn: failed to spawn poll.sh: ${String(err)}`)
	}
}

function isIm(event: SlackMessageEvent): boolean {
	if (event.channel_type === 'im') return true
	return typeof event.channel === 'string' && event.channel.startsWith('D')
}

/** Build the /sl/webhook body. Callers have already checked user, channel and text. */
export function buildInbound(event: SlackMessageEvent, displayName: string, teamId: string | null): Inbound {
	return {
		author_id: event.user ?? '',
		display_name: displayName,
		channel_id: event.channel ?? '',
		team_id: teamId,
		is_im: isIm(event),
		text: event.text ?? '',
		message_id: event.client_msg_id || event.ts || null,
	}
}

export async function forwardToWorker(config: Config, msg: Inbound, opts: ForwardOptions = {}): Promise<void> {
	const delays = opts.retryDelaysMs ?? RETRY_DELAYS_MS
	const onDelivered = opts.onDelivered ?? pokeDaemon
	const url = `${config.FERMI_URL}/sl/webhook`
	// Serialized once so every retry sends the identical body, message_id included.
	const body = JSON.stringify(msg)
	for (let attempt = 0; attempt < delays.length + 1; attempt++) {
		try {
			const res = await fetch(url, {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					'x-sl-bridge-secret': config.SLACK_BRIDGE_SECRET,
				},
				body,
			})
			if (res.ok) {
				onDelivered(config)
				return
			}
			log(`webhook non-2xx (attempt ${attempt + 1}): ${res.status}`)
		} catch (err) {
			log(`webhook network error (attempt ${attempt + 1}): ${String(err)}`)
		}
		const delay = delays[attempt]
		if (delay !== undefined) await sleep(delay)
	}
	log(
		`DROPPED inbound message from ${msg.author_id} (channel ${msg.channel_id}) after ${delays.length + 1} attempts`,
	)
}
