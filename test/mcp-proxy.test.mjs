// The eval MCP proxy must survive a cut upstream stream (the harness's SSE GET /mcp
// when the eval worker shuts down) and a client that disconnects mid-stream.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { startMcpProxy } from '../evals/lib/mcp-proxy.mjs'
import { proxyNote } from '../evals/lib/runner.mjs'
import { serve, sleep } from '../evals/lib/net.mjs'

// An upstream whose GET /mcp opens an SSE stream, sends one event, then drops the socket.
async function cuttingUpstream({ cutAfterMs = 50 } = {}) {
  return serve((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write('event: message\ndata: {}\n\n')
    setTimeout(() => res.socket.destroy(), cutAfterMs)
  })
}

test('an upstream SSE disconnect is reported, not thrown', async () => {
  const up = await cuttingUpstream()
  const errors = []
  const proxy = await startMcpProxy({ target: up.url, onError: (e) => errors.push(e) })
  try {
    const res = await fetch(`${proxy.url}/mcp`, { headers: { accept: 'text/event-stream' } })
    assert.equal(res.status, 200)
    await assert.rejects(res.text()) // the client sees its stream cut too
    for (let i = 0; i < 50 && !errors.length; i++) await sleep(10)
    assert.equal(errors.length, 1, String(errors))
    const note = proxyNote(errors[0])
    assert.equal(note.source, 'mcp-proxy')
    assert.equal(typeof note.detail, 'string')
    assert.ok(note.detail.length > 0)
    // The proxy still serves after the cut.
    const again = await fetch(`${proxy.url}/mcp`)
    assert.equal(again.status, 200)
    await again.text().catch(() => {})
  } finally {
    await proxy.close()
    await up.close()
  }
})

test('a client that disconnects mid-stream does not crash the proxy', async () => {
  const up = await serve((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write('data: {}\n\n')
    const t = setInterval(() => res.write('data: {}\n\n'), 10)
    res.on('close', () => clearInterval(t))
  })
  const errors = []
  const proxy = await startMcpProxy({ target: up.url, onError: (e) => errors.push(e) })
  try {
    const ac = new AbortController()
    const res = await fetch(`${proxy.url}/mcp`, { signal: ac.signal })
    const reader = res.body.getReader()
    await reader.read()
    ac.abort()
    await sleep(100)
    const again = await fetch(`${proxy.url}/mcp`, { signal: AbortSignal.timeout(2000) })
    assert.equal(again.status, 200)
    await again.body.cancel()
  } finally {
    await proxy.close()
    await up.close()
  }
})

test('an unreachable target answers 502 and is reported', async () => {
  const dead = await serve(() => {})
  await dead.close()
  const errors = []
  const proxy = await startMcpProxy({ target: dead.url, onError: (e) => errors.push(e) })
  try {
    const res = await fetch(`${proxy.url}/mcp`, { method: 'POST', body: '{}' })
    assert.equal(res.status, 502)
    assert.equal(errors.length, 1)
  } finally {
    await proxy.close()
  }
})

// The original crash: an unhandled 'error' on the piped Readable killed the whole process.
test('the cut does not kill the process (isolated child)', () => {
  const lib = (p) => JSON.stringify(fileURLToPath(new URL(p, import.meta.url)))
  const src = `
    const { startMcpProxy } = await import(${lib('../evals/lib/mcp-proxy.mjs')})
    const { serve, sleep } = await import(${lib('../evals/lib/net.mjs')})
    const up = await serve((req, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('data: {}\\n\\n'); setTimeout(() => res.socket.destroy(), 30) })
    const proxy = await startMcpProxy({ target: up.url })
    const res = await fetch(proxy.url + '/mcp')
    await res.text().catch(() => {})
    await sleep(200)
    await proxy.close(); await up.close()
    console.log('SURVIVED')
  `
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', src], { encoding: 'utf8', timeout: 20_000 })
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /SURVIVED/)
})
