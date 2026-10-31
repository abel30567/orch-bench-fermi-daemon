// The harness's `fermi` MCP server: a localhost pass-through to the eval target's
// /mcp that injects a scenario's faults. `faults` maps a bare tool name to
// { error?: string, latencyMs?: number }: latency delays the call, error answers
// it with an isError result without reaching the target. A broken stream (the
// harness's long-lived SSE GET cut by either side) destroys both sides and is
// reported once per request through `onNote`, as a non-fatal trace note. close()
// aborts whatever is still in flight and waits for it, so no note lands after it.
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { readBody, sendJson, serve, sleep } from './net.mjs'

const HOP = new Set(['host', 'connection', 'content-length', 'transfer-encoding', 'keep-alive'])

export async function startMcpProxy({ target, faults = {}, onNote = () => {} }) {
  const inflight = new Set()
  const closing = new AbortController()
  const closed = new Promise((r) => closing.signal.addEventListener('abort', r, { once: true }))

  const handle = async (req, res) => {
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
    if (fault?.latencyMs) await Promise.race([sleep(fault.latencyMs), closed])
    if (fault?.error != null)
      return sendJson(res, 200, { jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: String(fault.error) }], isError: true } })

    const headers = Object.fromEntries(Object.entries(req.headers).filter(([k]) => !HOP.has(k)))
    let up
    try {
      up = await fetch(new URL(req.url, target), { method: req.method, headers, body, signal: closing.signal })
    } catch (err) {
      if (!closing.signal.aborted) throw err
      note(err)
      return res.destroy()
    }
    const out = {}
    up.headers.forEach((v, k) => !HOP.has(k) && k !== 'content-encoding' && (out[k] = v))
    res.writeHead(up.status, out)
    if (!up.body) return res.end()
    // pipeline() never attaches to a source it cannot start on (the client is already
    // gone), so the source keeps its own error path and is destroyed here.
    const src = Readable.fromWeb(up.body)
    src.on('error', note)
    await pipeline(src, res).catch((err) => {
      note(err)
      src.destroy()
    })
  }

  const server = await serve((req, res) => {
    const run = handle(req, res)
    const settled = run.catch(() => {}).finally(() => inflight.delete(settled))
    inflight.add(settled)
    return run
  })
  return {
    ...server,
    // Aborting and cutting the connections ends every request; wait so their notes land before the attempt returns.
    close: async () => {
      closing.abort()
      await server.close()
      await Promise.all(inflight)
    },
  }
}
