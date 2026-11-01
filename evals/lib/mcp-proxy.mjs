// The harness's `fermi` MCP server: a localhost pass-through to the eval target's
// /mcp that injects a scenario's faults. `faults` maps a bare tool name to
// { error?: string, latencyMs?: number }: latency delays the call, error answers
// it with an isError result without reaching the target.
//
// A forwarded response body (e.g. the harness's long-lived SSE `GET /mcp`) can be
// cut from either side: the target shuts down, or the client disconnects. Both
// sides are then destroyed and the error goes to `onError(err)` (never thrown), so
// the runner can trace it as a non-fatal note instead of crashing the run.
import { pipeline, Readable } from 'node:stream'
import { readBody, sendJson, serve, sleep } from './net.mjs'

const HOP = new Set(['host', 'connection', 'content-length', 'transfer-encoding', 'keep-alive'])

export async function startMcpProxy({ target, faults = {}, onError = () => {} }) {
  const report = (err) => {
    try {
      onError(err)
    } catch {}
  }
  return serve(async (req, res) => {
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
    // pipeline destroys both streams on an error from either side and hands it to
    // the callback once, so no 'error' event is left unhandled.
    pipeline(Readable.fromWeb(up.body), res, (err) => {
      if (err) report(err)
    })
  })
}
