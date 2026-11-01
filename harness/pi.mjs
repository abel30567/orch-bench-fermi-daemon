// pi adapter (see ./index.mjs for the contract). Spawns `pi --mode rpc` and maps
// its RPC records (docs/rpc.md and docs/json.md in @earendil-works/pi-coding-agent)
// to the normalized stream. A turn is {type:'prompt', message}; an interrupt is
// {type:'abort'}; a turn ends at `agent_settled` (pi will not continue on its own),
// or at the prompt's `response` when pi rejects or handles it without a run.
// runOnce uses the same RPC session: one prompt, then stdin is closed (pi's
// orderly shutdown), so the prompt never reaches argv.
//
// Options beyond the contract:
//   bin          default env PI_BIN, else `pi` on PATH
//   sandboxHome  eval mode (with mcpConfig): pi runs with HOME=<sandboxHome> and
//                PI_CODING_AGENT_DIR=<sandboxHome>/.pi/agent, so it never sees the
//                owner's real ~/.pi/agent (whose mcp.json points at production Fermi)
// allowedTools is ignored and runOnce's skipPermissions/maxTurns have no pi
// equivalent. tokenFd, configDir and scrubSubprocessEnv are refused (they
// promise an isolation pi cannot give; see below).
//
// Eval mode (mcpConfig + sandboxHome; mcpConfig alone is refused): the runner's
// MCP config (a Claude-style { mcpServers } object, JSON string or file path) is
// translated by piMcpConfig() into <sandboxHome>/.pi/agent/mcp.json. Every server
// must be an HTTP server on localhost (the eval worker); anything else, or any
// non-localhost URL anywhere in the generated file, refuses to start. pi can only
// log in from <agent-dir>/auth.json, so the real ~/.pi/agent/auth.json is copied
// into the sandbox for the attempt and deleted when the pi process ends (part of
// the credential-isolation blocker below: the copy is as reachable by pi's tools
// as the original). The real mcp.json is never read.
//
// Known gaps vs the Claude Code adapter:
//   - No per-turn cost or session id. pi has no turn-level result record (Claude's
//     total_cost_usd / session_id) and no init record, so turn_end carries no
//     costUsd or token counts and no `init` event is emitted. The session id is
//     only available through the get_state command.
//   - Broader built-in tools. pi enables read, bash, edit and write and never asks
//     for permission; Claude's lane allows only Bash + MCP. Built-in names are
//     lowercase (`bash`, not `Bash`) and take `path` instead of `file_path`;
//     narrator.py knows both spellings.
//   - No Google Calendar. pi has no equivalent of the claude.ai connector; MCP
//     servers come from <agent-dir>/mcp.json (fermi, playwright).
//   - Credential isolation: SWAP-GATE BLOCKER. pi reads its Anthropic credential
//     only from argv (--api-key), the environment (ANTHROPIC_API_KEY /
//     ANTHROPIC_OAUTH_TOKEN, which its bash tool's children inherit: pi's
//     getShellEnv() passes process.env through) or <agent-dir>/auth.json
//     (~/.pi/agent/auth.json after /login, a plain file with the OAuth tokens that
//     the no-prompt read/bash tools can open). There is no fd handoff like
//     CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR, so tokenFd is refused and the
//     conformance credential-isolation case is expectedFail. Do not swap pi into
//     the live worker until the credential is out of reach of its tools.

import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { classifyResult } from '../lib/turn-outcome.mjs'
import { bareToolName } from './index.mjs'

export const name = 'pi'

const UNSUPPORTED = ['tokenFd', 'configDir', 'scrubSubprocessEnv']

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])
const isLocalUrl = (url) => {
  try {
    const u = new URL(url)
    return (u.protocol === 'http:' || u.protocol === 'https:') && LOCAL_HOSTS.has(u.hostname)
  } catch {
    return false
  }
}
const refuse = (bad) => {
  throw new Error(`refusing to start: non-localhost or url-less MCP server(s) for pi: ${bad.join(', ')}`)
}

// The runner's MCP config ({ mcpServers }, as an object, JSON text or a file
// path) → pi's mcp.json. Only localhost HTTP servers pass; a stdio (url-less) or
// remote server throws, so pi can only ever reach the local eval worker.
export function piMcpConfig(config) {
  if (typeof config === 'string') config = JSON.parse(config.trim().startsWith('{') ? config : readFileSync(config, 'utf8'))
  const servers = config?.mcpServers ?? {}
  const bad = []
  const out = {}
  for (const [name, s] of Object.entries(servers)) {
    if (typeof s?.url !== 'string' || !isLocalUrl(s.url)) {
      bad.push(`${name}=${s?.url ?? '(no url)'}`)
      continue
    }
    out[name] = { type: 'http', url: s.url, ...(s.headers && { headers: s.headers }) }
  }
  if (bad.length) refuse(bad)
  // Belt and braces: no URL anywhere in the generated file may leave localhost.
  const urls = JSON.stringify(out).match(/[a-z][a-z0-9+.-]*:\/\/[^"\s\\]+/gi) ?? []
  const remote = urls.filter((u) => !isLocalUrl(u))
  if (remote.length) refuse(remote)
  return { mcpServers: out }
}

// Eval mode: write the sandbox agent dir and return the env overrides plus a
// cleanup that deletes the copied auth.json (run when pi exits).
function sandbox({ mcpConfig, sandboxHome }) {
  if (mcpConfig == null) return null
  if (!sandboxHome) throw new Error('mcpConfig without sandboxHome is refused by the pi adapter (pi would read the real ~/.pi/agent; see harness/pi.mjs)')
  const mcp = piMcpConfig(mcpConfig)
  const agentDir = join(sandboxHome, '.pi', 'agent')
  mkdirSync(agentDir, { recursive: true })
  writeFileSync(join(agentDir, 'mcp.json'), JSON.stringify(mcp, null, 2) + '\n')
  const auth = join(agentDir, 'auth.json')
  const realAuth = join(process.env.HOME || homedir(), '.pi', 'agent', 'auth.json')
  if (existsSync(realAuth)) {
    copyFileSync(realAuth, auth)
    chmodSync(auth, 0o600)
  }
  let cleaned = false
  const cleanup = () => {
    if (cleaned) return
    cleaned = true
    process.off('exit', cleanup)
    rmSync(auth, { force: true })
  }
  process.on('exit', cleanup) // the daemon dying mid-attempt still removes the copy
  return { env: { HOME: sandboxHome, PI_CODING_AGENT_DIR: agentDir }, cleanup }
}

export function sessionArgs({ model, systemPrompt }) {
  const a = ['--mode', 'rpc']
  if (model) a.push('--model', `anthropic/${model.replace(/\[.*\]$/, '')}`) // pi has no [1m] suffix
  if (systemPrompt != null) a.push('--append-system-prompt', systemPrompt)
  return a
}

const contentText = (c) =>
  typeof c === 'string' ? c : Array.isArray(c) ? c.map((b) => b?.text || '').join(' ') : ''

// A turn's last assistant message in the shape classifyResult reads (a Claude
// result event). Provider errors read "<status> <body>" (the Anthropic SDK's text).
function resultOf(m, aborted) {
  const failed = aborted || m?.stopReason === 'error' || m?.stopReason === 'aborted'
  const text = failed ? m?.errorMessage ?? '' : contentText(m?.content)
  const status = failed ? /^(\d{3})\b/.exec(text)?.[1] : null
  return { is_error: failed, result: text, subtype: m?.stopReason, ...(status && { api_error_status: Number(status) }) }
}

// pi RPC records → normalized events. Stateful: turn_end needs the turn's last
// assistant message and whether the turn was aborted. start() on each send.
export function createNormalizer() {
  let since = 0
  let last = null
  let aborted = false
  const end = (j, result) => [
    { type: 'turn_end', ...classifyResult(result), durationMs: since ? Date.now() - since : 0, raw: j },
  ]
  return {
    start() {
      since = Date.now()
      last = null
      aborted = false
    },
    abort() {
      aborted = true
    },
    normalize(j) {
      switch (j?.type) {
        case 'message_end':
          if (j.message?.role !== 'assistant') return []
          last = j.message
          return (last.content ?? []).filter((b) => b?.type === 'text' && b.text).map((b) => ({ type: 'text', text: b.text }))
        case 'tool_execution_start':
          return [{ type: 'tool_call', id: j.toolCallId, name: bareToolName(j.toolName), rawName: j.toolName, input: j.args ?? {} }]
        case 'tool_execution_end':
          return [{ type: 'tool_result', id: j.toolCallId, ok: j.isError !== true, content: contentText(j.result?.content) }]
        case 'agent_settled':
          return end(j, resultOf(last, aborted))
        case 'response':
          // A rejected or handled prompt starts no run, so no agent_settled follows.
          if (j.command !== 'prompt') return []
          if (!j.success) return end(j, { is_error: true, result: String(j.error ?? '') })
          return j.data?.disposition === 'handled' ? end(j, { is_error: false, result: '' }) : []
        default:
          return []
      }
    },
  }
}

function open(o) {
  const bad = UNSUPPORTED.filter((k) => o[k] != null)
  if (bad.length) throw new Error(`pi adapter: unsupported option(s) ${bad.join(', ')} (see harness/pi.mjs)`)
  const box = sandbox(o)
  let child
  try {
    child = spawn(o.bin || process.env.PI_BIN || 'pi', sessionArgs(o), {
      cwd: o.cwd,
      env: { ...process.env, ...o.env, ...box?.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
  } catch (err) {
    box?.cleanup()
    throw err
  }
  if (box) {
    child.on('exit', box.cleanup)
    child.on('error', box.cleanup)
  }
  const events = new EventEmitter()
  const norm = createNormalizer()
  // Split on LF only: pi's records may hold U+2028/U+2029, which readline splits on.
  let buf = ''
  child.stdout.on('data', (d) => {
    buf += d.toString()
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, '')
      buf = buf.slice(i + 1)
      if (!line.trim()) continue
      events.emit('raw', line)
      let j
      try {
        j = JSON.parse(line)
      } catch {
        continue
      }
      for (const ev of norm.normalize(j)) events.emit('event', ev)
    }
  })
  child.stderr.on('data', (d) => events.emit('stderr', d.toString()))
  child.on('exit', (code) => events.emit('exit', code))
  const write = (msg) => {
    if (!child.stdin.writable) return false
    child.stdin.write(JSON.stringify(msg) + '\n')
    return true
  }
  const send = (text) => {
    norm.start()
    return write({ type: 'prompt', message: text })
  }
  return { child, events, norm, write, send }
}

export function startSession(o) {
  const { child, events, norm, write, send } = open(o)
  return {
    pid: child.pid,
    events,
    get alive() {
      return child.stdin.writable
    },
    send,
    // Abort the in-flight turn; the process (and its session) stays alive.
    interrupt() {
      norm.abort()
      return write({ type: 'abort' })
    },
    close(signal) {
      child.kill(signal)
    },
  }
}

export function runOnce(o) {
  const { child, events, send } = open(o)
  const all = []
  let outcome = null
  let stderr = ''
  events.on('event', (ev) => {
    all.push(ev)
    if (ev.type === 'turn_end' && !outcome) {
      outcome = ev
      child.stdin.end() // orderly shutdown
    }
  })
  events.on('stderr', (s) => (stderr += s))
  const done = new Promise((resolve) => child.on('close', (code) => resolve({ code, outcome, events: all, stderr })))
  send(o.prompt ?? '')
  return { pid: child.pid, events, done, close: (signal) => child.kill(signal) }
}
