// Runs warm-worker.mjs against test/fixtures/fake-claude.mjs and a local fake
// Fermi server, in a throwaway HOME (HOME/fermi-daemon holds .env, prompts/ and
// runs/). Nothing leaves localhost and the reserved control port is never bound
// (WARM_CONTROL_PORT=0).
//
//   runWorker({ result, pending, prompt?, overlay?, env?, until?, durationMs, timeoutMs? })
//     → { log, events, home, daemon, code }
//
// result   the result event the fake answers drain turns with
// pending  what GET /admin/tasks/pending reports (a number, or a function called per request)
// until    ({ daemon, events }) => boolean, polled; the worker is stopped as soon
//          as it holds. Without it the worker runs for durationMs. With it,
//          durationMs is ignored and timeoutMs (default 20s) is the upper bound;
//          on timeout the result has timedOut: true.
// events   $FAKE_DIR/turns.log as parsed JSON lines (spawn/turn/control records)
import { spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const FAKE = join(ROOT, 'test/fixtures/fake-claude.mjs')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export function readEvents(dir) {
  const f = join(dir, 'turns.log')
  if (!existsSync(f)) return []
  return readFileSync(f, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l))
}

export async function runWorker({ result, pending = 0, prompt, overlay, env = {}, until, durationMs = 1500, timeoutMs = 20000 }) {
  const home = mkdtempSync(join(tmpdir(), 'warm-worker-'))
  const daemon = join(home, 'fermi-daemon')
  const fakeDir = join(home, 'fake')
  for (const d of [daemon, join(daemon, 'prompts'), join(daemon, 'runs'), fakeDir]) mkdirSync(d, { recursive: true })
  writeFileSync(join(fakeDir, 'turns.log'), '')
  writeFileSync(join(fakeDir, 'result.json'), JSON.stringify(result))
  writeFileSync(join(daemon, 'prompts/drain.md'), prompt ?? 'Drain the queue.\n')
  if (overlay) writeFileSync(join(daemon, 'prompts/local.json'), JSON.stringify(overlay))

  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    if (req.url === '/admin/tasks/pending') return res.end(JSON.stringify({ pending: typeof pending === 'function' ? pending() : pending }))
    res.end('{}')
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  writeFileSync(join(daemon, '.env'), `FERMI_URL=http://127.0.0.1:${server.address().port}\nFERMI_BEARER_TOKEN=test-token\n`)

  const bin = join(home, 'claude')
  writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${FAKE}" "$@"\n`)
  chmodSync(bin, 0o755)

  const child = spawn(process.execPath, [join(ROOT, 'warm-worker.mjs')], {
    cwd: ROOT,
    env: {
      ...process.env,
      HOME: home,
      HARNESS: 'claude-code',
      CLAUDE_BIN: bin,
      FAKE_DIR: fakeDir,
      FAKE_RESULT: join(fakeDir, 'result.json'),
      WARM_CONTROL_PORT: '0',
      WARM_POLL_MS: '50',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let log = ''
  child.stdout.on('data', (d) => (log += d))
  child.stderr.on('data', (d) => (log += d))
  let code = null
  const exited = new Promise((r) => child.on('close', (c) => r((code = c))))

  let timedOut = false
  if (until) {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      if (code != null) break
      let ok = false
      try {
        ok = until({ daemon, events: readEvents(fakeDir) })
      } catch {}
      if (ok) break
      if (Date.now() > deadline) {
        timedOut = true
        break
      }
      await sleep(25)
    }
  } else {
    await Promise.race([exited, sleep(durationMs)])
  }
  if (code == null) child.kill('SIGTERM')
  await exited
  await new Promise((r) => server.close(r))
  return { log, events: readEvents(fakeDir), home, daemon, code, timedOut }
}
