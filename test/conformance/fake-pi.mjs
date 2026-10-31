// Fake pi for the conformance suite (./suite.mjs) and test/pi-eval.test.mjs.
// Speaks pi's RPC mode: each {type:'prompt'} line's message names a fixture in
// test/fixtures/harness/pi/ that is replayed as the turn, verbatim, except
// directives:
//   {"$fake":"sleep","ms":N}   pause the replay (an abort drops the rest)
//   {"$fake":"hang"}           never finish the turn
//   {"$fake":"exit","code":N}  exit mid-turn (a crash)
//   {"$fake":"tool_env"}       run a bash-tool child (inheriting the environment,
//     as pi's getShellEnv does) that dumps it to $FAKE_DIR/child-env.json, and
//     stream that tool call and its output.
// {type:'abort'} ends the in-flight turn with pi's aborted message. Closing stdin
// is pi's orderly shutdown.
//
// On start, with $FAKE_DIR set, $FAKE_DIR/pi-start.json records what pi would
// load: HOME, the agent dir (PI_CODING_AGENT_DIR, else ~/.pi/agent, as pi resolves
// it), and that dir's mcp.json and auth.json.
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '../fixtures/harness/pi')
const out = (o) => process.stdout.write((typeof o === 'string' ? o : JSON.stringify(o)) + '\n')

const dir = process.env.FAKE_DIR
if (dir) {
  const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), '.pi/agent')
  const load = (f) => (existsSync(join(agentDir, f)) ? readFileSync(join(agentDir, f), 'utf8') : null)
  writeFileSync(join(dir, 'pi-start.json'), JSON.stringify({ home: process.env.HOME, agentDir, mcp: load('mcp.json'), auth: load('auth.json') }))
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
    else if (d.$fake === 'hang') await new Promise(() => setInterval(() => {}, 1000))
    else if (d.$fake === 'exit') process.exit(d.code)
    else if (d.$fake === 'tool_env') toolEnv()
  }
  if (turn === t) turn = null
}

function toolEnv() {
  const env = spawnSync(process.execPath, ['-e', 'process.stdout.write(JSON.stringify(process.env))'], { encoding: 'utf8' }).stdout
  writeFileSync(join(dir, 'child-env.json'), env)
  out({ type: 'tool_execution_start', toolCallId: 'toolu_env', toolName: 'bash', args: { command: 'env' } })
  out({ type: 'tool_execution_end', toolCallId: 'toolu_env', result: { content: [{ type: 'text', text: env }] }, isError: false })
}

let buf = ''
process.stdin.on('data', (d) => {
  buf += d
  let i
  while ((i = buf.indexOf('\n')) >= 0) {
    const msg = JSON.parse(buf.slice(0, i))
    buf = buf.slice(i + 1)
    if (msg.type === 'prompt') {
      out({ type: 'response', command: 'prompt', success: true })
      replay(msg.message)
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
