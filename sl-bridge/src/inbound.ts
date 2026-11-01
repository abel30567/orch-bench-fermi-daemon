import { spawn } from 'node:child_process'
import { join } from 'node:path'
import type { Config } from './config.ts'
import { log } from './log.ts'

export const RETRY_DELAYS_MS = [1000, 3000, 9000]

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
	/** Stable per Slack message: client_msg_id, falling back to ts. Lets the worker dedupe retries. */
	message_id: string
}

export function isIm(event: SlackMessageEvent): boolean {
	if (event.channel_type === 'im') return true
	return typeof event.channel === 'string' && event.channel.startsWith('D')
}

/**
 * Build the /sl/webhook payload for a Slack message event. The caller filters
 * bot/system messages first; this throws if a required field is missing.
 */
export function buildInbound(event: SlackMessageEvent, displayName: string, teamId: string | null): Inbound {
	const { user, channel, text } = event
	const messageId = event.client_msg_id || event.ts
	if (!user || !channel || !text || !messageId) {
		throw new Error('buildInbound: event is missing user, channel, text or ts')
	}
	return {
		author_id: user,
		display_name: displayName,
		channel_id: channel,
		team_id: teamId,
		is_im: isIm(event),
		text,
		message_id: messageId,
	}
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

export type ForwardOptions = {
	retryDelaysMs?: readonly number[]
	fetch?: typeof fetch
	onDelivered?: (config: Config) => void
}

/** POST the message to the worker, retrying every non-2xx / network error with the same body. */
export async function forwardToWorker(config: Config, msg: Inbound, opts: ForwardOptions = {}): Promise<boolean> {
	const delays = opts.retryDelaysMs ?? RETRY_DELAYS_MS
	const doFetch = opts.fetch ?? fetch
	const onDelivered = opts.onDelivered ?? pokeDaemon
	const url = `${config.FERMI_URL}/sl/webhook`
	// Serialised once so every retry carries the identical message_id.
	const body = JSON.stringify(msg)
	for (let attempt = 0; attempt < delays.length + 1; attempt++) {
		try {
			const res = await doFetch(url, {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					'x-sl-bridge-secret': config.SLACK_BRIDGE_SECRET,
				},
				body,
			})
			if (res.ok) {
				onDelivered(config)
				return true
			}
			log(`webhook non-2xx (attempt ${attempt + 1}): ${res.status}`)
		} catch (err) {
			log(`webhook network error (attempt ${attempt + 1}): ${String(err)}`)
		}
		const delay = delays[attempt]
		if (delay !== undefined) await sleep(delay)
	}
	log(
		`DROPPED inbound message ${msg.message_id} from ${msg.author_id} (channel ${msg.channel_id}) after ${delays.length + 1} attempts`,
	)
	return false
}
