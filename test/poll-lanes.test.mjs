// poll.sh lane accounting: the real script under zsh, with HOME pointed at a temp
// dir and curl, pgrep, node and python3 faked on PATH. `live` is only visible
// through what it drives, so tests read the "spawning N" log line, which is
// min(pending, MAX_CONCURRENT - live).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ROOT } from './run-worker.mjs'

const POLL = join(ROOT, 'poll.sh')

const FAKES = {
  curl: '#!/bin/sh\nprintf \'{"pending":%s}\' "$FAKE_PENDING"\n',
  pgrep: '#!/bin/sh\nexit 1\n', // warm worker is down
  python3: '#!/bin/sh\nexit 0\n', // narrator
  node: `#!/bin/sh
[ "$1" = "-v" ] && { echo v22.0.0; exit 0; }
echo "$*" >"$FAKE_SPAWNS/$$.tmp" && mv "$FAKE_SPAWNS/$$.tmp" "$FAKE_SPAWNS/$$"
`,
}
// poll.sh uses BSD stat (see PORTING.md); CI runs on Linux.
if (process.platform === 'linux') FAKES.stat = '#!/bin/sh\n[ "$1" = "-f" ] && shift 2\nexec /usr/bin/stat -c %Y "$@"\n'

function makeDaemon(t) {
  const home = mkdtempSync(join(tmpdir(), 'poll-lanes-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const root = join(home, 'fermi-daemon')
  const bin = join(home, 'fake-bin')
  const spawns = join(home, 'spawns')
  for (const dir of [join(root, 'logs'), join(root, 'runs'), bin, spawns]) mkdirSync(dir, { recursive: true })
  for (const [name, body] of Object.entries(FAKES)) {
    writeFileSync(join(bin, name), body)
    chmodSync(join(bin, name), 0o755)
  }
  writeFileSync(join(root, '.env'), 'FERMI_URL=http://fermi.invalid\nFERMI_BEARER_TOKEN=test-token\n')
  return { home, root, bin, spawns, lanes: join(root, 'lanes') }
}

function poll(d, { pending = 100, maxConcurrent = 5, maxRunSeconds = 1200 } = {}) {
  const r = spawnSync('zsh', [POLL], {
    encoding: 'utf8',
    timeout: 30_000,
    env: {
      PATH: `${d.bin}:${process.env.PATH}`,
      HOME: d.home,
      FAKE_PENDING: String(pending),
      FAKE_SPAWNS: d.spawns,
      MAX_CONCURRENT: String(maxConcurrent),
      MAX_RUN_SECONDS: String(maxRunSeconds),
    },
  })
  assert.equal(r.status, 0, `poll.sh failed: ${r.stderr}`)
  const logPath = join(d.root, 'logs', 'poll.log')
  const log = existsSync(logPath) ? readFileSync(logPath, 'utf8') : ''
  const m = log.match(/spawning (\d+)/)
  return { log, spawning: m ? Number(m[1]) : 0 }
}

function liveProcess(t) {
  const child = spawn('sleep', ['300'], { stdio: 'ignore' })
  t.after(() => child.kill('SIGKILL'))
  return child.pid
}

const deadPid = () => spawnSync('true').pid

function hourOld(path) {
  const then = new Date(Date.now() - 3_600_000)
  utimesSync(path, then, then)
}

function addLane(d, name, pid) {
  const lane = join(d.lanes, name)
  mkdirSync(lane, { recursive: true })
  if (pid !== undefined) writeFileSync(join(lane, 'pid'), `${pid}\n`)
  return lane
}

const lanePid = (lane) => readFileSync(join(lane, 'pid'), 'utf8').trim()

// The detached fake node can outlive poll.sh by a moment.
async function waitForSpawns(d, count) {
  for (let i = 0; i < 500; i++) {
    const done = readdirSync(d.spawns).filter((f) => !f.endsWith('.tmp'))
    if (done.length >= count) return done.map((f) => readFileSync(join(d.spawns, f), 'utf8'))
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.fail(`expected ${count} spawn(s), saw ${readdirSync(d.spawns).length}`)
}

test('empty lanes/ counts 0 live, so MAX_CONCURRENT=1 spawns a drain lane', async (t) => {
  const d = makeDaemon(t)
  mkdirSync(d.lanes)
  const { log, spawning } = poll(d, { maxConcurrent: 1 })
  assert.equal(spawning, 1, log)
  const [args] = await waitForSpawns(d, 1)
  assert.ok(args.includes('--prompt prompts/drain.md'), args)
  assert.ok(args.includes(`--lane ${join(d.lanes, '1')} `), args)
  assert.ok(existsSync(join(d.lanes, '1', 'pid')))
})

test('lanes/ that does not exist yet counts 0 live', async (t) => {
  const d = makeDaemon(t)
  assert.equal(poll(d, { maxConcurrent: 1 }).spawning, 1)
  await waitForSpawns(d, 1)
})

test('empty lanes/ lets the heartbeat fallback run with MAX_CONCURRENT=1', async (t) => {
  const d = makeDaemon(t)
  const { log } = poll(d, { pending: 0, maxConcurrent: 1 })
  assert.match(log, /heartbeat: spawning check-in/)
  const [args] = await waitForSpawns(d, 1)
  assert.ok(args.includes('--prompt prompts/heartbeat.md'), args)
})

for (const count of [0, 1, 3]) {
  test(`${count} live lane(s) leave ${5 - count} of 5 free`, async (t) => {
    const d = makeDaemon(t)
    mkdirSync(d.lanes)
    const lanes = Array.from({ length: count }, (_, i) => addLane(d, String(i + 1), liveProcess(t)))
    const pids = lanes.map(lanePid)
    const { log, spawning } = poll(d)
    assert.equal(spawning, 5 - count, log)
    await waitForSpawns(d, 5 - count)
    assert.deepEqual(lanes.map(lanePid), pids) // live lanes are left alone
  })
}

test('as many live lanes as MAX_CONCURRENT spawns nothing', (t) => {
  const d = makeDaemon(t)
  const lane = addLane(d, '1', liveProcess(t))
  const { log } = poll(d, { maxConcurrent: 1 })
  assert.doesNotMatch(log, /spawning/)
  assert.ok(existsSync(lane))
})

test('a just-claimed lane with no pid yet counts as live', async (t) => {
  const d = makeDaemon(t)
  addLane(d, '1')
  const { log, spawning } = poll(d)
  assert.equal(spawning, 4, log)
  await waitForSpawns(d, 4)
  assert.equal(existsSync(join(d.lanes, '1', 'pid')), false)
})

test('stale lanes are reaped before counting: dead pid, orphan claim, stuck run', async (t) => {
  const d = makeDaemon(t)
  const gone = deadPid()
  const dead = addLane(d, '1', gone)
  const orphan = addLane(d, '2')
  hourOld(orphan)
  const stuckPid = liveProcess(t)
  const stuck = addLane(d, '3', stuckPid)
  hourOld(join(stuck, 'pid'))
  const healthy = liveProcess(t)
  addLane(d, '4', healthy)

  // Every slot is taken until the three stale lanes go.
  const { log, spawning } = poll(d, { maxConcurrent: 4, maxRunSeconds: 60 })
  assert.match(log, /watchdog: killing stuck lane 3/)
  assert.equal(spawning, 3, log)
  await waitForSpawns(d, 3)
  assert.notEqual(lanePid(dead), String(gone))
  assert.ok(existsSync(join(orphan, 'pid')))
  assert.notEqual(lanePid(stuck), String(stuckPid))
  assert.equal(lanePid(join(d.lanes, '4')), String(healthy))
})

test('nothing but stale lanes reaps down to 0 live', async (t) => {
  const d = makeDaemon(t)
  for (const name of ['7', '8', '9']) addLane(d, name, deadPid())
  const { log, spawning } = poll(d, { maxConcurrent: 1 })
  assert.equal(spawning, 1, log)
  await waitForSpawns(d, 1)
  assert.deepEqual(readdirSync(d.lanes), ['1'])
})
