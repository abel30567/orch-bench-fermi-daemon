// Fake pi for the conformance suite (./suite.mjs) and test/pi-eval.test.mjs. Speaks
// pi's `--mode rpc`: each {type:'prompt', message} names a fixture in
// test/fixtures/harness/pi/ that is replayed as the turn; EOF on stdin is the
// orderly shutdown. Fixture lines are written verbatim, except directives:
//   {"$fake":"sleep","ms":N}   pause the replay (an abort drops the rest)
//   {"$fake":"hang"}           never finish the turn
//   {"$fake":"exit","code":N}  exit mid-turn (a crash)
// tool_env (the credential probe) is skipped: the adapter refuses tokenFd first.
// An {type:'abort'} ends the in-flight turn with pi's aborted message.
// With FAKE_PI_PROBE, it resolves its agent dir as pi does (PI_CODING_AGENT_DIR,
// else ~/.pi/agent) and writes what it finds there to that file at startup.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline'

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '../fixtures/harness/pi')
const out = (o) => process.stdout.write((typeof o === 'string' ? o : JSON.stringify(o)) + '\n')

if (process.env.FAKE_PI_PROBE) {
  const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), '.pi/agent')
  const auth = join(agentDir, 'auth.json')
  writeFileSync(process.env.FAKE_PI_PROBE, JSON.stringify({
    HOME: process.env.HOME,
    PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR ?? null,
    mcp: readFileSync(join(agentDir, 'mcp.json'), 'utf8'),
    auth: existsSync(auth) ? readFileSync(auth, 'utf8') : null,
  }))
}

let turn = null // the in-flight turn: { cancelled }

async function replay(name) {
  const t = (turn = { cancelled: false })
  const lines = readFileSync(join(FIXTURES, `${name}.jsonl`), 'utf8').split('\n').filter((l) => l.trim())
  for (const line of lines) {
    if (t.cancelled) return
    const d = JSON.parse(line)
    if (!d.$fake) out(line)
    else if (d.$fake === 'sleep') await new Promise((r) => setTimeout(r, d.ms))
    else if (d.$fake === 'hang') await new Promise(() => {})
    else if (d.$fake === 'exit') process.exit(d.code)
  }
  if (turn === t) turn = null
}

const rl = createInterface({ input: process.stdin })
rl.on('close', () => process.exit(0))
rl.on('line', (line) => {
  let msg
  try {
    msg = JSON.parse(line)
  } catch {
    return
  }
  if (msg.type === 'abort') {
    out({ type: 'response', command: 'abort', success: true })
    if (turn) {
      turn.cancelled = true
      turn = null
      out({ type: 'message_end', message: { role: 'assistant', content: [], stopReason: 'aborted', errorMessage: 'Request was aborted' } })
      out({ type: 'agent_settled' })
    }
  } else if (msg.type === 'prompt') {
    out({ type: 'response', command: 'prompt', success: true })
    replay(msg.message)
  }
})
