// The harness's `fermi` MCP server: a localhost pass-through to the eval target's
// /mcp that injects a scenario's faults. `faults` maps a bare tool name to
// { error?: string, latencyMs?: number }: latency delays the call, error answers
// it with an isError result without reaching the target.
// A request that fails (the upstream cut mid-stream, e.g. the harness's SSE GET
// when the target shuts down, or the client going away) destroys both sides and
// is reported once through `onError(err)`; the error never escapes the proxy.
import { Readable, pipeline } from 'node:stream'
import { readBody, sendJson, serve, sleep } from './net.mjs'

const HOP = new Set(['host', 'connection', 'content-length', 'transfer-encoding', 'keep-alive'])

export async function startMcpProxy({ target, faults = {}, onError = () => {} }) {
  return serve(async (req, res) => {
    let failed = false
    const fail = (err) => {
      if (failed) return
      failed = true
      try {
        onError(err)
      } catch {}
      if (!res.headersSent && !res.destroyed) sendJson(res, 500, { error: String(err?.message ?? err) })
      else res.destroy()
    }
    res.on('error', fail)
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
      if (up.body) pipeline(Readable.fromWeb(up.body), res, (err) => err && fail(err))
      else res.end()
    } catch (err) {
      fail(err)
    }
  })
}
