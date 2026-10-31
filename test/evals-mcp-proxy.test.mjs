// The eval MCP proxy must survive a long-lived SSE GET /mcp being cut on either side.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { startMcpProxy } from '../evals/lib/mcp-proxy.mjs'
import { serve } from '../evals/lib/net.mjs'

// An upstream whose GET /mcp opens an SSE stream, sends one event and then
// (if `cut`) drops the socket mid-stream, as a shutting-down eval worker does.
async function sseUpstream({ cut }) {
  let closed
  const upstreamClosed = new Promise((r) => (closed = r))
  const server = await serve((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write('event: message\ndata: {}\n\n')
    req.socket.once('close', closed)
    if (cut) setTimeout(() => res.socket.destroy(), 50)
  })
  return { ...server, upstreamClosed }
}

// GET through the proxy; resolves on the first chunk with { req, res, ended }.
function openSse(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(`${url}/mcp`, { headers: { accept: 'text/event-stream' } }, (res) => {
      const ended = new Promise((r) => {
        res.on('close', r)
        res.on('error', r)
      })
      res.once('data', () => resolve({ req, res, ended }))
    })
    req.on('error', reject)
  })
}

test('upstream SSE disconnect becomes one mcp-proxy trace note and does not crash the process', { timeout: 5000 }, async () => {
  const up = await sseUpstream({ cut: true })
  const notes = []
  const proxy = await startMcpProxy({ target: up.url, onNote: (n) => notes.push(n) })
  const uncaught = []
  const onUncaught = (err) => uncaught.push(err)
  process.on('uncaughtException', onUncaught)
  try {
    const { ended } = await openSse(proxy.url)
    await ended // the proxy tore down the client side too
    for (let i = 0; i < 50 && !notes.length; i++) await new Promise((r) => setTimeout(r, 10))
    assert.deepEqual(uncaught, [])
    assert.equal(notes.length, 1)
    assert.equal(notes[0].type, 'note')
    assert.equal(notes[0].source, 'mcp-proxy')
    assert.match(notes[0].detail, /terminated|other side closed/)
  } finally {
    process.off('uncaughtException', onUncaught)
    await proxy.close()
    await up.close()
  }
})

test('client disconnect tears down the upstream stream', { timeout: 5000 }, async () => {
  const up = await sseUpstream({ cut: false })
  const notes = []
  const proxy = await startMcpProxy({ target: up.url, onNote: (n) => notes.push(n) })
  try {
    const { req } = await openSse(proxy.url)
    req.destroy()
    await up.upstreamClosed // without cleanup the upstream SSE stream would stay open
    for (let i = 0; i < 50 && !notes.length; i++) await new Promise((r) => setTimeout(r, 10))
    assert.equal(notes.length, 1)
  } finally {
    await proxy.close()
    await up.close()
  }
})

test('a throwing onNote never escapes', { timeout: 5000 }, async () => {
  const up = await sseUpstream({ cut: true })
  let called = false
  const proxy = await startMcpProxy({
    target: up.url,
    onNote: () => {
      called = true
      throw new Error('boom')
    },
  })
  try {
    const { ended } = await openSse(proxy.url)
    await ended
    for (let i = 0; i < 50 && !called; i++) await new Promise((r) => setTimeout(r, 10))
    assert.ok(called)
  } finally {
    await proxy.close()
    await up.close()
  }
})
