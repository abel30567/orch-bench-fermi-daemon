// evals/lib/mcp-proxy.mjs must survive the harness's long-lived SSE `GET /mcp`
// being cut on either side, instead of crashing the run with an unhandled 'error'.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { startMcpProxy } from '../evals/lib/mcp-proxy.mjs'
import { serve, sleep } from '../evals/lib/net.mjs'

// An upstream whose GET /mcp opens an SSE stream, sends one event, then either
// cuts the socket (`cut`) or keeps it open; anything else answers JSON.
async function sseUpstream({ cut }) {
  return serve((req, res) => {
    if (req.method !== 'GET') return res.end('{"ok":true}')
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write('event: message\ndata: {}\n\n')
    if (cut) setTimeout(() => res.socket.destroy(), 50)
  })
}

// GET `url`, resolving on the first chunk with { req, res, closed } (closed settles when the response ends or errors).
function openSse(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      const closed = new Promise((r) => {
        res.on('error', () => r('error'))
        res.on('close', () => r('close'))
      })
      res.once('data', () => resolve({ req, res, closed }))
    })
    req.on('error', reject)
  })
}

describe('mcp proxy stream errors', { timeout: 5000 }, () => {
  test('an upstream SSE cut is reported once through onError and closes the client side', async () => {
    const up = await sseUpstream({ cut: true })
    const errors = []
    const proxy = await startMcpProxy({ target: up.url, onError: (e) => errors.push(e) })
    try {
      const { closed } = await openSse(`${proxy.url}/mcp`)
      await closed
      await sleep(50)
      assert.equal(errors.length, 1, errors.map(String).join('\n'))
      assert.ok(errors[0]?.message, 'the error has a message')
      // The proxy still serves.
      const r = await fetch(`${proxy.url}/mcp`, { method: 'POST', body: '{}' })
      assert.deepEqual(await r.json(), { ok: true })
    } finally {
      await proxy.close()
      await up.close()
    }
  })

  test('a client hanging up mid-stream does not crash the proxy', async () => {
    const up = await sseUpstream({ cut: false })
    const proxy = await startMcpProxy({ target: up.url })
    try {
      const { req, closed } = await openSse(`${proxy.url}/mcp`)
      req.destroy()
      await closed
      await sleep(50)
      const r = await fetch(`${proxy.url}/mcp`, { method: 'POST', body: '{}' })
      assert.deepEqual(await r.json(), { ok: true })
    } finally {
      await proxy.close()
      await up.close()
    }
  })

  test('closing the proxy while an SSE stream is open does not throw', async () => {
    const up = await sseUpstream({ cut: false })
    const proxy = await startMcpProxy({ target: up.url })
    const { closed } = await openSse(`${proxy.url}/mcp`)
    await up.close()
    await closed
    await proxy.close()
    await sleep(50)
  })
})
