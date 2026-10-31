// Runs warm-worker.mjs against test/fixtures/fake-claude.mjs and a fake Fermi
// server, in a throwaway HOME (~/fermi-daemon with .env, prompts/, runs/).
//
//   runWorker({ result, pending, durationMs, prompt, overlay, env, until })
//     → { log, events, daemon, timedOut }
//
// result     the result event the fake claude answers turns with (see fake-claude.mjs)
// pending    what GET /admin/tasks/pending reports on its first call (0 after)
// durationMs upper bound on the run; the worker is SIGTERMed then
// prompt     prompts/drain.md; overlay → prompts/local.json (omitted: no file)
// until      (daemon) => boolean, polled while the worker runs; true stops it early.
//            Wait on this, not on time, when a test needs some file state.
// log        the worker's stdout + stderr
// events     the fake claude's turns.log records (spawn, turn, control)
// timedOut   `until` was given and never held within durationMs
import { spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const FAKE_CLAUDE = join(ROOT, 'test/fixtures/fake-claude.mjs')
const POLL_UNTIL_MS = 25

export async function runWorker({ result, pending = 0, durationMs = 1500, prompt = 'Drain worker.\n', overlay, env = {}, until } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'warm-worker-'))
  const daemon = join(home, 'fermi-daemon')
  const fake = join(home, 'fake')
  for (const d of ['prompts', 'runs']) mkdirSync(join(daemon, d), { recursive: true })
  mkdirSync(fake)
  writeFileSync(join(daemon, 'prompts/drain.md'), prompt)
  if (overlay) writeFileSync(join(daemon, 'prompts/local.json'), JSON.stringify(overlay))
  writeFileSync(join(fake, 'result.json'), JSON.stringify(result))
  const bin = join(fake, 'claude')
  writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${FAKE_CLAUDE}" "$@"\n`)
  chmodSync(bin, 0o755)

  let left = pending
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    if (req.url === '/admin/tasks/pending') {
      res.end(JSON.stringify({ pending: left }))
      left = 0
    } else res.end('{}')
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  writeFileSync(join(daemon, '.env'), `FERMI_URL=http://127.0.0.1:${server.address().port}\nFERMI_BEARER_TOKEN=test\n`)

  const { HARNESS, ...parentEnv } = process.env
  const child = spawn(process.execPath, [join(ROOT, 'warm-worker.mjs')], {
    cwd: daemon,
    env: {
      ...parentEnv,
      HOME: home,
      CLAUDE_BIN: bin,
      FAKE_DIR: fake,
      FAKE_RESULT: join(fake, 'result.json'),
      WARM_POLL_MS: '50',
      WARM_CONTROL_PORT: '0',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let log = ''
  child.stdout.on('data', (d) => (log += d))
  child.stderr.on('data', (d) => (log += d))
  const exited = new Promise((r) => child.on('close', r))

  let stop
  const stopped = new Promise((r) => (stop = r))
  const deadline = setTimeout(() => stop(false), durationMs)
  const poll =
    until &&
    setInterval(() => {
      try {
        if (until(daemon)) stop(true)
      } catch {}
    }, POLL_UNTIL_MS)
  const held = await Promise.race([stopped, exited.then(() => false)])
  clearTimeout(deadline)
  clearInterval(poll)
  if (child.exitCode == null && child.signalCode == null) child.kill('SIGTERM')
  await exited
  server.close()

  const turns = join(fake, 'turns.log')
  const events = existsSync(turns)
    ? readFileSync(turns, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : []
  return { log, events, daemon, timedOut: Boolean(until) && !held }
}
