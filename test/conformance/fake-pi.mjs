// Fake pi for the conformance suite (./suite.mjs). Speaks pi's RPC mode: each
// {type:'prompt'} line's message names a fixture in test/fixtures/harness/pi/ that
// is replayed as the turn; closing stdin is pi's orderly shutdown. Fixture lines
// are written verbatim, except directives:
//   {"$fake":"sleep","ms":N}   pause the replay (an abort drops the rest)
//   {"$fake":"hang"}           never finish the turn
//   {"$fake":"exit","code":N}  exit mid-turn (a crash)
//   {"$fake":"tool_env"}       ignored: the adapter refuses tokenFd, so no
//     credential is ever handed over (the suite's expectedFail case)
// An {type:'abort'} line ends the in-flight turn with agent_settled.
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline'

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '../fixtures/harness/pi')
const out = (o) => process.stdout.write((typeof o === 'string' ? o : JSON.stringify(o)) + '\n')

let turn = null // the in-flight turn: { cancelled }
let closed = false

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
  if (closed) process.exit(0)
}

createInterface({ input: process.stdin })
  .on('line', (line) => {
    let msg
    try {
      msg = JSON.parse(line)
    } catch {
      return
    }
    if (msg.type === 'prompt') {
      out({ type: 'response', command: 'prompt', success: true })
      replay(msg.message)
    } else if (msg.type === 'abort') {
      out({ type: 'response', command: 'abort', success: true })
      if (turn) {
        turn.cancelled = true
        turn = null
        out({ type: 'agent_settled' })
      }
    }
  })
  .on('close', () => {
    closed = true
    if (!turn) process.exit(0)
  })
