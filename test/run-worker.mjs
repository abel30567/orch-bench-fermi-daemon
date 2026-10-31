// Test helper: run warm-worker.mjs against test/fixtures/fake-claude.mjs and a
// fake Fermi server, in a throwaway $HOME/fermi-daemon.
//
//   runWorker({ result, pending, durationMs?, until?, timeoutMs?, prompt?, overlay?, errors?, stream?, claim?, env? })
//     → { log, events, daemon }
//
// result    the result event a drain turn answers with (FAKE_RESULT)
// pending   what GET /admin/tasks/pending reports
// until     (daemon) => boolean, polled; the worker is stopped once it holds.
//           Rejects if it doesn't hold within timeoutMs (default 15s).
// durationMs without `until`: stop the worker after this long (or when it exits)
// prompt    prompts/drain.md text (default: the repo's drain.md + the example overlay)
// overlay   prompts/local.json contents (omitted: no local.json, unless prompt is defaulted)
// log       the worker's stdout + stderr; events: $FAKE_DIR/turns.log as objects
import { spawn } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const FAKE = join(ROOT, 'test/fixtures/fake-claude.mjs')

export async function runWorker(o) {
  const home = mkdtempSync(join(tmpdir(), 'warm-worker-'))
  const daemon = join(home, 'fermi-daemon')
  const fakeDir = join(home, 'fake')
  for (const d of [join(daemon, 'prompts'), join(daemon, 'runs'), fakeDir]) mkdirSync(d, { recursive: true })
  writeFileSync(join(fakeDir, 'turns.log'), '')

  const prompt = o.prompt ?? readFileSync(join(ROOT, 'prompts/drain.md'), 'utf8')
  const overlay = o.overlay ?? (o.prompt == null ? JSON.parse(readFileSync(join(ROOT, 'prompts/local.example.json'), 'utf8')) : null)
  writeFileSync(join(daemon, 'prompts/drain.md'), prompt)
  if (overlay) writeFileSync(join(daemon, 'prompts/local.json'), JSON.stringify(overlay))

  const resultFile = join(fakeDir, 'result.json')
  writeFileSync(resultFile, JSON.stringify(o.result))
  const bin = join(fakeDir, 'claude')
  writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${FAKE}" "$@"\n`)
  chmodSync(bin, 0o755)

  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    if (req.url === '/admin/tasks/pending') return res.end(JSON.stringify({ pending: o.pending }))
    res.end('{}')
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  writeFileSync(join(daemon, '.env'), `FERMI_URL=http://127.0.0.1:${server.address().port}\nFERMI_BEARER_TOKEN=test\n`)

  const env = {
    ...process.env,
    HOME: home,
    CLAUDE_BIN: bin,
    FAKE_DIR: fakeDir,
    FAKE_RESULT: resultFile,
    WARM_POLL_MS: '50',
    WARM_CONTROL_PORT: '0',
    ...(o.errors != null && { FAKE_ERRORS: String(o.errors) }),
    ...(o.stream && { FAKE_STREAM: o.stream }),
    ...(o.claim && { FAKE_CLAIM: '1' }),
    ...o.env,
  }
  delete env.HARNESS
  const child = spawn(process.execPath, [join(ROOT, 'warm-worker.mjs')], { cwd: daemon, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let log = ''
  child.stdout.on('data', (d) => (log += d))
  child.stderr.on('data', (d) => (log += d))
  const exited = new Promise((r) => child.on('close', r))

  let failure = null
  try {
    if (o.until) {
      const deadline = Date.now() + (o.timeoutMs ?? 15000)
      let ok = false
      for (;;) {
        try {
          ok = o.until(daemon)
        } catch {}
        if (ok || child.exitCode != null || Date.now() > deadline) break
        await new Promise((r) => setTimeout(r, 25))
      }
      if (!ok) failure = new Error(`runWorker: condition not met within ${o.timeoutMs ?? 15000}ms\n${log}`)
    } else {
      await Promise.race([exited, new Promise((r) => setTimeout(r, o.durationMs))])
    }
  } finally {
    if (child.exitCode == null) child.kill('SIGTERM')
    await exited
    server.close()
  }
  if (failure) throw failure

  const turns = join(fakeDir, 'turns.log')
  const events = existsSync(turns)
    ? readFileSync(turns, 'utf8')
        .split('\n')
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l))
    : []
  return { log, events, daemon }
}
