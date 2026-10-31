// The harness's `fermi` MCP server: a localhost pass-through to the eval target's
// /mcp that injects a scenario's faults. `faults` maps a bare tool name to
// { error?: string, latencyMs?: number }: latency delays the call, error answers
// it with an isError result without reaching the target. A broken request (the
// target or the client hanging up mid-stream) tears down both sides and reaches
// `onNote` as one { type: 'note', source: 'mcp-proxy', detail } trace event; it
// never fails the attempt. close() ending the streams itself is not reported.
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { readBody, sendJson, serve, sleep } from './net.mjs'

const HOP = new Set(['host', 'connection', 'content-length', 'transfer-encoding', 'keep-alive'])

export async function startMcpProxy({ target, faults = {}, onNote = () => {} }) {
  let closing = false
  const proxy = await serve(async (req, res) => {
    try {
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
      if (up.body) await pipeline(Readable.fromWeb(up.body), res) // destroys both sides on any error
      else res.end()
    } catch (err) {
      if (!closing) onNote({ type: 'note', source: 'mcp-proxy', detail: String(err?.message ?? err) })
      throw err // serve() answers 500 if the headers are still unsent
    }
  })
  return {
    ...proxy,
    close: () => {
      closing = true
      return proxy.close()
    },
  }
}
