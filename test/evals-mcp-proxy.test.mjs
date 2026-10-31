// The eval MCP proxy must survive a long-lived SSE GET /mcp being cut on either side.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startMcpProxy } from '../evals/lib/mcp-proxy.mjs'
import { readBody, serve } from '../evals/lib/net.mjs'
import { startFakeTarget } from '../evals/lib/fake-target.mjs'
import { runAttempt } from '../evals/lib/runner.mjs'
import * as fake from '../evals/harness/fake.mjs'

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

// The fake target behind a front that answers GET /mcp with an SSE stream it
// cuts mid-stream; everything else is forwarded unchanged.
async function sseCuttingTarget({ env }) {
  const real = await startFakeTarget({ env })
  const front = await serve(async (req, res) => {
    if (req.method === 'GET' && req.url === '/mcp') {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write('event: message\ndata: {}\n\n')
      return setTimeout(() => res.socket.destroy(), 50)
    }
    const body = req.method === 'POST' ? await readBody(req) : undefined
    const headers = { ...req.headers }
    delete headers.host
    delete headers['content-length']
    const up = await fetch(real.url + req.url, { method: req.method, headers, body })
    const out = {}
    up.headers.forEach((v, k) => !['content-length', 'transfer-encoding', 'content-encoding', 'connection'].includes(k) && (out[k] = v))
    res.writeHead(up.status, out)
    res.end(Buffer.from(await up.arrayBuffer()))
  })
  return {
    ...real,
    url: front.url,
    close: async () => {
      await front.close()
      await real.close()
    },
  }
}

test('runAttempt records a cut upstream SSE stream as one mcp-proxy note in trace.jsonl', { timeout: 15000 }, async () => {
  // The fake harness, but it first opens the SSE GET /mcp through the proxy and waits for it to be cut.
  const harness = {
    runOnce: (opts) => {
      const run = fake.runOnce(opts)
      const { url } = JSON.parse(readFileSync(opts.mcpConfig, 'utf8')).mcpServers.fermi
      // After the client side ends, give the proxy's pipeline callback a moment to record its note.
      const noted = () => /"source":"mcp-proxy"/.test((() => { try { return readFileSync(join(opts.cwd, 'trace.jsonl'), 'utf8') } catch { return '' } })())
      const sse = openSse(url.replace(/\/mcp$/, ''))
        .then(({ ended }) => ended)
        .then(async () => {
          for (let i = 0; i < 100 && !noted(); i++) await new Promise((r) => setTimeout(r, 10))
        })
      return { ...run, done: Promise.all([run.done, sse]).then(([r]) => r) }
    },
  }
  const outDir = mkdtempSync(join(tmpdir(), 'pr59-'))
  const scenario = {
    name: 'sse-cut',
    fixtures: { bindings: [{ channel: 'sl', sender_id: 'U0EVALOWNER' }] },
    inbound: { channel: 'sl', sender: 'U0EVALOWNER', chat: 'D0EVAL', text: 'hi' },
    expect: [{ called: 'channel_send' }],
    fake: {
      script: [
        { tool: 'task_claim', args: { limit: 1, stale_minutes: 25 } },
        { tool: 'channel_send', args: { channel: '${task.channel}', chat_id: '${task.chat_id}', text: 'ok' } },
        { tool: 'task_complete', args: { id: '${task.id}', status: 'done', result: 'r' } },
      ],
    },
  }
  const r = await runAttempt({ scenario, attempt: 1, harness, timeoutMs: 10_000, outDir, startTarget: sseCuttingTarget })
  const trace = readFileSync(join(outDir, 'sse-cut', '1', 'trace.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  const notes = trace.filter((e) => e.type === 'note' && e.source === 'mcp-proxy')
  assert.equal(notes.length, 1, JSON.stringify(trace))
  assert.match(notes[0].detail, /terminated|other side closed/)
  assert.equal(r.pass, true, JSON.stringify(r.failed))
})
