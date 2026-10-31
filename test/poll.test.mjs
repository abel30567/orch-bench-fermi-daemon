// poll.sh's cold path end to end: the real script in a temp $HOME, with a PATH
// holding only the tools it needs, a stubbed queue (curl), no warm worker (pgrep,
// which would otherwise see the warm workers other test files spawn), a stubbed
// narrator (python3) and fake node binaries.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { ROOT } from './run-worker.mjs'

const TOOLS = ['cat', 'date', 'find', 'grep', 'kill', 'ls', 'mkdir', 'nohup', 'pkill', 'rm', 'seq', 'sleep', 'stat', 'touch', 'tr', 'wc']
const which = (bin) => process.env.PATH.split(delimiter).map((d) => join(d, bin)).find(existsSync)
const ZSH = which('zsh')

const script = (path, body) => {
  writeFileSync(path, `#!/bin/sh\n${body}\n`)
  chmodSync(path, 0o755)
  return path
}
// Prints `lines` for --version, logs every other call, and hands it to the real node.
const printingNode = (path, lines, calls) =>
  script(path, `[ "$1" = --version ] && { ${lines.map((l) => `echo '${l}';`).join(' ')} exit 0; }\necho "$0 $*" >>"${calls}"\nexec "${process.execPath}" "$@"`)
const fakeNode = (path, version, calls) => printingNode(path, [`v${version}`], calls)
// The same, with the line a version-manager shim prints before the version.
const shimNode = (path, version, calls) => printingNode(path, ['Now using node', `v${version}`], calls)

const until = async (cond, ms = 5000) => {
  for (const t0 = Date.now(); !cond(); ) {
    if (Date.now() - t0 > ms) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 20))
  }
}

// A daemon home without logs/ or runs/, as after a fresh clone. `env` is .env.
const daemon = ({ pending = 1, env = '' } = {}) => {
  const home = mkdtempSync(join(tmpdir(), 'poll-'))
  const dir = join(home, 'fermi-daemon')
  const bin = join(home, 'path-bin')
  mkdirSync(dir)
  mkdirSync(bin)
  for (const tool of TOOLS) symlinkSync(which(tool), join(bin, tool))
  script(join(bin, 'pgrep'), 'exit 1')
  script(join(bin, 'curl'), `echo '{"pending":${pending}}'`)
  script(join(bin, 'python3'), `echo "$*" >>"${home}/narrator.calls"`)
  writeFileSync(join(dir, '.env'), `FERMI_URL=http://fermi.invalid\nFERMI_BEARER_TOKEN=test\n${env}\n`)
  return { home, dir, bin, calls: join(home, 'node.calls') }
}
const poll = ({ home, bin }, extra = {}) =>
  spawnSync(ZSH, [join(ROOT, 'poll.sh')], {
    env: { HOME: home, PATH: bin, MAX_CONCURRENT: '3', ...extra },
    encoding: 'utf8',
    timeout: 20_000,
  })
const pollLog = ({ dir }) => readFileSync(join(dir, 'logs/poll.log'), 'utf8')
const errorLine = (node, version, prompt) =>
  `ERROR: node '${node}' is v${version}; bin/run-once.mjs needs node >= 22 (set NODE_BIN in .env) — not spawning ${prompt}`
const assertNoSpawn = (d) => {
  assert.deepEqual(readdirSync(join(d.dir, 'lanes')), [])
  assert.deepEqual(readdirSync(join(d.dir, 'runs')), [])
  assert.equal(existsSync(d.calls), false, 'run-once must not start')
  assert.equal(existsSync(join(d.home, 'narrator.calls')), false, 'narrator must not start')
}
const assertRefused = (d, r, line) => {
  assert.notEqual(r.status, 0, r.stderr)
  const errors = pollLog(d).split('\n').filter((l) => l.includes('ERROR'))
  assert.equal(errors.length, 1, pollLog(d))
  assert.equal(errors[0].replace(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d /, ''), line)
  assertNoSpawn(d)
}

describe('AC1: a node that is too old or missing is refused loudly, with no spawn', () => {
  test('v14 on PATH: the error line, one only, for three pending tasks', () => {
    const d = daemon({ pending: 3 })
    const node = fakeNode(join(d.bin, 'node'), '14.21.3', d.calls)
    assertRefused(d, poll(d), errorLine(node, '14.21.3', 'drain.md'))
  })

  test('v21, the last refused major', () => {
    const d = daemon()
    const node = fakeNode(join(d.bin, 'node'), '21.7.3', d.calls)
    assertRefused(d, poll(d), errorLine(node, '21.7.3', 'drain.md'))
  })

  test('the heartbeat is refused too and stays due for the next poll', () => {
    const d = daemon({ pending: 0 })
    const node = fakeNode(join(d.bin, 'node'), '14.21.3', d.calls)
    assertRefused(d, poll(d), errorLine(node, '14.21.3', 'heartbeat.md'))
    assert.equal(existsSync(join(d.dir, 'last-heartbeat')), false)
  })

  test('no node on PATH', () => {
    const d = daemon()
    assertRefused(d, poll(d), errorLine('node', 'unknown', 'drain.md'))
  })

  test('NODE_BIN pointing at nothing', () => {
    const d = daemon({ env: 'NODE_BIN=/nonexistent/node' })
    assertRefused(d, poll(d), errorLine('/nonexistent/node', 'unknown', 'drain.md'))
  })

  test('a shim preamble before a too-old version: still one error line', () => {
    const d = daemon()
    const node = shimNode(join(d.bin, 'node'), '14.21.3', d.calls)
    assertRefused(d, poll(d), errorLine(node, '14.21.3', 'drain.md'))
  })

  test('a good version after a too-old one does not hide it', () => {
    const d = daemon()
    const node = printingNode(join(d.bin, 'node'), ['v14.1.0', 'v22.1.0'], d.calls)
    assertRefused(d, poll(d), errorLine(node, '14.1.0', 'drain.md'))
  })

  test('output with no version in it is unknown, not quoted back', () => {
    const d = daemon()
    const node = printingNode(join(d.bin, 'node'), ['Now using node', 'done'], d.calls)
    assertRefused(d, poll(d), errorLine(node, 'unknown', 'drain.md'))
  })

  test('nothing to do: no node check and a clean exit', () => {
    const d = daemon({ pending: 0 })
    writeFileSync(join(d.dir, 'last-heartbeat'), '')
    const r = poll(d, { HEARTBEAT_SECONDS: '999999999' })
    assert.equal(r.status, 0, r.stderr)
    assert.equal(existsSync(join(d.dir, 'logs/poll.log')), false)
  })
})

describe('AC2: NODE_BIN is honoured', () => {
  const stubRun = (d) => {
    mkdirSync(join(d.dir, 'bin'))
    writeFileSync(join(d.dir, 'bin/run-once.mjs'), '')
  }

  test('from .env, it runs run-once and beats a too-old node on PATH', async () => {
    const custom = join(mkdtempSync(join(tmpdir(), 'poll-node-')), 'node22')
    const d = daemon({ env: `NODE_BIN=${custom}` })
    fakeNode(custom, '22.0.0', d.calls)
    fakeNode(join(d.bin, 'node'), '14.21.3', join(d.home, 'path-node.calls'))
    stubRun(d)
    const r = poll(d)
    assert.equal(r.status, 0, r.stderr)
    await until(() => existsSync(d.calls))
    const call = readFileSync(d.calls, 'utf8')
    assert.ok(call.startsWith(`${custom} ${d.dir}/bin/run-once.mjs --prompt prompts/drain.md --log runs/`), call)
    assert.equal(existsSync(join(d.home, 'path-node.calls')), false)
    assert.doesNotMatch(pollLog(d), /ERROR/)
    await until(() => existsSync(join(d.home, 'narrator.calls')))
  })

  test('a too-old NODE_BIN is refused even with a good node on PATH', () => {
    const custom = join(mkdtempSync(join(tmpdir(), 'poll-node-')), 'node14')
    const d = daemon({ env: `NODE_BIN=${custom}` })
    fakeNode(custom, '14.21.3', d.calls)
    fakeNode(join(d.bin, 'node'), '22.1.0', d.calls)
    assertRefused(d, poll(d), errorLine(custom, '14.21.3', 'drain.md'))
  })

  test('empty NODE_BIN (the .env.example default) falls back to PATH; a three-digit major passes', async () => {
    const d = daemon({ env: 'NODE_BIN=' })
    const node = fakeNode(join(d.bin, 'node'), '100.0.0', d.calls)
    stubRun(d)
    assert.equal(poll(d).status, 0)
    await until(() => existsSync(d.calls))
    assert.ok(readFileSync(d.calls, 'utf8').startsWith(`${node} `))
  })

  test('a shim preamble before a good version does not refuse a usable node', async () => {
    const d = daemon()
    const node = shimNode(join(d.bin, 'node'), '22.1.0', d.calls)
    stubRun(d)
    const r = poll(d)
    assert.equal(r.status, 0, r.stderr)
    await until(() => existsSync(d.calls))
    assert.ok(readFileSync(d.calls, 'utf8').startsWith(`${node} `))
    assert.doesNotMatch(pollLog(d), /ERROR/)
  })

  test('text after a good version does not refuse a usable node', async () => {
    const d = daemon()
    const node = printingNode(join(d.bin, 'node'), ['v22.1.0', 'done'], d.calls)
    stubRun(d)
    const r = poll(d)
    assert.equal(r.status, 0, r.stderr)
    await until(() => existsSync(d.calls))
    assert.ok(readFileSync(d.calls, 'utf8').startsWith(`${node} `))
    assert.doesNotMatch(pollLog(d), /ERROR/)
  })

  test('.env.example documents it, empty once sourced', () => {
    assert.match(readFileSync(join(ROOT, '.env.example'), 'utf8'), /^NODE_BIN=\s+# .*>= 22/m)
    const r = spawnSync(ZSH, ['-c', 'source ./.env.example && print -r -- "[$NODE_BIN]"'], { cwd: ROOT, encoding: 'utf8' })
    assert.equal(r.stdout, '[]\n', r.stderr)
  })
})

describe('AC3: run-once output lands in runs/<ts>.log', () => {
  const runLog = (d) => {
    const logs = readdirSync(join(d.dir, 'runs'))
    assert.equal(logs.length, 1, String(logs))
    return readFileSync(join(d.dir, 'runs', logs[0]), 'utf8')
  }

  // The real run-once, crashing on its prompt read, before any harness spawn.
  test('the real run-once crashing leaves its error there and frees the lane', async () => {
    const d = daemon()
    fakeNode(join(d.bin, 'node'), '22.1.0', d.calls)
    for (const dir of ['bin', 'harness', 'lib']) symlinkSync(join(ROOT, dir), join(d.dir, dir))
    assert.equal(poll(d).status, 0)
    await until(() => /ENOENT[^]*prompts\/drain\.md/.test(runLog(d)) && !existsSync(join(d.dir, 'lanes/1')))
  })

  test('crash output appends to what run-once wrote itself; stdout is kept too', async () => {
    const d = daemon()
    fakeNode(join(d.bin, 'node'), '22.1.0', d.calls)
    mkdirSync(join(d.dir, 'bin'))
    writeFileSync(
      join(d.dir, 'bin/run-once.mjs'),
      `import { appendFileSync } from 'node:fs'
const log = process.argv[process.argv.indexOf('--log') + 1]
appendFileSync(log, 'run-once: harness pid 1\\n')
console.log('from stdout')
throw new Error('boom from run-once')
`,
    )
    assert.equal(poll(d).status, 0)
    await until(() => /boom from run-once/.test(runLog(d)))
    const text = runLog(d)
    assert.match(text, /^run-once: harness pid 1\n/)
    assert.match(text, /from stdout\n/)
  })
})
