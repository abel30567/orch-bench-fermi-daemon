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
	client_msg_id?: string
	ts?: string
}

export type SlackEnvelope = {
	team_id?: string
	event?: SlackMessageEvent
}

export type ForwardableEvent = SlackMessageEvent & {
	user: string
	channel: string
	text: string
}

export type Inbound = {
	author_id: string
	display_name: string
	channel_id: string
	team_id: string | null
	is_im: boolean
	text: string
	message_id: string | undefined
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

export function buildInbound(
	event: ForwardableEvent,
	displayName: string,
	teamId: string | null,
): Inbound {
	return {
		author_id: event.user,
		display_name: displayName,
		channel_id: event.channel,
		team_id: teamId,
		is_im: isIm(event),
		text: event.text,
		// Derived only from the event, so every retry carries the same id.
		message_id: event.client_msg_id || event.ts,
	}
}

// Returns null for envelopes the bridge does not forward.
export async function inboundFromEnvelope(
	body: SlackEnvelope,
	botUserId: string | undefined,
	resolveName: (userId: string) => Promise<string>,
): Promise<Inbound | null> {
	const event = body.event
	if (!event || event.type !== 'message') return null
	if (event.bot_id || event.subtype || event.hidden) return null
	const text = event.text
	const authorId = event.user
	const channelId = event.channel
	if (!text || !authorId || !channelId) return null
	if (botUserId && authorId === botUserId) return null

	const displayName = await resolveName(authorId)
	const teamId = body.team_id ?? event.team ?? null
	return buildInbound(
		{ ...event, user: authorId, channel: channelId, text },
		displayName,
		teamId,
	)
}

export async function forwardToWorker(config: Config, msg: Inbound): Promise<void> {
	const url = `${config.FERMI_URL}/sl/webhook`
	const body = JSON.stringify(msg)
	for (let attempt = 0; attempt < RETRY_DELAYS_MS.length + 1; attempt++) {
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
				pokeDaemon(config)
				return
			}
			log(`webhook non-2xx (attempt ${attempt + 1}): ${res.status}`)
		} catch (err) {
			log(`webhook network error (attempt ${attempt + 1}): ${String(err)}`)
		}
		const delay = RETRY_DELAYS_MS[attempt]
		if (delay !== undefined) await sleep(delay)
	}
	log(
		`DROPPED inbound message from ${msg.author_id} (channel ${msg.channel_id}) after ${RETRY_DELAYS_MS.length + 1} attempts`,
	)
}
