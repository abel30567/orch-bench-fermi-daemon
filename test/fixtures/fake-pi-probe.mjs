// Fake pi for test/pi-eval.test.mjs. On start it writes to $PROBE_FILE what a real
// pi would load: its HOME, its agent dir and that dir's mcp.json and auth.json.
// Rejecting the first prompt ends the turn; closing stdin shuts it down.
import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

const dir = process.env.PI_CODING_AGENT_DIR ?? join(process.env.HOME, '.pi/agent')
const read = (name) => {
  try {
    return readFileSync(join(dir, name), 'utf8')
  } catch {
    return null
  }
}
const authMode = read('auth.json') == null ? null : statSync(join(dir, 'auth.json')).mode & 0o777
writeFileSync(process.env.PROBE_FILE, JSON.stringify({ home: process.env.HOME, agentDir: process.env.PI_CODING_AGENT_DIR, mcp: read('mcp.json'), auth: read('auth.json'), authMode }))
createInterface({ input: process.stdin })
  .on('line', () => process.stdout.write(JSON.stringify({ type: 'response', command: 'prompt', success: false, error: 'probe' }) + '\n'))
  .on('close', () => process.exit(0))
