import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { startMcpProxy } from '../evals/lib/mcp-proxy.mjs'
import { serve, sleep } from '../evals/lib/net.mjs'

// An upstream /mcp: GET opens an SSE stream, sends one event, then `onSse(res)` decides
// what happens next; POST answers JSON.
async function upstream(onSse) {
  return serve((req, res) => {
    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write('event: message\ndata: {}\n\n')
      return onSse(res)
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{"jsonrpc":"2.0","id":1,"result":{}}')
  })
}

// A raw GET that resolves on the first body chunk with the request, so the test can hang up.
const openSse = (url) =>
  new Promise((resolve, reject) => {
    const req = http.get(url, { headers: { accept: 'text/event-stream' } }, (res) => {
      res.on('error', () => {})
      res.once('data', (chunk) => resolve({ req, res, first: String(chunk) }))
    })
    req.on('error', () => {})
    setTimeout(() => reject(new Error('no SSE data')), 5000).unref()
  })

const until = async (cond, ms = 3000) => {
  const end = Date.now() + ms
  while (!cond() && Date.now() < end) await sleep(10)
}

describe('mcp proxy stream errors', { timeout: 10_000 }, () => {
  test('upstream cutting the SSE GET is a trace note, not a crash', async () => {
    const target = await upstream((res) => setTimeout(() => res.socket.destroy(), 20))
    const notes = []
    const proxy = await startMcpProxy({ target: target.url, onNote: (n) => notes.push(n) })
    try {
      const { res, first } = await openSse(`${proxy.url}/mcp`)
      assert.match(first, /event: message/)
      await new Promise((r) => res.once('close', r))
      await until(() => notes.length > 0)
      assert.equal(notes.length, 1)
      assert.equal(notes[0].type, 'note')
      assert.equal(notes[0].source, 'mcp-proxy')
      assert.equal(typeof notes[0].detail, 'string')
      assert.ok(notes[0].detail.length > 0)
      // The proxy keeps serving after the broken stream.
      const r = await fetch(`${proxy.url}/mcp`, { method: 'POST', body: '{"jsonrpc":"2.0","id":1,"method":"ping"}' })
      assert.equal(r.status, 200)
      assert.deepEqual(await r.json(), { jsonrpc: '2.0', id: 1, result: {} })
    } finally {
      await proxy.close()
      await target.close()
    }
  })

  test('the harness hanging up mid-stream destroys the upstream side too', async () => {
    let upstreamClosed = false
    const target = await upstream((res) => res.on('close', () => (upstreamClosed = true)))
    const notes = []
    const proxy = await startMcpProxy({ target: target.url, onNote: (n) => notes.push(n) })
    try {
      const { req } = await openSse(`${proxy.url}/mcp`)
      req.destroy()
      await until(() => upstreamClosed)
      assert.ok(upstreamClosed, 'upstream SSE response was not closed')
      await until(() => notes.length > 0)
      assert.ok(notes.every((n) => n.type === 'note' && n.source === 'mcp-proxy' && typeof n.detail === 'string'))
    } finally {
      await proxy.close()
      await target.close()
    }
  })

  test('a throwing onNote never escapes', async () => {
    const target = await upstream((res) => setTimeout(() => res.socket.destroy(), 20))
    let called = 0
    const proxy = await startMcpProxy({ target: target.url, onNote: () => (called++, assert.fail('boom')) })
    try {
      const { res } = await openSse(`${proxy.url}/mcp`)
      await new Promise((r) => res.once('close', r))
      await until(() => called > 0)
      assert.equal(called, 1)
    } finally {
      await proxy.close()
      await target.close()
    }
  })
})
