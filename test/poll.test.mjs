import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, chmodSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ROOT } from './run-worker.mjs'

const POLL = join(ROOT, 'poll.sh')
const NEED = 'bin/run-once.mjs needs node >= 22 (set NODE_BIN in .env)'

const script = (path, body) => {
  writeFileSync(path, `#!/bin/sh\n${body}\n`)
  chmodSync(path, 0o755)
}
// A fake node that reports `version` and records how it was spawned.
const fakeNode = (path, version) =>
  script(path, `if [ "$1" = --version ]; then echo ${version}; exit 0; fi\necho "$@" >>"$HOME/node.argv"`)

// Runs the real poll.sh in a throwaway HOME (~/fermi-daemon) with the warm
// worker down (fake pgrep), a fake Fermi pending count (fake curl) and a fake
// narrator python3. PATH is fakebin + system dirs only, so `node` on PATH is
// whatever setup() puts in fakebin. `env(home)` returns extra .env lines.
function runPoll({ env = () => '', pending = 0, setup } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'poll-'))
  const daemon = join(home, 'fermi-daemon')
  const fakebin = join(home, 'fakebin')
  mkdirSync(join(daemon, 'prompts'), { recursive: true })
  mkdirSync(fakebin)
  writeFileSync(join(daemon, '.env'), `FERMI_URL=http://127.0.0.1:9\nFERMI_BEARER_TOKEN=test\n${env(home)}`)
  script(join(fakebin, 'pgrep'), 'exit 1')
  script(join(fakebin, 'curl'), pending ? `echo '{"pending":${pending}}'` : 'exit 7')
  script(join(fakebin, 'python3'), 'echo "$@" >>"$HOME/python3.argv"')
  setup?.({ home, daemon, fakebin })
  const r = spawnSync('zsh', [POLL], {
    env: { HOME: home, PATH: `${fakebin}:/usr/bin:/bin:/usr/sbin:/sbin` },
    encoding: 'utf8',
  })
  const read = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : '')
  return {
    home,
    daemon,
    code: r.status,
    pollLog: read(join(daemon, 'logs/poll.log')),
    lanes: readdirSync(join(daemon, 'lanes')),
    runs: readdirSync(join(daemon, 'runs')),
    nodeArgv: read(join(home, 'node.argv')),
    python3Argv: read(join(home, 'python3.argv')),
  }
}

const errorLines = (log) => log.split('\n').filter((l) => l.includes('ERROR:'))

async function waitFor(fn, ms = 5000) {
  for (const t0 = Date.now(); ; ) {
    const v = fn()
    if (v) return v
    if (Date.now() - t0 > ms) return v
    await new Promise((res) => setTimeout(res, 20))
  }
}

describe('AC1: node too old or missing fails loudly, no spawn', () => {
  test('node v14 on PATH: one ERROR line in poll.log, non-zero exit, no lane/narrator/run', () => {
    const r = runPoll({ pending: 2, setup: ({ fakebin }) => fakeNode(join(fakebin, 'node'), 'v14.21.3') })
    assert.notEqual(r.code, 0)
    const errs = errorLines(r.pollLog)
    assert.equal(errs.length, 1, r.pollLog)
    assert.ok(
      errs[0].endsWith(` ERROR: node '${join(r.home, 'fakebin/node')}' is v14.21.3; ${NEED} — not spawning drain.md`),
      errs[0],
    )
    assert.deepEqual(r.lanes, [])
    assert.deepEqual(r.runs, [])
    assert.equal(r.nodeArgv, '')
    assert.equal(r.python3Argv, '', 'no narrator')
    assert.doesNotMatch(r.pollLog, /spawned/)
  })

  test('NODE_BIN v14 on the heartbeat path: ERROR names heartbeat.md, no lane, no heartbeat stamp', () => {
    const r = runPoll({
      env: (home) => `NODE_BIN="${join(home, 'node14')}"\n`,
      setup: ({ home }) => fakeNode(join(home, 'node14'), 'v14.0.0'),
    })
    assert.notEqual(r.code, 0)
    assert.deepEqual(errorLines(r.pollLog).map((l) => l.replace(/^\S+ \S+ /, '')), [
      `ERROR: node '${join(r.home, 'node14')}' is v14.0.0; ${NEED} — not spawning heartbeat.md`,
    ])
    assert.deepEqual(r.lanes, [])
    assert.ok(!existsSync(join(r.daemon, 'last-heartbeat')))
  })

  test('NODE_BIN that does not exist: ERROR line, non-zero exit, no lane', () => {
    const r = runPoll({ env: () => 'NODE_BIN=/nonexistent/node\n' })
    assert.notEqual(r.code, 0)
    assert.deepEqual(errorLines(r.pollLog).map((l) => l.replace(/^\S+ \S+ /, '')), [
      `ERROR: node '/nonexistent/node' not found; ${NEED} — not spawning heartbeat.md`,
    ])
    assert.deepEqual(r.lanes, [])
  })
})

describe('AC2: NODE_BIN is honoured', () => {
  test('NODE_BIN (v22) wins over a v14 node on PATH and is the node that runs run-once', async () => {
    const r = runPoll({
      env: (home) => `NODE_BIN="${join(home, 'node22')}"\n`,
      setup: ({ home, fakebin }) => {
        fakeNode(join(fakebin, 'node'), 'v14.21.3')
        fakeNode(join(home, 'node22'), 'v22.3.0')
      },
    })
    assert.equal(r.code, 0, r.pollLog)
    assert.equal(errorLines(r.pollLog).length, 0, r.pollLog)
    assert.match(r.pollLog, /spawned heartbeat\.md in lane 1/)
    const argv = await waitFor(() => existsSync(join(r.home, 'node.argv')) && readFileSync(join(r.home, 'node.argv'), 'utf8'))
    assert.ok(argv, 'NODE_BIN was spawned')
    assert.ok(argv.startsWith(`${join(r.daemon, 'bin/run-once.mjs')} --prompt prompts/heartbeat.md --log runs/`), argv)
  })

  test('without NODE_BIN, a v22 node on PATH is used', async () => {
    const r = runPoll({ setup: ({ fakebin }) => fakeNode(join(fakebin, 'node'), 'v22.0.0') })
    assert.equal(r.code, 0, r.pollLog)
    assert.match(r.pollLog, /spawned heartbeat\.md/)
    assert.ok(await waitFor(() => existsSync(join(r.home, 'node.argv'))))
  })
})

describe('AC3: run-once output goes to the run log', () => {
  test('a crashing run-once leaves its error in runs/<ts>.log', async () => {
    const r = runPoll({
      env: () => `NODE_BIN="${process.execPath}"\n`,
      // The real bin/run-once.mjs, but prompts/heartbeat.md is missing: it crashes.
      setup: ({ daemon }) => symlinkSync(join(ROOT, 'bin'), join(daemon, 'bin')),
    })
    assert.equal(r.code, 0, r.pollLog)
    const ts = r.pollLog.match(/spawned heartbeat\.md .*log runs\/(\S+)\.log\)/)?.[1]
    assert.ok(ts, r.pollLog)
    const logFile = join(r.daemon, `runs/${ts}.log`)
    const log = await waitFor(() => {
      const s = existsSync(logFile) && readFileSync(logFile, 'utf8')
      return s && /ENOENT/.test(s) && s
    })
    assert.match(log || '', /ENOENT.*prompts\/heartbeat\.md/)
    assert.ok(await waitFor(() => !existsSync(join(r.daemon, 'lanes/1'))), 'lane freed')
  })
})
