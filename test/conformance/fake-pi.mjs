// Fake pi for the conformance suite (./suite.mjs). Speaks pi's RPC protocol
// (`pi --mode rpc`): each {type:'prompt', message} names a fixture in
// test/fixtures/harness/pi/ that is replayed as the turn; {type:'abort'} ends the
// in-flight turn with an aborted assistant message and agent_settled. Closing
// stdin shuts it down. Fixture lines are written verbatim, except directives:
//   {"$fake":"sleep","ms":N}   pause the replay (an abort drops the rest)
//   {"$fake":"hang"}           never finish the turn
//   {"$fake":"exit","code":N}  exit mid-turn (a crash)
//   {"$fake":"tool_env"}       credential probe: record argv to $FAKE_DIR/cred.json
//     and a bash-tool child's environment to $FAKE_DIR/child-env.json (pi has no
//     token fd, so there is no token to hash).
// At startup, if $FAKE_DIR is set, it records what pi would see to
// $FAKE_DIR/startup.json: HOME, PI_CODING_AGENT_DIR and the agent dir's mcp.json
// and auth.json (pi's agent dir is PI_CODING_AGENT_DIR, else ~/.pi/agent).
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '../fixtures/harness/pi')
const out = (o) => process.stdout.write((typeof o === 'string' ? o : JSON.stringify(o)) + '\n')

if (process.env.FAKE_DIR) {
  const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), '.pi/agent')
  const read = (f) => (existsSync(join(agentDir, f)) ? readFileSync(join(agentDir, f), 'utf8') : null)
  writeFileSync(
    join(process.env.FAKE_DIR, 'startup.json'),
    JSON.stringify({ home: process.env.HOME, agentDirEnv: process.env.PI_CODING_AGENT_DIR ?? null, mcp: read('mcp.json'), auth: read('auth.json') }),
  )
}

let turn = null // the in-flight turn: { cancelled }

async function replay(name) {
  const t = (turn = { cancelled: false })
  let lines
  try {
    lines = readFileSync(join(FIXTURES, `${name}.jsonl`), 'utf8').split('\n').filter((l) => l.trim())
  } catch {
    lines = []
  }
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
  writeFileSync(join(dir, 'cred.json'), JSON.stringify({ tokenSha256: null, argv: process.argv.slice(2) }))
  const env = spawnSync(process.execPath, ['-e', 'process.stdout.write(JSON.stringify(process.env))'], { encoding: 'utf8' }).stdout
  writeFileSync(join(dir, 'child-env.json'), env)
  out({ type: 'tool_execution_start', toolCallId: 'toolu_env', toolName: 'bash', args: { command: 'env' } })
  out({ type: 'tool_execution_end', toolCallId: 'toolu_env', toolName: 'bash', result: { content: [{ type: 'text', text: env }] }, isError: false })
}

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
    if (msg.type === 'prompt') {
      out({ type: 'response', command: 'prompt', success: true })
      replay(String(msg.message).trim())
    } else if (msg.type === 'abort') {
      out({ type: 'response', command: 'abort', success: true })
      if (turn) {
        turn.cancelled = true
        turn = null
        out({ type: 'message_end', message: { role: 'assistant', content: [], stopReason: 'aborted', errorMessage: 'Request was aborted' } })
        out({ type: 'agent_settled' })
      }
    }
  }
})
process.stdin.on('end', () => process.exit(0))
