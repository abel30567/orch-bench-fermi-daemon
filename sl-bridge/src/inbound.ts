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
	client_msg_id?: string
	ts?: string
}

// A message event that passed the filters in index.ts: author, channel and
// text are known to be present.
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
	// Stable per Slack message so the worker can dedupe retried deliveries.
	// Omitted from the JSON body when Slack provides neither id.
	message_id: string | undefined
}

export function isIm(event: SlackMessageEvent): boolean {
	if (event.channel_type === 'im') return true
	return typeof event.channel === 'string' && event.channel.startsWith('D')
}

export function messageIdOf(event: SlackMessageEvent): string | undefined {
	if (typeof event.client_msg_id === 'string' && event.client_msg_id !== '') {
		return event.client_msg_id
	}
	if (typeof event.ts === 'string' && event.ts !== '') return event.ts
	return undefined
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
		message_id: messageIdOf(event),
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

export type ForwardDeps = {
	fetch: typeof fetch
	sleep: (ms: number) => Promise<void>
	poke: (config: Config) => void
}

const defaultDeps: ForwardDeps = {
	fetch: (input, init) => fetch(input, init),
	sleep,
	poke: pokeDaemon,
}

export async function forwardToWorker(
	config: Config,
	msg: Inbound,
	deps: ForwardDeps = defaultDeps,
): Promise<void> {
	const url = `${config.FERMI_URL}/sl/webhook`
	// Serialised once: every retry sends the identical body, same message_id.
	const body = JSON.stringify(msg)
	for (let attempt = 0; attempt < RETRY_DELAYS_MS.length + 1; attempt++) {
		try {
			const res = await deps.fetch(url, {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					'x-sl-bridge-secret': config.SLACK_BRIDGE_SECRET,
				},
				body,
			})
			if (res.ok) {
				deps.poke(config)
				return
			}
			log(`webhook non-2xx (attempt ${attempt + 1}): ${res.status}`)
		} catch (err) {
			log(`webhook network error (attempt ${attempt + 1}): ${String(err)}`)
		}
		const delay = RETRY_DELAYS_MS[attempt]
		if (delay !== undefined) await deps.sleep(delay)
	}
	log(
		`DROPPED inbound message from ${msg.author_id} (channel ${msg.channel_id}) after ${RETRY_DELAYS_MS.length + 1} attempts`,
	)
}
