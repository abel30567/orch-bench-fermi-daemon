import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startMcpProxy } from '../evals/lib/mcp-proxy.mjs'
import { serve, sleep } from '../evals/lib/net.mjs'
import { runAttempt } from '../evals/lib/runner.mjs'
import * as fake from '../evals/harness/fake.mjs'

const SSE = { 'content-type': 'text/event-stream' }

// An upstream whose GET /mcp sends one SSE event, then does `then(res)`.
async function sseUpstream(then) {
  const seen = { closed: 0 }
  const server = await serve((req, res) => {
    res.writeHead(200, SSE)
    res.write('data: hello\n\n')
    res.on('close', () => seen.closed++)
    then(res)
  })
  return { ...server, seen }
}
const cut = (res) => setTimeout(() => res.socket.destroy(), 20)

// GET through the proxy; resolves to the first chunk and how the response ended.
function openStream(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      res.once('data', (chunk) => {
        const ended = new Promise((r) => {
          res.once('end', () => r('end'))
          res.once('error', () => r('error'))
          res.once('close', () => r('close'))
        })
        resolve({ req, res, first: String(chunk), ended })
      })
    })
    req.on('error', reject)
  })
}

async function until(cond) {
  for (let i = 0; i < 200 && !cond(); i++) await sleep(10)
}

describe('mcp proxy stream errors', () => {
  test('an upstream SSE cut is reported once, drops the client and leaves the proxy serving', async () => {
    const upstream = await sseUpstream(cut)
    const errors = []
    const proxy = await startMcpProxy({ target: upstream.url, onError: (e) => errors.push(e) })
    try {
      const { first, ended } = await openStream(`${proxy.url}/mcp`)
      assert.equal(first, 'data: hello\n\n')
      assert.notEqual(await ended, 'end') // cut, not a clean end of stream
      await until(() => errors.length)
      await sleep(30)
      assert.deepEqual(errors.map((e) => e.message), ['terminated'])
      assert.equal((await openStream(`${proxy.url}/mcp`)).first, 'data: hello\n\n')
    } finally {
      await proxy.close()
      await upstream.close()
    }
  })

  test('a client hanging up closes the upstream stream and is no error', async () => {
    const upstream = await sseUpstream(() => {})
    const errors = []
    const proxy = await startMcpProxy({ target: upstream.url, onError: (e) => errors.push(e) })
    try {
      const { req } = await openStream(`${proxy.url}/mcp`)
      req.destroy()
      await until(() => upstream.seen.closed)
      assert.equal(upstream.seen.closed, 1)
      await sleep(30)
      assert.deepEqual(errors, [])
    } finally {
      await proxy.close()
      await upstream.close()
    }
  })

  test('closing the proxy before the target, as the runner does, closes the upstream stream', async () => {
    const upstream = await sseUpstream(() => {})
    const proxy = await startMcpProxy({ target: upstream.url })
    await openStream(`${proxy.url}/mcp`)
    await proxy.close()
    await until(() => upstream.seen.closed)
    assert.equal(upstream.seen.closed, 1)
    await upstream.close()
  })

  test('a client gone before the upstream answers does not leak the upstream stream', async () => {
    let answer
    let closed = 0
    const upstream = await serve((req, res) => {
      answer = () => {
        res.writeHead(200, SSE)
        res.write('data: late\n\n')
      }
      res.on('close', () => closed++)
    })
    const errors = []
    const proxy = await startMcpProxy({ target: upstream.url, onError: (e) => errors.push(e) })
    try {
      const req = http.get(`${proxy.url}/mcp`)
      req.on('error', () => {})
      await until(() => answer)
      req.destroy()
      await sleep(30)
      answer()
      await until(() => closed)
      assert.equal(closed, 1)
      assert.deepEqual(errors, [])
    } finally {
      await proxy.close()
      await upstream.close()
    }
  })

  test('an unreachable target is still a 500 for the client, and is reported', async () => {
    const dead = await serve(() => {})
    await dead.close()
    const errors = []
    const proxy = await startMcpProxy({ target: dead.url, onError: (e) => errors.push(e) })
    try {
      assert.equal((await fetch(`${proxy.url}/mcp`)).status, 500)
      assert.equal(errors.length, 1)
    } finally {
      await proxy.close()
    }
  })

  test('a throwing onError does not escape', async () => {
    const upstream = await sseUpstream(cut)
    let calls = 0
    const proxy = await startMcpProxy({
      target: upstream.url,
      onError: () => {
        calls++
        throw new Error('sink failed')
      },
    })
    try {
      await openStream(`${proxy.url}/mcp`)
      await until(() => calls)
      await sleep(30)
      assert.equal(calls, 1)
    } finally {
      await proxy.close()
      await upstream.close()
    }
  })
})

describe('runner', () => {
  // The first real run: the turn completes over a long-lived GET /mcp that the target cuts.
  const script = [{ tool: 'task_claim', args: { limit: 1, stale_minutes: 25 } }]
  const harness = {
    runOnce(opts) {
      const { url } = JSON.parse(readFileSync(opts.mcpConfig, 'utf8')).mcpServers.fermi
      const run = fake.runOnce({ ...opts, script })
      const done = openStream(url)
        .then(({ ended }) => ended)
        .then(() => sleep(50))
        .then(() => run.done)
      return { ...run, done }
    },
  }

  test('an upstream cut mid-run becomes one non-fatal trace note', async () => {
    const upstream = await sseUpstream(cut)
    const realFetch = globalThis.fetch
    // The fake target has no SSE stream: send the proxy's GET to the upstream that cuts it.
    globalThis.fetch = (url, init) => (init?.method === 'GET' && String(url).endsWith('/mcp') ? realFetch(`${upstream.url}/mcp`, init) : realFetch(url, init))
    const outDir = mkdtempSync(join(tmpdir(), 'mcp-proxy-'))
    try {
      const scenario = {
        name: 'cut',
        fixtures: { bindings: [{ channel: 'sl', sender_id: 'U0EVALOWNER' }] },
        inbound: { channel: 'sl', sender: 'U0EVALOWNER', chat: 'D0EVAL', text: 'hi' },
        expect: [{ called: 'task_claim' }],
      }
      const result = await runAttempt({ scenario, attempt: 1, harness, timeoutMs: 10_000, outDir })
      assert.deepEqual(result.failed, [])
      assert.equal(result.pass, true)
      assert.deepEqual(result.errorKinds, [])
      const trace = readFileSync(join(outDir, 'cut/1/trace.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
      assert.deepEqual(trace.filter((e) => e.type === 'note'), [{ type: 'note', source: 'mcp-proxy', detail: 'terminated' }])
    } finally {
      globalThis.fetch = realFetch
      await upstream.close()
    }
  })
})
