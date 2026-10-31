import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startMcpProxy } from '../evals/lib/mcp-proxy.mjs'
import { serve, sleep } from '../evals/lib/net.mjs'
import { runAttempt } from '../evals/lib/runner.mjs'

// An upstream whose GET /mcp is a long-lived SSE stream and whose POST /mcp answers JSON.
async function startUpstream() {
  const streams = []
  const opened = []
  const server = await serve(async (req, res) => {
    if (req.method === 'POST') {
      for await (const _ of req);
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end('{"ok":true}')
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write('data: hello\n\n')
    const waiter = opened.shift()
    if (waiter) waiter(res)
    else streams.push(res)
  })
  const nextStream = () => new Promise((r) => (streams.length ? r(streams.shift()) : opened.push(r)))
  return { ...server, nextStream }
}

async function withProxy(fn) {
  const upstream = await startUpstream()
  const notes = []
  const proxy = await startMcpProxy({ target: upstream.url, onNote: (n) => notes.push(n) })
  try {
    await fn({ upstream, proxy, notes })
  } finally {
    await proxy.close()
    await upstream.close()
  }
}

const until = async (cond) => {
  for (let i = 0; i < 200 && !cond(); i++) await sleep(5)
  assert.ok(cond(), 'condition not reached')
}

// Opens the proxied SSE stream and reads its first event.
async function openSse(proxy, signal) {
  const res = await fetch(`${proxy.url}/mcp`, { signal })
  const reader = res.body.getReader()
  const { value } = await reader.read()
  assert.match(Buffer.from(value).toString(), /data: hello/)
  return reader
}

describe('mcp proxy disconnects', () => {
  test('an upstream cut mid-stream is one note, ends the client stream and leaves the proxy serving', async () => {
    await withProxy(async ({ upstream, proxy, notes }) => {
      const reader = await openSse(proxy)
      ;(await upstream.nextStream()).socket.destroy()
      await assert.rejects(async () => {
        while (!(await reader.read()).done);
      })
      await until(() => notes.length > 0)
      await sleep(20)
      assert.equal(notes.length, 1)
      assert.equal(notes[0].type, 'note')
      assert.equal(notes[0].source, 'mcp-proxy')
      assert.equal(notes[0].detail, 'terminated')

      const res = await fetch(`${proxy.url}/mcp`, { method: 'POST', body: '{}' })
      assert.deepEqual(await res.json(), { ok: true })
      assert.equal(notes.length, 1)
    })
  })

  test('a client disconnect releases the upstream stream and is one note', async () => {
    await withProxy(async ({ upstream, proxy, notes }) => {
      const ac = new AbortController()
      await openSse(proxy, ac.signal)
      const up = await upstream.nextStream()
      const upstreamGone = new Promise((r) => up.once('close', r))
      ac.abort()
      await upstreamGone
      await until(() => notes.length > 0)
      await sleep(20)
      assert.deepEqual(notes.map((n) => n.source), ['mcp-proxy'])
    })
  })

  test('closing the proxy with an open stream, then the target, does not throw', async () => {
    await withProxy(async ({ upstream, proxy, notes }) => {
      const reader = await openSse(proxy)
      reader.read().catch(() => {})
      await proxy.close()
      assert.equal(notes.length, 1) // close() waited for the open relay's note
      await upstream.close()
      await sleep(20)
      assert.equal(notes.length, 1)
    })
  })

  test('an unreachable target answers 500 and is one note', async () => {
    const upstream = await startUpstream()
    await upstream.close()
    const notes = []
    const proxy = await startMcpProxy({ target: upstream.url, onNote: (n) => notes.push(n) })
    const res = await fetch(`${proxy.url}/mcp`, { method: 'POST', body: '{}' })
    assert.equal(res.status, 500)
    await proxy.close()
    assert.equal(notes.length, 1)
    assert.equal(notes[0].source, 'mcp-proxy')
  })

  test('runAttempt keeps the note in the trace and the attempt stays green', async () => {
    // A harness whose client hangs up while a tool call is in flight at the proxy.
    const harness = {
      runOnce: (o) => {
        const events = new EventEmitter()
        const done = (async () => {
          const { url } = JSON.parse(readFileSync(o.mcpConfig, 'utf8')).mcpServers.fermi
          const ac = new AbortController()
          const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'task_claim', arguments: {} } })
          const call = fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body, signal: ac.signal })
          await sleep(20)
          ac.abort()
          await call.catch(() => {})
          await sleep(100)
          events.emit('event', { type: 'turn_end', ok: true, kind: 'ok', detail: 'done', durationMs: 1, raw: null })
        })()
        return { events, done, close: () => {} }
      },
    }
    const scenario = {
      name: 'unit',
      fixtures: { bindings: [{ channel: 'sl', sender_id: 'U0EVALOWNER' }] },
      inbound: { channel: 'sl', sender: 'U0EVALOWNER', chat: 'D0EVAL', text: 'hi' },
      faults: { task_claim: { latencyMs: 50 } },
      expect: [],
    }
    const outDir = mkdtempSync(join(tmpdir(), 'mcp-proxy-'))
    const r = await runAttempt({ scenario, attempt: 1, harness, timeoutMs: 10_000, outDir })
    assert.equal(r.pass, true, JSON.stringify(r.failed))
    assert.deepEqual(r.errorKinds, [])
    const trace = readFileSync(join(outDir, 'unit/1/trace.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    assert.equal(trace.filter((e) => e.type === 'note' && e.source === 'mcp-proxy').length, 1, JSON.stringify(trace))
  })
})
