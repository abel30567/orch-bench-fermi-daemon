import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { startMcpProxy } from '../evals/lib/mcp-proxy.mjs'
import { serve, sleep } from '../evals/lib/net.mjs'

// An upstream /mcp whose SSE GET sends one event, then the socket is cut, as when
// the eval worker shuts down under a live claude-code session.
async function cuttingUpstream() {
  return serve((req, res) => {
    if (req.method !== 'GET') return void res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}')
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write('event: message\ndata: {}\n\n')
    setTimeout(() => res.socket.destroy(), 50)
  })
}

function getSse(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      res.once('data', () => resolve({ req, res }))
      res.on('error', () => {})
    })
    req.on('error', reject)
  })
}

test('mcp proxy survives an upstream SSE disconnect and reports it once', async () => {
  const upstream = await cuttingUpstream()
  const errors = []
  const proxy = await startMcpProxy({ target: upstream.url, onError: (e) => errors.push(e) })
  try {
    const { res } = await getSse(`${proxy.url}/mcp`)
    await new Promise((r) => res.on('close', r))
    await sleep(50)
    assert.equal(errors.length, 1)
    assert.ok(errors[0].message)
    // The proxy keeps serving.
    const r = await fetch(`${proxy.url}/mcp`, { method: 'POST', body: '{}' })
    assert.deepEqual(await r.json(), { ok: true })
  } finally {
    await proxy.close()
    await upstream.close()
  }
})

test('mcp proxy survives a client disconnect mid-stream', async () => {
  const upstream = await serve((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write('data: {}\n\n')
    const t = setInterval(() => res.write('data: {}\n\n'), 10)
    res.on('close', () => clearInterval(t))
  })
  const errors = []
  const proxy = await startMcpProxy({ target: upstream.url, onError: (e) => errors.push(e) })
  try {
    const { req } = await getSse(`${proxy.url}/mcp`)
    req.destroy()
    await sleep(100)
    assert.equal(errors.length, 1)
    const r = await fetch(`${proxy.url}/mcp`, { method: 'POST', body: '{}' }).catch((e) => e)
    assert.ok(r instanceof Response)
  } finally {
    await proxy.close()
    await upstream.close()
  }
})
