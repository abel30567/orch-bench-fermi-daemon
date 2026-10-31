// The harness's `fermi` MCP server: a localhost pass-through to the eval target's
// /mcp that injects a scenario's faults. `faults` maps a bare tool name to
// { error?: string, latencyMs?: number }: latency delays the call, error answers
// it with an isError result without reaching the target. A broken stream (the
// harness's long-lived SSE GET cut by either side) destroys both sides and is
// reported once per request through `onNote`, as a non-fatal trace note.
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { readBody, sendJson, serve, sleep } from './net.mjs'

const HOP = new Set(['host', 'connection', 'content-length', 'transfer-encoding', 'keep-alive'])

export async function startMcpProxy({ target, faults = {}, onNote = () => {} }) {
  const pipes = new Set()
  const server = await serve(async (req, res) => {
    let noted = false
    const note = (err) => {
      if (noted) return
      noted = true
      try {
        onNote({ type: 'note', source: 'mcp-proxy', detail: String(err?.message ?? err) })
      } catch {} // a note must never take the run down, whatever the listener does
    }
    res.on('error', note)
    const body = req.method === 'POST' ? await readBody(req) : undefined
    let msg = null
    try {
      msg = body ? JSON.parse(body) : null
    } catch {}
    const fault = msg?.method === 'tools/call' ? faults[msg.params?.name] : null
    if (fault?.latencyMs) await sleep(fault.latencyMs)
    if (fault?.error != null)
      return sendJson(res, 200, { jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: String(fault.error) }], isError: true } })

    const headers = Object.fromEntries(Object.entries(req.headers).filter(([k]) => !HOP.has(k)))
    const up = await fetch(new URL(req.url, target), { method: req.method, headers, body })
    const out = {}
    up.headers.forEach((v, k) => !HOP.has(k) && k !== 'content-encoding' && (out[k] = v))
    res.writeHead(up.status, out)
    if (!up.body) return res.end()
    const pipe = pipeline(Readable.fromWeb(up.body), res)
      .catch(note)
      .finally(() => pipes.delete(pipe))
    pipes.add(pipe)
    await pipe
  })
  return {
    ...server,
    // Cutting the connections ends the open streams; wait so their notes land before the attempt returns.
    close: async () => {
      await server.close()
      await Promise.all(pipes)
    },
  }
}
