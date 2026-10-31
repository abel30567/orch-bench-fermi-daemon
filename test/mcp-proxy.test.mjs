// pr-59: the eval MCP proxy survives a proxied stream that breaks mid-way (the
// target cuts a long-lived SSE GET /mcp, or the client hangs up) instead of
// crashing the run with an unhandled 'error' event; the runner records it as a
// non-fatal trace note.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startMcpProxy } from '../evals/lib/mcp-proxy.mjs'
import { serve, sleep } from '../evals/lib/net.mjs'
import { runAttempt } from '../evals/lib/runner.mjs'

const tmp = () => mkdtempSync(join(tmpdir(), 'pr59-'))
const readTrace = (...p) => readFileSync(join(...p), 'utf8').trim().split('\n').map((l) => JSON.parse(l))

// An upstream /mcp whose GET opens an SSE stream, sends one event, then runs `then(req, res)`.
async function sseUpstream(then) {
  const seen = { upstreamClosed: false }
  const up = await serve((req, res) => {
    if (req.method !== 'GET') return res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}')
    res.on('close', () => (seen.upstreamClosed = true))
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write('event: message\ndata: {"hello":1}\n\n')
    then(req, res)
  })
  return { up, seen }
}

async function readFirstChunk(url, signal) {
  const r = await fetch(url, { headers: { accept: 'text/event-stream' }, signal })
  const reader = r.body.getReader()
  const { value } = await reader.read()
  return { reader, text: new TextDecoder().decode(value) }
}

const until = async (cond, ms = 2000) => {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(10)) if (cond()) return true
  return cond()
}

describe('mcp-proxy: broken proxied streams', () => {
  test('the target cutting an SSE GET /mcp mid-stream is reported, not thrown, and the proxy keeps serving', async () => {
    const { up } = await sseUpstream((req) => setTimeout(() => req.socket.destroy(), 50))
    const errors = []
    const proxy = await startMcpProxy({ target: up.url, onError: (err) => errors.push(err) })
    try {
      const { reader, text } = await readFirstChunk(`${proxy.url}/mcp`)
      assert.match(text, /"hello":1/)
      await assert.rejects(async () => {
        for (;;) if ((await reader.read()).done) throw new Error('stream ended without an error')
      })
      assert.ok(await until(() => errors.length > 0), 'onError was called')
      assert.equal(errors.length, 1, errors.map(String).join('\n'))
      assert.ok(String(errors[0]?.message ?? '').length > 0)
      const r = await fetch(`${proxy.url}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
      assert.deepEqual(await r.json(), { ok: true }, 'the proxy still answers after the broken stream')
    } finally {
      await proxy.close()
      await up.close()
    }
  })

  test('the client hanging up an SSE GET /mcp tears down the upstream stream and is reported', async () => {
    const { up, seen } = await sseUpstream(() => {}) // the target keeps the stream open
    const errors = []
    const proxy = await startMcpProxy({ target: up.url, onError: (err) => errors.push(err) })
    try {
      const ac = new AbortController()
      await readFirstChunk(`${proxy.url}/mcp`, ac.signal)
      ac.abort()
      assert.ok(await until(() => seen.upstreamClosed), 'the upstream stream is destroyed')
      assert.ok(await until(() => errors.length > 0), 'onError was called')
      assert.equal(errors.length, 1, errors.map(String).join('\n'))
    } finally {
      await proxy.close()
      await up.close()
    }
  })

  test('through the eval runner: a broken proxied stream is one non-fatal trace note', async () => {
    // A harness whose MCP client hangs up on a call the proxy is still delaying (a latency fault).
    const harness = {
      runOnce: (o) => {
        const events = new EventEmitter()
        const url = JSON.parse(readFileSync(o.mcpConfig, 'utf8')).mcpServers.fermi.url
        const done = (async () => {
          const ac = new AbortController()
          const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'task_claim', arguments: {} } })
          const call = fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body, signal: ac.signal })
          await sleep(50)
          ac.abort()
          await call.catch(() => {})
          await sleep(500) // the proxy forwards once the latency is over and finds the client gone
          events.emit('event', { type: 'turn_end', ok: true, kind: 'ok', detail: '', durationMs: 0, raw: null })
          return { outcome: { ok: true } }
        })()
        return { events, done, close: () => {} }
      },
    }
    const scenario = { name: 'proxy-disconnect', inbound: { channel: 'sl', sender: 'U0', chat: 'D0', text: 'hi' }, faults: { task_claim: { latencyMs: 200 } }, expect: [] }
    const out = tmp()
    const r = await runAttempt({ scenario, attempt: 1, harness, timeoutMs: 10_000, outDir: out })
    assert.deepEqual(r.errorKinds, [], JSON.stringify(r.failed))
    assert.equal(r.pass, true, JSON.stringify(r.failed))
    const notes = readTrace(out, 'proxy-disconnect', '1', 'trace.jsonl').filter((e) => e.type === 'note')
    assert.equal(notes.length, 1, JSON.stringify(notes))
    assert.equal(notes[0].source, 'mcp-proxy')
    assert.equal(typeof notes[0].detail, 'string')
    assert.ok(notes[0].detail.length > 0)
  })
})
