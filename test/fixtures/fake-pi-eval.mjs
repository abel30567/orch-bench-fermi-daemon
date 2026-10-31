// Fake `pi --mode rpc` for the eval-mode tests (test/pi-eval.test.mjs). It writes
// what pi would see at startup to $FAKE_PI_OUT: HOME, PI_CODING_AGENT_DIR, the
// mcp.json and auth.json in that agent dir. Then it answers each prompt with an
// assistant message and agent_settled, and exits when stdin closes.
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(process.env.HOME ?? '', '.pi', 'agent')
const read = (f) => {
  try {
    return readFileSync(join(agentDir, f), 'utf8')
  } catch {
    return null
  }
}
writeFileSync(
  process.env.FAKE_PI_OUT,
  JSON.stringify({ home: process.env.HOME, agentDir: process.env.PI_CODING_AGENT_DIR ?? null, mcp: JSON.parse(read('mcp.json') ?? 'null'), auth: read('auth.json') }),
)

const out = (j) => process.stdout.write(JSON.stringify(j) + '\n')
let buf = ''
process.stdin.on('data', (d) => {
  buf += d
  let i
  while ((i = buf.indexOf('\n')) >= 0) {
    const msg = JSON.parse(buf.slice(0, i))
    buf = buf.slice(i + 1)
    if (msg.type !== 'prompt') continue
    out({ type: 'response', command: 'prompt', success: true })
    out({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'ok' }] } })
    out({ type: 'agent_settled' })
  }
})
process.stdin.on('end', () => process.exit(0))
