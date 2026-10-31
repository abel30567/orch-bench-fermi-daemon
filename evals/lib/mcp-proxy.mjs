// The harness's `fermi` MCP server: a localhost pass-through to the eval target's
// /mcp that injects a scenario's faults. `faults` maps a bare tool name to
// { error?: string, latencyMs?: number }: latency delays the call, error answers
// it with an isError result without reaching the target. A failed upstream or client
// stream never escapes: both sides are destroyed and `onError` gets the error.
import { Readable, pipeline } from 'node:stream'
import { readBody, sendJson, serve, sleep } from './net.mjs'

const HOP = new Set(['host', 'connection', 'content-length', 'transfer-encoding', 'keep-alive'])
// A client hanging up (or being closed with the proxy) is the normal end of a long-lived stream, not an error.
const CLIENT_GONE = new Set(['ERR_STREAM_PREMATURE_CLOSE', 'ERR_STREAM_DESTROYED'])

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
    const up = await fetch(new URL(req.url, target), { method: req.method, headers, body }).catch((err) => {
      report(err)
      throw err
    })
    if (res.destroyed) return up.body?.cancel().catch(() => {}) // the client left while the target was answering
    const out = {}
    up.headers.forEach((v, k) => !HOP.has(k) && k !== 'content-encoding' && (out[k] = v))
    res.writeHead(up.status, out)
    if (!up.body) return res.end()
    const upstream = Readable.fromWeb(up.body)
    // Late errors, after pipeline has settled and dropped its own listeners.
    upstream.on('error', () => {})
    res.on('error', () => {})
    pipeline(upstream, res, (err) => {
      if (err && !CLIENT_GONE.has(err.code)) report(err)
    })
  })
}
