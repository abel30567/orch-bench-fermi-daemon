// Fake pi for the eval-mode tests (test/pi-eval.test.mjs). On start it writes what
// pi would load to $FAKE_PI_DUMP: HOME, PI_CODING_AGENT_DIR, the mcp.json and
// auth.json of its agent dir (PI_CODING_AGENT_DIR, else ~/.pi/agent; null if
// absent) and its environment. Each RPC `prompt` gets a one-message run that
// settles, unless the message is "hold" (the run never settles). Closing stdin
// exits, as pi does.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

const out = (o) => process.stdout.write(JSON.stringify(o) + '\n')
const agentDir = process.env.PI_CODING_AGENT_DIR || join(process.env.HOME, '.pi', 'agent')
const read = (f) => (existsSync(join(agentDir, f)) ? readFileSync(join(agentDir, f), 'utf8') : null)
writeFileSync(
  process.env.FAKE_PI_DUMP,
  JSON.stringify({ home: process.env.HOME, agentDir: process.env.PI_CODING_AGENT_DIR ?? null, mcp: read('mcp.json'), auth: read('auth.json'), env: process.env }),
)

createInterface({ input: process.stdin })
  .on('line', (line) => {
    const msg = JSON.parse(line)
    if (msg.type !== 'prompt') return
    out({ type: 'response', command: 'prompt', success: true, data: { disposition: 'started' } })
    if (msg.message === 'hold') return
    out({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }], stopReason: 'stop' } })
    out({ type: 'agent_settled' })
  })
  .on('close', () => process.exit(0))
