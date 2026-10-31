// Fake pi for the conformance suite (./suite.mjs). Speaks pi's RPC mode
// (--mode rpc): each {type:'prompt', message} names a fixture in
// test/fixtures/harness/pi/ that is replayed as the turn, after the prompt's
// `response`. Fixture lines are written verbatim, except directives:
//   {"$fake":"sleep","ms":N}   pause the replay (an abort drops the rest)
//   {"$fake":"hang"}           never finish the turn
//   {"$fake":"exit","code":N}  exit mid-turn (a crash)
//   {"$fake":"tool_env"}       credential probe: record the sha256 of
//     ANTHROPIC_OAUTH_TOKEN and this process's argv to $FAKE_DIR/cred.json, run a
//     bash-tool child (inheriting the environment, as pi's bash tool does) that
//     dumps its environment to $FAKE_DIR/child-env.json, and stream that tool call.
// {type:'abort'} ends the in-flight turn as pi does: an aborted assistant
// message, then agent_end and agent_settled. Closing stdin ends the process once
// the turn in flight is done.
// At startup, with $FAKE_DIR set, it records what pi would load to
// $FAKE_DIR/pi-home.json: HOME, the agent dir (PI_CODING_AGENT_DIR, else
// $HOME/.pi/agent), and that dir's mcp.json and auth.json (null if absent).
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '../fixtures/harness/pi')
const out = (o) => process.stdout.write((typeof o === 'string' ? o : JSON.stringify(o)) + '\n')
const readOrNull = (p) => {
  try {
    return readFileSync(p, 'utf8')
  } catch {
    return null
  }
}

if (process.env.FAKE_DIR) {
  const agentDir = process.env.PI_CODING_AGENT_DIR || join(process.env.HOME, '.pi/agent')
  writeFileSync(
    join(process.env.FAKE_DIR, 'pi-home.json'),
    JSON.stringify({ home: process.env.HOME, agentDir, mcp: readOrNull(join(agentDir, 'mcp.json')), auth: readOrNull(join(agentDir, 'auth.json')) }),
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
    else if (d.$fake === 'hang') await new Promise(() => setInterval(() => {}, 1 << 30))
    else if (d.$fake === 'exit') process.exit(d.code)
    else if (d.$fake === 'tool_env') toolEnv()
  }
  if (turn === t) turn = null
}

function toolEnv() {
  const dir = process.env.FAKE_DIR
  const tokenSha256 = createHash('sha256').update(process.env.ANTHROPIC_OAUTH_TOKEN ?? '').digest('hex')
  writeFileSync(join(dir, 'cred.json'), JSON.stringify({ tokenSha256, argv: process.argv.slice(2) }))
  const env = spawnSync(process.execPath, ['-e', 'process.stdout.write(JSON.stringify(process.env))'], { encoding: 'utf8' }).stdout
  writeFileSync(join(dir, 'child-env.json'), env)
  out({ type: 'tool_execution_start', toolCallId: 'toolu_env', toolName: 'bash', args: { command: 'env' } })
  out({ type: 'tool_execution_end', toolCallId: 'toolu_env', toolName: 'bash', result: { content: [{ type: 'text', text: env }] }, isError: false })
}

function abort() {
  if (!turn) return
  turn.cancelled = true
  turn = null
  const message = { role: 'assistant', content: [], stopReason: 'aborted', errorMessage: 'Request was aborted' }
  out({ type: 'message_end', message })
  out({ type: 'agent_end', messages: [message] })
  out({ type: 'agent_settled' })
}

// Split on LF only, as pi does.
let buf = ''
process.stdin.on('data', (d) => {
  buf += d.toString()
  let i
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i)
    buf = buf.slice(i + 1)
    let msg
    try {
      msg = JSON.parse(line)
    } catch {
      continue
    }
    out({ type: 'response', command: msg.type, success: true })
    if (msg.type === 'prompt') replay(msg.message)
    else if (msg.type === 'abort') abort()
  }
})
