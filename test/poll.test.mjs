// poll.sh end to end: the real script against a fake $HOME/fermi-daemon with
// stubbed curl/pgrep/node/python3, checking the live-lane count via how many
// cold drain lanes it spawns.
import { test, describe, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, chmodSync, realpathSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ROOT } from './run-worker.mjs'

const hasZsh = spawnSync('zsh', ['-c', 'true']).status === 0
const sleepers = []
after(() => sleepers.forEach((p) => p.kill('SIGKILL')))

function exe(path, body) {
  writeFileSync(path, `#!/bin/sh\n${body}\n`)
  chmodSync(path, 0o755)
}

// Runs poll.sh once. `lanes` maps lane name -> 'live' | 'dead' | 'orphan'.
function runPoll({ maxConcurrent, pending, lanes = {} }) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'dmn7-')))
  const daemon = join(home, 'fermi-daemon')
  const bin = join(home, 'bin')
  for (const d of [daemon, bin, join(daemon, 'logs'), join(daemon, 'runs'), join(daemon, 'lanes')]) mkdirSync(d, { recursive: true })
  const spawnLog = join(home, 'spawns')
  writeFileSync(join(daemon, '.env'), `FERMI_URL=http://fermi.invalid\nFERMI_BEARER_TOKEN=t\nNODE_BIN=${join(bin, 'node')}\n`)
  exe(join(bin, 'curl'), `echo '{"pending": ${pending}}'`)
  exe(join(bin, 'pgrep'), 'exit 1') // warm worker down
  exe(join(bin, 'python3'), 'exit 0') // narrator
  exe(join(bin, 'node'), `[ "$1" = -v ] && { echo v22.0.0; exit 0; }\necho "$@" >>"${spawnLog}"`)
  // poll.sh uses BSD `stat -f %m`; map it to GNU stat off macOS.
  if (process.platform !== 'darwin') exe(join(bin, 'stat'), 'shift 2; exec /usr/bin/stat -c %Y "$@"')

  const old = (Date.now() - 3600_000) / 1000
  for (const [name, kind] of Object.entries(lanes)) {
    const dir = join(daemon, 'lanes', name)
    mkdirSync(dir)
    if (kind === 'live') {
      const p = spawn('sleep', ['60'], { stdio: 'ignore' })
      sleepers.push(p)
      writeFileSync(join(dir, 'pid'), String(p.pid))
    } else if (kind === 'dead') {
      writeFileSync(join(dir, 'pid'), '999999')
    } else {
      utimesSync(dir, old, old) // claimed long ago, pid never written
    }
  }

  const r = spawnSync('zsh', [join(ROOT, 'poll.sh')], {
    env: { HOME: home, PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`, MAX_CONCURRENT: String(maxConcurrent) },
    encoding: 'utf8',
  })
  assert.equal(r.status, 0, r.stderr)
  // Spawns are backgrounded; wait briefly for the fake node to record them.
  const deadline = Date.now() + 3000
  const pollLog = () => (existsSync(join(daemon, 'logs/poll.log')) ? readFileSync(join(daemon, 'logs/poll.log'), 'utf8') : '')
  const expected = (pollLog().match(/spawned drain\.md/g) || []).length
  let spawns = []
  while (Date.now() < deadline) {
    spawns = existsSync(spawnLog) ? readFileSync(spawnLog, 'utf8').trim().split('\n').filter(Boolean) : []
    if (spawns.length >= expected) break
    spawnSync('sleep', ['0.05'])
  }
  const m = pollLog().match(/spawning (\d+)/)
  return { spawned: m ? Number(m[1]) : 0, spawns, lanes: readdirSync(join(daemon, 'lanes')).sort(), log: pollLog() }
}

describe('poll.sh live-lane count', { skip: !hasZsh && 'zsh not installed' }, () => {
  test('empty lanes/ counts 0 live lanes: MAX_CONCURRENT=1 spawns a drain lane', () => {
    const r = runPoll({ maxConcurrent: 1, pending: 1 })
    assert.equal(r.spawned, 1, r.log)
    assert.equal(r.spawns.length, 1)
    assert.match(r.spawns[0], /--prompt prompts\/drain\.md/)
  })

  test('1 live lane: only the remaining capacity is spawned', () => {
    const r = runPoll({ maxConcurrent: 2, pending: 5, lanes: { 1: 'live' } })
    assert.equal(r.spawned, 1, r.log)
    assert.deepEqual(r.lanes, ['1', '2'])
  })

  test('1 live lane at MAX_CONCURRENT=1: nothing spawns', () => {
    const r = runPoll({ maxConcurrent: 1, pending: 5, lanes: { 1: 'live' } })
    assert.equal(r.spawned, 0, r.log)
    assert.deepEqual(r.lanes, ['1'])
  })

  test('3 live lanes counted as 3', () => {
    const r = runPoll({ maxConcurrent: 4, pending: 5, lanes: { 1: 'live', 2: 'live', 3: 'live' } })
    assert.equal(r.spawned, 1, r.log)
    assert.deepEqual(r.lanes, ['1', '2', '3', '4'])
  })

  test('stale lanes are reaped and not counted', () => {
    const r = runPoll({ maxConcurrent: 3, pending: 5, lanes: { 1: 'live', 2: 'dead', 3: 'orphan' } })
    assert.equal(r.spawned, 2, r.log)
    assert.deepEqual(r.lanes, ['1', '2', '3'])
  })

  test('only stale lanes: all reaped, count is 0', () => {
    const r = runPoll({ maxConcurrent: 1, pending: 1, lanes: { 5: 'dead', 6: 'orphan', 7: 'dead' } })
    assert.equal(r.spawned, 1, r.log)
    assert.deepEqual(r.lanes, ['1'])
  })
})
