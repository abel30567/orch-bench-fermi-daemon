// Fake `pi --mode rpc` for the eval-mode tests: on start it records HOME,
// PI_CODING_AGENT_DIR and what it finds in that agent dir (mcp.json, auth.json)
// to $FAKE_DIR/spawn.json; every prompt gets one assistant message and
// agent_settled; it exits when stdin closes.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

const agentDir = process.env.PI_CODING_AGENT_DIR
const read = (f) => (agentDir && existsSync(join(agentDir, f)) ? readFileSync(join(agentDir, f), 'utf8') : null)
writeFileSync(
  join(process.env.FAKE_DIR, 'spawn.json'),
  JSON.stringify({ home: process.env.HOME, agentDir: agentDir ?? null, mcp: read('mcp.json'), auth: read('auth.json') }),
)
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n')
createInterface({ input: process.stdin })
  .on('line', (line) => {
    const msg = JSON.parse(line)
    if (msg.type !== 'prompt') return
    out({ type: 'response', command: 'prompt', success: true })
    out({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'OK' }], stopReason: 'stop' } })
    out({ type: 'agent_settled' })
  })
  .on('close', () => process.exit(0))
