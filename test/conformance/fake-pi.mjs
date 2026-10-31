// Fake pi for the conformance suite (./suite.mjs). Speaks `pi --mode rpc`: each
// {type:'prompt', message} is answered with its response, then the message names
// a fixture in test/fixtures/harness/pi/ that is replayed as the turn. Fixture
// lines are written verbatim, except directives:
//   {"$fake":"sleep","ms":N}   pause the replay (an abort drops the rest)
//   {"$fake":"hang"}           never finish the turn
//   {"$fake":"exit","code":N}  exit mid-turn (a crash)
//   {"$fake":"tool_env"}       credential probe: record this process's argv to
//     $FAKE_DIR/cred.json, run a bash-tool child (inheriting the environment, as
//     pi's bash tool does) that dumps its environment to $FAKE_DIR/child-env.json,
//     and stream that tool call and its output.
// An {type:'abort'} ends the in-flight turn the way pi does: an aborted assistant
// message, then agent_settled. Closing stdin is pi's orderly shutdown.
// With $FAKE_PROBE every start records what pi would load to that file: its HOME,
// its agent dir, and that dir's mcp.json and auth.json.
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline'

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '../fixtures/harness/pi')
const out = (o) => process.stdout.write((typeof o === 'string' ? o : JSON.stringify(o)) + '\n')
const readIf = (f) => (existsSync(f) ? readFileSync(f, 'utf8') : null)

if (process.env.FAKE_PROBE) {
  const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(process.env.HOME, '.pi/agent')
  writeFileSync(
    process.env.FAKE_PROBE,
    JSON.stringify({ home: process.env.HOME, agentDir, mcp: readIf(join(agentDir, 'mcp.json')), auth: readIf(join(agentDir, 'auth.json')) }),
  )
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
    else if (d.$fake === 'tool_env') toolEnv()
  }
  if (turn === t) turn = null
}

function toolEnv() {
  const dir = process.env.FAKE_DIR
  writeFileSync(join(dir, 'cred.json'), JSON.stringify({ argv: process.argv.slice(2) }))
  const env = spawnSync(process.execPath, ['-e', 'process.stdout.write(JSON.stringify(process.env))'], { encoding: 'utf8' }).stdout
  writeFileSync(join(dir, 'child-env.json'), env)
  out({ type: 'tool_execution_start', toolCallId: 'tool_env', toolName: 'bash', args: { command: 'env' } })
  out({ type: 'tool_execution_end', toolCallId: 'tool_env', toolName: 'bash', result: { content: [{ type: 'text', text: env }] }, isError: false })
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
      if (!turn) return
      turn.cancelled = true
      turn = null
      out({ type: 'message_end', message: { role: 'assistant', content: [], stopReason: 'aborted', errorMessage: 'Request was aborted' } })
      out({ type: 'agent_settled' })
    }
  })
  .on('close', () => process.exit(0))
