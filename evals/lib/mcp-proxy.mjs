// The harness's `fermi` MCP server: a localhost pass-through to the eval target's
// /mcp that injects a scenario's faults. `faults` maps a bare tool name to
// { error?: string, latencyMs?: number }: latency delays the call, error answers
// it with an isError result without reaching the target.
//
// A proxied stream (the harness's long-lived SSE `GET /mcp`) can be cut from
// either side: the target shuts down, or the harness disconnects. Such an error
// never escapes: both sides are destroyed and `onError(err)` is called once per
// request, so the runner can note it in the trace without failing the run.
import { Readable } from 'node:stream'
import { readBody, sendJson, serve, sleep } from './net.mjs'

const HOP = new Set(['host', 'connection', 'content-length', 'transfer-encoding', 'keep-alive'])

export async function startMcpProxy({ target, faults = {}, onError = () => {} }) {
  const report = (err) => {
    try {
      onError(err)
    } catch {}
  }
  return serve(async (req, res) => {
    req.on('error', () => {}) // a client abort; readBody rethrows it for a POST, the response side handles the rest
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
    const abort = new AbortController()
    let src = null
    let failed = false
    const fail = (err) => {
      if (failed) return
      failed = true
      abort.abort()
      src?.destroy()
      res.destroy()
      report(err)
    }
    res.on('error', fail)
    // The client went away before the reply finished: stop reading the target.
    res.on('close', () => {
      if (!res.writableFinished) {
        abort.abort()
        src?.destroy()
      }
    })

    let up
    try {
      up = await fetch(new URL(req.url, target), { method: req.method, headers, body, signal: abort.signal })
    } catch (err) {
      if (abort.signal.aborted) return // the client is already gone
      report(err)
      if (!res.headersSent && !res.destroyed) return sendJson(res, 502, { error: String(err?.message ?? err) })
      return void res.destroy()
    }
    const out = {}
    up.headers.forEach((v, k) => !HOP.has(k) && k !== 'content-encoding' && (out[k] = v))
    if (res.destroyed) return void up.body?.cancel().catch(() => {})
    res.writeHead(up.status, out)
    if (!up.body) return void res.end()
    src = Readable.fromWeb(up.body)
    src.on('error', (err) => {
      if (!abort.signal.aborted || !res.destroyed) fail(err)
    })
    src.pipe(res)
  })
}
