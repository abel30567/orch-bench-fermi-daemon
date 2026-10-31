// pr-59: the eval MCP proxy survives upstream SSE disconnects and client aborts.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import http from 'node:http'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ROOT } from './run-worker.mjs'
import { startMcpProxy } from '../evals/lib/mcp-proxy.mjs'
import { serve, sleep } from '../evals/lib/net.mjs'
import { runAttempt } from '../evals/lib/runner.mjs'
import { loadScenario } from '../evals/lib/scenario.mjs'

const until = async (cond, ms = 2000) => {
  for (const t0 = Date.now(); !cond(); await sleep(10)) if (Date.now() - t0 > ms) throw new Error('timed out waiting')
}

// An upstream whose GET /mcp opens an SSE stream, sends one event, then drops the socket.
const cuttingUpstream = () =>
  serve((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write('data: {"hello":1}\n\n', () => setTimeout(() => req.socket.destroy(), 20))
  })

describe('mcp-proxy stream errors', () => {
  test('an upstream SSE stream cut mid-flight is reported once and does not crash the process', async () => {
    const upstream = await cuttingUpstream()
    const errors = []
    const proxy = await startMcpProxy({ target: upstream.url, onError: (e) => errors.push(e) })
    try {
      const r = await fetch(`${proxy.url}/mcp`, { headers: { accept: 'text/event-stream' } })
      assert.equal(r.status, 200)
      const reader = r.body.getReader()
      const first = await reader.read()
      assert.match(new TextDecoder().decode(first.value), /hello/)
      // The client side sees the stream end or fail; either way the proxy must stay up.
      await (async () => {
        while (!(await reader.read()).done);
      })().catch(() => {})
      await until(() => errors.length > 0)
      await sleep(50)
      assert.equal(errors.length, 1)
      assert.ok(errors[0]?.message, 'error carries a message')
      // Still serving after the failure.
      const again = await fetch(`${proxy.url}/mcp`)
      assert.equal(again.status, 200)
      await again.body.cancel()
    } finally {
      await proxy.close()
      await upstream.close()
    }
  })

  test('a client that goes away mid-request is reported, not thrown', async () => {
    const upstream = await serve((req, res) => res.end('{}'))
    const errors = []
    const proxy = await startMcpProxy({ target: upstream.url, onError: (e) => errors.push(e) })
    try {
      const req = http.request(`${proxy.url}/mcp`, { method: 'POST', headers: { 'content-length': '1000' } })
      req.on('error', () => {})
      req.write('{"jsonrpc":', () => setTimeout(() => req.destroy(), 20))
      await until(() => errors.length > 0)
      assert.equal(errors.length, 1)
    } finally {
      await proxy.close()
      await upstream.close()
    }
  })
})

describe('runner: a proxy error is a non-fatal trace note', () => {
  test("the attempt still grades and its trace holds one { type: 'note', source: 'mcp-proxy' }", async () => {
    // A harness whose MCP client aborts a request to the proxy mid-body, then ends its turn.
    const harness = {
      runOnce: ({ mcpConfig }) => {
        const url = JSON.parse(readFileSync(mcpConfig, 'utf8')).mcpServers.fermi.url
        const events = new EventEmitter()
        const done = new Promise((resolve) => {
          const req = http.request(url, { method: 'POST', headers: { 'content-length': '1000' } })
          req.on('error', () => {})
          req.write('{"jsonrpc":', () =>
            setTimeout(() => {
              req.destroy()
              setTimeout(() => {
                events.emit('event', { type: 'turn_end', ok: true, kind: 'ok', detail: '', durationMs: 0, raw: null })
                resolve()
              }, 100)
            }, 20),
          )
        })
        return { events, done, close: () => {} }
      },
    }
    const scenario = { ...loadScenario(join(ROOT, 'evals/scenarios/control/emergency-stop-mid-task.json')), session: undefined, expect: [] }
    const out = mkdtempSync(join(tmpdir(), 'pr59-'))
    const r = await runAttempt({ scenario, attempt: 1, harness, timeoutMs: 10_000, outDir: out })
    assert.deepEqual(r.errorKinds, [])
    assert.equal(r.pass, true, JSON.stringify(r.failed))
    const trace = readFileSync(join(out, scenario.name, '1', 'trace.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    const notes = trace.filter((e) => e.type === 'note')
    assert.equal(notes.length, 1, JSON.stringify(trace))
    assert.equal(notes[0].source, 'mcp-proxy')
    assert.equal(typeof notes[0].detail, 'string')
    assert.ok(notes[0].detail.length > 0)
  })
})
