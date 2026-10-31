// The harness's `fermi` MCP server: a localhost pass-through to the eval target's
// /mcp that injects a scenario's faults. `faults` maps a bare tool name to
// { error?: string, latencyMs?: number }: latency delays the call, error answers
// it with an isError result without reaching the target.
// A broken stream (the target cutting the harness's long-lived SSE GET, or the
// harness hanging up) destroys both sides and never escapes: it goes to `onNote`
// as one non-fatal trace note { type: 'note', source: 'mcp-proxy', detail }.
import { Readable, pipeline } from 'node:stream'
import { readBody, sendJson, serve, sleep } from './net.mjs'

const HOP = new Set(['host', 'connection', 'content-length', 'transfer-encoding', 'keep-alive'])

export async function startMcpProxy({ target, faults = {}, onNote = () => {} }) {
  const note = (err) => {
    try {
      onNote({ type: 'note', source: 'mcp-proxy', detail: String(err?.message ?? err) })
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
    // The harness hanging up before the target answers aborts the upstream request too.
    const abort = new AbortController()
    res.once('close', () => abort.abort())
    let up
    try {
      up = await fetch(new URL(req.url, target), { method: req.method, headers, body, signal: abort.signal })
    } catch (err) {
      note(err)
      throw err // serve() answers 500
    }
    const out = {}
    up.headers.forEach((v, k) => !HOP.has(k) && k !== 'content-encoding' && (out[k] = v))
    if (res.destroyed) return up.body?.cancel().catch(() => {})
    res.writeHead(up.status, out)
    if (!up.body) return res.end()
    // pipeline destroys both streams on an error from either side and reports it once.
    pipeline(Readable.fromWeb(up.body), res, (err) => err && note(err))
  })
}
