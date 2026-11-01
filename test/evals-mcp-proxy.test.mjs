// pr-59: the eval MCP proxy must survive a cut SSE stream (upstream shutdown or
// client disconnect) instead of crashing the run with an unhandled 'error' event.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import http from 'node:http'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ROOT } from './run-worker.mjs'
import { startMcpProxy } from '../evals/lib/mcp-proxy.mjs'
import { serve, sleep } from '../evals/lib/net.mjs'
import { runAttempt } from '../evals/lib/runner.mjs'
import { loadScenario } from '../evals/lib/scenario.mjs'
import * as fake from '../evals/harness/fake.mjs'

// An upstream whose GET /mcp opens an SSE stream, sends one event, then is cut.
const sseUpstream = ({ cut = true, onClose } = {}) =>
  serve((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write('event: message\ndata: {}\n\n')
    if (onClose) res.on('close', onClose)
    if (cut) setTimeout(() => res.socket.destroy(), 50)
  })

// GET the proxy's /mcp; resolves once the first SSE chunk arrives.
const openSse = (url) =>
  new Promise((resolve, reject) => {
    const req = http.get(`${url}/mcp`, { headers: { accept: 'text/event-stream' } }, (res) => {
      res.on('error', () => {})
      res.once('data', () => resolve({ req, res }))
    })
    req.on('error', reject)
  })
const closed = (res) => new Promise((r) => (res.once('close', r), res.resume()))

describe('mcp-proxy: cut SSE streams (pr-59)', () => {
  // The original crash was an unhandled 'error' that killed the process; run it in
  // a child so node:test's own handlers cannot mask it.
  test('a process proxying a cut upstream SSE stream exits 0 (no unhandled error)', () => {
    const script = `
      import http from 'node:http'
      import { startMcpProxy } from ${JSON.stringify(join(ROOT, 'evals/lib/mcp-proxy.mjs'))}
      import { serve, sleep } from ${JSON.stringify(join(ROOT, 'evals/lib/net.mjs'))}
      const up = await serve((req, res) => {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.write('data: {}\\n\\n')
        setTimeout(() => res.socket.destroy(), 50)
      })
      const proxy = await startMcpProxy({ target: up.url })
      await new Promise((resolve) => http.get(proxy.url + '/mcp', (res) => { res.on('error', () => {}); res.on('close', resolve); res.resume() }).on('error', resolve))
      await sleep(200)
      await proxy.close(); await up.close()
      console.log('survived')
    `
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 20_000 })
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, /survived/)
  })

  test('upstream disconnect: the client stream ends, one error with a message is reported, the proxy keeps serving', async () => {
    const up = await sseUpstream()
    const errors = []
    const proxy = await startMcpProxy({ target: up.url, onError: (e) => errors.push(e) })
    try {
      await closed((await openSse(proxy.url)).res)
      await sleep(50)
      assert.equal(errors.length, 1)
      assert.ok(errors[0].message)
      const again = await openSse(proxy.url)
      again.req.destroy()
    } finally {
      await proxy.close()
      await up.close()
    }
  })

  test('client disconnect mid-stream: the upstream stream is destroyed', async () => {
    let upClosed
    const upGone = new Promise((r) => (upClosed = r))
    const up = await sseUpstream({ cut: false, onClose: upClosed })
    const proxy = await startMcpProxy({ target: up.url })
    try {
      const { req } = await openSse(proxy.url)
      req.destroy()
      let timer
      await Promise.race([upGone, new Promise((_, rej) => (timer = setTimeout(() => rej(new Error('upstream stream was not destroyed')), 3000)))])
      clearTimeout(timer)
    } finally {
      await proxy.close()
      await up.close()
    }
  })

  test('an onError that throws never escapes', async () => {
    const up = await sseUpstream()
    const proxy = await startMcpProxy({
      target: up.url,
      onError: () => {
        throw new Error('boom')
      },
    })
    try {
      await closed((await openSse(proxy.url)).res)
      await sleep(50)
    } finally {
      await proxy.close()
      await up.close()
    }
  })

  test('runAttempt: a cut harness SSE stream is one non-fatal trace note and the attempt still passes', async (t) => {
    // The upstream GET /mcp body streams one event, then errors (the target going away).
    const realFetch = globalThis.fetch
    t.after(() => (globalThis.fetch = realFetch))
    globalThis.fetch = async (url, init = {}) => {
      if ((init.method ?? 'GET') !== 'GET' || !String(url).endsWith('/mcp')) return realFetch(url, init)
      const body = new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode('event: message\ndata: {}\n\n'))
          setTimeout(() => c.error(new TypeError('terminated')), 30)
        },
      })
      return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    }
    // The fake harness, plus the long-lived SSE GET /mcp a real harness opens.
    const harness = {
      runOnce: (o) => {
        const url = JSON.parse(readFileSync(o.mcpConfig, 'utf8')).mcpServers.fermi.url
        const sse = openSse(url.replace(/\/mcp$/, '')).then(({ res }) => closed(res)).then(() => sleep(100)) // let the proxy settle the cut
        const inner = fake.runOnce(o)
        return { ...inner, done: sse.then(() => inner.done) }
      },
    }
    const scenario = loadScenario(join(ROOT, 'evals/scenarios/core/reply-then-complete.json'))
    const out = mkdtempSync(join(tmpdir(), 'pr59-'))
    const r = await runAttempt({ scenario, attempt: 1, harness, timeoutMs: 10_000, outDir: out })
    assert.equal(r.pass, true, JSON.stringify(r.failed))
    assert.deepEqual(r.errorKinds, [])
    const trace = readFileSync(join(out, scenario.name, '1', 'trace.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    const notes = trace.filter((e) => e.type === 'note')
    assert.deepEqual(notes, [{ type: 'note', source: 'mcp-proxy', detail: 'terminated' }])
  })
})
