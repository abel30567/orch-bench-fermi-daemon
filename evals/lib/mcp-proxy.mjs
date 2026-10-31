// The harness's `fermi` MCP server: a localhost pass-through to the eval target's
// /mcp that injects a scenario's faults. `faults` maps a bare tool name to
// { error?: string, latencyMs?: number }: latency delays the call, error answers
// it with an isError result without reaching the target. A failed upstream or client
// stream never escapes: both sides are destroyed and `onError` gets the error.
import { Readable, pipeline } from 'node:stream'
import { readBody, sendJson, serve, sleep } from './net.mjs'

const HOP = new Set(['host', 'connection', 'content-length', 'transfer-encoding', 'keep-alive'])
// How pipeline sees any client leaving: a hang-up (or the proxy closing) is the normal end
// of a long-lived stream, a failure of the client socket only shows up on the socket itself.
const CLIENT_GONE = new Set(['ERR_STREAM_PREMATURE_CLOSE', 'ERR_STREAM_DESTROYED'])

export async function startMcpProxy({ target, faults = {}, onError = () => {} }) {
  const report = (err) => {
    if (!err) return
    try {
      onError(err)
    } catch {}
  }
  return serve(async (req, res) => {
    const { socket } = req
    const upstreamAbort = new AbortController()
    let clientErr
    const onClientErr = (err) => {
      clientErr = err
    }
    socket.once('error', onClientErr)
    res.once('close', () => {
      socket.off('error', onClientErr)
      upstreamAbort.abort()
    })

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
    const { signal } = upstreamAbort
    const up = await fetch(new URL(req.url, target), { method: req.method, headers, body, signal }).catch((err) => {
      if (signal.aborted) return null // the client left while the target was answering
      report(err)
      throw err
    })
    if (!up) return report(clientErr)
    const out = {}
    up.headers.forEach((v, k) => !HOP.has(k) && k !== 'content-encoding' && (out[k] = v))
    res.writeHead(up.status, out)
    if (!up.body) return res.end()
    pipeline(Readable.fromWeb(up.body), res, (err) => {
      report(err && (CLIENT_GONE.has(err.code) || err.name === 'AbortError') ? clientErr : err)
    })
  })
}
