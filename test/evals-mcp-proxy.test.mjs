import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ROOT } from './run-worker.mjs'
import { startMcpProxy } from '../evals/lib/mcp-proxy.mjs'
import { serve, sleep } from '../evals/lib/net.mjs'
import { runAttempt } from '../evals/lib/runner.mjs'

const until = async (cond) => {
  for (let i = 0; i < 200 && !cond(); i++) await sleep(10)
  assert.ok(cond(), 'timed out waiting for the condition')
}

// A proxy in front of a target whose GET /mcp is an open SSE stream.
async function sseProxy() {
  const streams = []
  const upstream = await serve((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write(': open\n\n')
    streams.push(res)
  })
  const notes = []
  const proxy = await startMcpProxy({ target: upstream.url, onNote: (n) => notes.push(n) })
  const ac = new AbortController()
  const client = await fetch(`${proxy.url}/mcp`, { signal: ac.signal, headers: { accept: 'text/event-stream' } })
  const reader = client.body.getReader()
  await reader.read() // the stream is flowing end to end
  return { streams, notes, proxy, upstream, ac, reader, close: () => Promise.all([proxy.close(), upstream.close()]) }
}

// The crash report's sequence in its own process: an uncaught 'error' kills it with a non-zero exit.
const SURVIVOR = `
  import { startMcpProxy } from './evals/lib/mcp-proxy.mjs'
  import { serve, sleep } from './evals/lib/net.mjs'
  let stream
  const upstream = await serve((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write(': open\\n\\n')
    stream = res
  })
  const proxy = await startMcpProxy({ target: upstream.url })
  const client = await fetch(proxy.url + '/mcp')
  const reader = client.body.getReader()
  await reader.read()
  stream.destroy()
  await reader.read().catch(() => {})
  await sleep(100)
  console.log('survived')
  process.exit(0)
`

describe('MCP proxy: broken streams', () => {
  test('the upstream SSE stream dying does not crash the process', () => {
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', SURVIVOR], { cwd: ROOT, encoding: 'utf8', timeout: 20_000 })
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, /survived/)
  })

  test('the target cutting the SSE stream ends the client side and leaves one note', async () => {
    const s = await sseProxy()
    s.streams[0].destroy()
    await assert.rejects(async () => {
      for (;;) if ((await s.reader.read()).done) return
    }, /terminated/) // the client is cut too, not left hanging or sent a clean end
    await until(() => s.notes.length)
    await sleep(50)
    assert.deepEqual(s.notes, [{ type: 'note', source: 'mcp-proxy', detail: 'terminated' }])
    await s.close()
  })

  test('the client hanging up destroys the upstream stream and leaves one note', async () => {
    const s = await sseProxy()
    s.ac.abort()
    await until(() => s.streams[0].destroyed)
    await until(() => s.notes.length)
    await sleep(50)
    assert.equal(s.notes.length, 1)
    assert.equal(s.notes[0].source, 'mcp-proxy')
    assert.equal(typeof s.notes[0].detail, 'string')
    assert.ok(s.notes[0].detail.length)
    await s.close()
  })

  test('the runner teardown order (proxy, then target) is clean and silent', async () => {
    const s = await sseProxy()
    await s.proxy.close()
    await s.upstream.close()
    await sleep(50)
    assert.ok(s.streams[0].destroyed)
    assert.deepEqual(s.notes, [])
  })

  test('the proxy keeps serving after a broken stream', async () => {
    const s = await sseProxy()
    s.streams[0].destroy()
    await until(() => s.notes.length)
    const next = await fetch(`${s.proxy.url}/mcp`)
    assert.equal(next.status, 200)
    await next.body.cancel()
    await s.close()
  })

  test('a target that is down answers 500 and leaves one note', async () => {
    const dead = await serve(() => {})
    await dead.close()
    const notes = []
    const proxy = await startMcpProxy({ target: dead.url, onNote: (n) => notes.push(n) })
    const r = await fetch(`${proxy.url}/mcp`, { method: 'POST', body: '{}' })
    assert.equal(r.status, 500)
    assert.equal(notes.length, 1)
    await proxy.close()
  })

  test('a complete response leaves no note', async () => {
    const upstream = await serve((req, res) => res.end('ok'))
    const notes = []
    const proxy = await startMcpProxy({ target: upstream.url, onNote: (n) => notes.push(n) })
    assert.equal(await (await fetch(`${proxy.url}/mcp`)).text(), 'ok')
    await sleep(50)
    assert.deepEqual(notes, [])
    await Promise.all([proxy.close(), upstream.close()])
  })
})

describe('MCP proxy: the attempt trace', () => {
  test('a broken request is a note in trace.jsonl and does not fail the attempt', async () => {
    const out = mkdtempSync(join(tmpdir(), 'mcp-proxy-'))
    // A harness whose MCP request is dropped while the proxy holds it, then finishes its turn.
    const harness = {
      runOnce: ({ mcpConfig }) => {
        const events = new EventEmitter()
        const { url } = JSON.parse(readFileSync(mcpConfig, 'utf8')).mcpServers.fermi
        const done = (async () => {
          await null
          const ac = new AbortController()
          const call = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'task_claim', arguments: {} } }
          const dropped = fetch(url, { method: 'POST', body: JSON.stringify(call), signal: ac.signal }).catch(() => {})
          await sleep(30)
          ac.abort()
          await dropped
          await sleep(120)
          const outcome = { type: 'turn_end', ok: true, kind: null, detail: null, durationMs: 0, raw: null }
          events.emit('event', outcome)
          return { code: 0, outcome, events: [outcome], stderr: '' }
        })()
        return { events, done, close: () => {} }
      },
    }
    const scenario = {
      name: 'unit',
      fixtures: { bindings: [{ channel: 'sl', sender_id: 'U0EVALOWNER' }] },
      inbound: { channel: 'sl', sender: 'U0EVALOWNER', chat: 'D0EVAL', text: 'hi' },
      faults: { task_claim: { latencyMs: 80 } },
      expect: [],
    }
    const r = await runAttempt({ scenario, attempt: 1, harness, timeoutMs: 5000, outDir: out })
    assert.equal(r.pass, true, JSON.stringify(r.failed))
    assert.deepEqual(r.errorKinds, [])
    const trace = readFileSync(join(out, 'unit/1/trace.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    const notes = trace.filter((e) => e.type === 'note')
    assert.equal(notes.length, 1, JSON.stringify(trace))
    assert.equal(notes[0].source, 'mcp-proxy')
  })
})
