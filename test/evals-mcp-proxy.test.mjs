import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ROOT } from './run-worker.mjs'
import * as fake from '../evals/harness/fake.mjs'
import { startMcpProxy } from '../evals/lib/mcp-proxy.mjs'
import { serve, sleep } from '../evals/lib/net.mjs'
import { runAttempt } from '../evals/lib/runner.mjs'

const until = async (cond, ms = 2000) => {
  const t0 = Date.now()
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('condition not met in time')
    await sleep(5)
  }
}

// An upstream SSE stream: sends one event, then `onStream(res)` decides how it ends.
const sseUpstream = (onStream) =>
  serve((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write('data: hello\n\n')
    return onStream(res)
  })

// Opens `GET /mcp` through the proxy and resolves once the first event arrived.
const openSse = (url) =>
  new Promise((resolve, reject) => {
    const req = http.get(`${url}/mcp`, (res) => {
      res.on('error', () => {})
      const ended = new Promise((r) => res.once('close', r))
      res.once('data', () => resolve({ req, res, ended }))
    })
    req.on('error', reject)
  })

describe('MCP proxy stream failures', () => {
  test('the crash, as the runner process sees it: an upstream SSE cut does not kill it', () => {
    // A subprocess, so an unhandled 'error' event is a real crash and not a node:test failure.
    const script = `
      import http from 'node:http'
      import { startMcpProxy } from './evals/lib/mcp-proxy.mjs'
      import { serve, sleep } from './evals/lib/net.mjs'
      const up = await serve((req, res) => {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.write('data: hello\\n\\n')
        setTimeout(() => res.destroy(), 20)
      })
      const proxy = await startMcpProxy({ target: up.url })
      http.get(proxy.url + '/mcp', (res) => { res.on('error', () => {}); res.resume() }).on('error', () => {})
      await sleep(200)
      await proxy.close()
      await up.close()
      console.log('survived')
    `
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: ROOT, encoding: 'utf8', timeout: 20_000 })
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, /survived/)
  })

  // The worker answers GET /mcp late, and the client or the teardown gets there first.
  for (const mode of ['disconnect', 'close']) {
    test(`the crash, before upstream headers arrive (${mode}): a later upstream cut does not kill the process`, () => {
      const script = `
        import http from 'node:http'
        import { startMcpProxy } from './evals/lib/mcp-proxy.mjs'
        import { serve, sleep } from './evals/lib/net.mjs'
        const up = await serve(async (req, res) => {
          await sleep(100)
          res.writeHead(200, { 'content-type': 'text/event-stream' })
          res.write('data: hello\\n\\n')
        })
        const proxy = await startMcpProxy({ target: up.url })
        const req = http.get(proxy.url + '/mcp')
        req.on('error', () => {})
        await sleep(20)
        if ('${mode}' === 'disconnect') req.destroy()
        else await proxy.close()
        await sleep(200)
        await up.close()
        await sleep(200)
        await proxy.close()
        console.log('survived')
      `
      const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: ROOT, encoding: 'utf8', timeout: 20_000 })
      assert.equal(r.status, 0, r.stderr)
      assert.match(r.stdout, /survived/)
    })
  }

  test('a client gone before upstream headers releases the upstream connection and records one note', async () => {
    let upstreamClosed = false
    const up = await serve(async (req, res) => {
      res.once('close', () => (upstreamClosed = true))
      await sleep(60)
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write('data: hello\n\n')
    })
    const notes = []
    const proxy = await startMcpProxy({ target: up.url, onNote: (n) => notes.push(n) })
    const req = http.get(`${proxy.url}/mcp`)
    req.on('error', () => {})
    await sleep(20)
    req.destroy()
    await until(() => upstreamClosed && notes.length > 0)
    await sleep(30)
    assert.equal(notes.length, 1, JSON.stringify(notes))
    await proxy.close()
    await up.close()
  })

  test('close() during a pending fetch waits for it, its note lands first, an unanswering upstream cannot hang it', async () => {
    let answer
    const up = await serve((req, res) => void (answer = res))
    const notes = []
    const proxy = await startMcpProxy({ target: up.url, onNote: (n) => notes.push(n) })
    const req = http.get(`${proxy.url}/mcp`)
    req.on('error', () => {})
    await until(() => answer)
    await proxy.close()
    assert.equal(notes.length, 1, JSON.stringify(notes))
    await sleep(30)
    assert.equal(notes.length, 1, JSON.stringify(notes))
    await up.close()
  })

  test('close() does not wait out a fault latency and sends nothing upstream after it', async () => {
    let upstreamCalls = 0
    const up = await serve((req, res) => {
      upstreamCalls++
      res.end()
    })
    const notes = []
    const proxy = await startMcpProxy({ target: up.url, faults: { slow_tool: { latencyMs: 300 } }, onNote: (n) => notes.push(n) })
    const req = http.request(`${proxy.url}/mcp`, { method: 'POST' })
    req.on('error', () => {})
    req.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'slow_tool' } }))
    await sleep(50)
    const t0 = Date.now()
    await proxy.close()
    assert.ok(Date.now() - t0 < 200, 'close() waited out the latency')
    assert.equal(notes.length, 1, JSON.stringify(notes))
    await sleep(300)
    assert.equal(upstreamCalls, 0)
    assert.equal(notes.length, 1, JSON.stringify(notes))
    await up.close()
  })

  test('an upstream cut mid-stream destroys the client and records one note', async () => {
    const up = await sseUpstream((res) => void setTimeout(() => res.destroy(), 10))
    const notes = []
    const proxy = await startMcpProxy({ target: up.url, onNote: (n) => notes.push(n) })
    const client = await openSse(proxy.url)
    await client.ended
    await until(() => notes.length > 0)
    await sleep(30) // a second note would arrive here
    assert.equal(client.res.complete, false)
    assert.equal(notes.length, 1, JSON.stringify(notes))
    assert.deepEqual(Object.keys(notes[0]).sort(), ['detail', 'source', 'type'])
    assert.equal(notes[0].type, 'note')
    assert.equal(notes[0].source, 'mcp-proxy')
    assert.match(notes[0].detail, /terminated|other side closed/)
    await proxy.close()
    await up.close()
  })

  test('a client disconnect cancels the upstream stream and records one note', async () => {
    let upstreamClosed = false
    const up = await sseUpstream((res) => void res.once('close', () => (upstreamClosed = true)))
    const notes = []
    const proxy = await startMcpProxy({ target: up.url, onNote: (n) => notes.push(n) })
    const client = await openSse(proxy.url)
    client.req.destroy()
    await until(() => upstreamClosed && notes.length > 0)
    await sleep(30)
    assert.equal(notes.length, 1, JSON.stringify(notes))
    assert.equal(notes[0].source, 'mcp-proxy')
    assert.ok(notes[0].detail.length > 0)
    await proxy.close()
    await up.close()
  })

  test('close() with a stream still open ends it, and its note lands before close resolves', async () => {
    const up = await sseUpstream(() => {})
    const notes = []
    const proxy = await startMcpProxy({ target: up.url, onNote: (n) => notes.push(n) })
    await openSse(proxy.url)
    await proxy.close()
    assert.equal(notes.length, 1, JSON.stringify(notes))
    await up.close()
  })

  test('a throwing onNote does not escape', async () => {
    const up = await sseUpstream((res) => void setTimeout(() => res.destroy(), 10))
    let calls = 0
    const proxy = await startMcpProxy({
      target: up.url,
      onNote: () => {
        calls++
        throw new Error('disk full')
      },
    })
    const client = await openSse(proxy.url)
    await client.ended
    await until(() => calls > 0)
    await proxy.close()
    await up.close()
  })

  test('a stream that ends cleanly records nothing and arrives whole', async () => {
    const up = await sseUpstream((res) => res.end('data: bye\n\n'))
    const notes = []
    const proxy = await startMcpProxy({ target: up.url, onNote: (n) => notes.push(n) })
    const res = await fetch(`${proxy.url}/mcp`)
    assert.equal(await res.text(), 'data: hello\n\ndata: bye\n\n')
    await proxy.close()
    assert.deepEqual(notes, [])
    await up.close()
  })
})

describe('MCP proxy notes in an attempt', () => {
  const scenario = {
    name: 'unit',
    fixtures: { bindings: [{ channel: 'sl', sender_id: 'U0EVALOWNER' }] },
    inbound: { channel: 'sl', sender: 'U0EVALOWNER', chat: 'D0EVAL', text: 'hi' },
    faults: { slow_tool: { latencyMs: 40 } },
    expect: [{ called: 'channel_send' }, { 'task.status': 'done' }],
    fake: {
      script: [
        { tool: 'task_claim', args: { limit: 1, stale_minutes: 25 } },
        { tool: 'channel_send', args: { channel: '${task.channel}', chat_id: '${task.chat_id}', text: 'ok' } },
        { tool: 'task_complete', args: { id: '${task.id}', status: 'done', result: 'r' } },
      ],
    },
  }

  // The fake harness, plus a client that hangs up on a request the proxy is still holding.
  const hangingUpHarness = {
    ...fake,
    runOnce(o) {
      const { url } = JSON.parse(readFileSync(o.mcpConfig, 'utf8')).mcpServers.fermi
      const req = http.request(url, { method: 'POST', headers: { 'content-type': 'application/json' } })
      req.on('error', () => {})
      req.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'slow_tool' } }))
      setTimeout(() => req.destroy(), 10)
      const run = fake.runOnce(o)
      return { ...run, done: run.done.then(() => sleep(120)) }
    },
  }

  test('a stream failure lands in trace.jsonl as a note and the attempt still passes', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'mcp-proxy-'))
    const r = await runAttempt({ scenario, attempt: 1, harness: hangingUpHarness, timeoutMs: 10_000, outDir })
    assert.equal(r.pass, true, JSON.stringify(r.failed))
    assert.deepEqual(r.errorKinds, [])
    const trace = readFileSync(join(outDir, 'unit/1/trace.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    const notes = trace.filter((e) => e.type === 'note')
    assert.equal(notes.length, 1, JSON.stringify(notes))
    assert.equal(notes[0].source, 'mcp-proxy')
    assert.ok(notes[0].detail.length > 0)
    assert.ok(trace.some((e) => e.type === 'turn_end' && e.ok))
  })

  test('the fake harness alone leaves no note in the trace', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'mcp-proxy-'))
    const r = await runAttempt({ scenario, attempt: 1, harness: fake, timeoutMs: 10_000, outDir })
    assert.equal(r.pass, true, JSON.stringify(r.failed))
    assert.doesNotMatch(readFileSync(join(outDir, 'unit/1/trace.jsonl'), 'utf8'), /"note"/)
  })
})
