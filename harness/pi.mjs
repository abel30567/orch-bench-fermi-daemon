// pi adapter (see ./index.mjs for the contract). Spawns `pi --mode rpc` and maps
// its RPC records (docs/rpc.md and docs/json.md in @earendil-works/pi-coding-agent)
// to the normalized stream. A turn is {type:'prompt', message}; an interrupt is
// {type:'abort'}; a turn ends at `agent_settled` (pi will not continue on its own),
// or at the prompt's `response` when pi rejects or handles it without a run.
// runOnce uses the same RPC session: one prompt, then stdin is closed (pi's
// orderly shutdown), so the prompt never reaches argv.
//
// Options beyond the contract:
//   bin   default env PI_BIN, else `pi` on PATH
//   sandboxHome   eval mode, together with mcpConfig (a path or JSON, as for
//     claude --mcp-config). pi runs with HOME=<sandboxHome> and
//     PI_CODING_AGENT_DIR=<sandboxHome>/.pi/agent, so it never sees the owner's
//     config, which points at production Fermi. That agent dir gets an mcp.json
//     translated by piMcpConfig (localhost only, or nothing starts) and, for
//     the attempt only, a copy of the real ~/.pi/agent/auth.json, pi's only
//     login (see the credential blocker below). The copy is deleted when pi
//     exits or this process does, except on SIGKILL, which nothing can catch;
//     refreshed tokens are not copied back.
// allowedTools is ignored and runOnce's skipPermissions/maxTurns have no pi
// equivalent. tokenFd, configDir and scrubSubprocessEnv are refused, and so is
// mcpConfig without sandboxHome (they promise an isolation pi cannot give; see
// below).
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
//     the live worker until the credential is out of reach of its tools. Eval
//     mode does not change this: the sandbox's auth.json is just as readable.

import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { isLocalUrl } from '../lib/local-url.mjs'
import { classifyResult } from '../lib/turn-outcome.mjs'
import { bareToolName } from './index.mjs'

export const name = 'pi'

const UNSUPPORTED = ['tokenFd', 'configDir', 'scrubSubprocessEnv']
const AGENT_DIR = join('.pi', 'agent')
const EXIT_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT', 'SIGABRT']

// The runner's MCP config → pi's mcp.json. Only each server's url survives, so
// nothing else (a header, a stdio command) can carry a way off this machine.
export function piMcpConfig(config) {
  const servers = Object.entries(config?.mcpServers ?? {}).map(([server, s]) => {
    if (typeof s?.url !== 'string' || !isLocalUrl(s.url)) throw new Error(`refusing to start: non-localhost MCP server ${server}=${s?.url ?? '(no url)'}`)
    return [server, { url: s.url }]
  })
  return { mcpServers: Object.fromEntries(servers) }
}

const readMcpConfig = (c) => (typeof c !== 'string' ? c : JSON.parse(c.trim().startsWith('{') ? c : readFileSync(c, 'utf8')))

// By inode, not by path: a path that differs only in case is the same directory on
// a case-insensitive volume, and realpath keeps the case it was given.
function sameDir(a, b) {
  const [x, y] = [a, b].map((p) => statSync(p, { bigint: true, throwIfNoEntry: false }))
  return x && y ? x.dev === y.dev && x.ino === y.ino : resolve(a) === resolve(b)
}

// Eval mode: prepare <sandboxHome>/.pi/agent. Returns the env overrides for pi and
// removeAuth(), or null outside eval mode. Throws before writing anything if the
// options or the MCP config do not hold.
function prepareSandbox({ mcpConfig, sandboxHome }) {
  if (mcpConfig == null && sandboxHome == null) return null
  if (mcpConfig == null) throw new Error('pi adapter: sandboxHome without mcpConfig (see harness/pi.mjs)')
  if (!sandboxHome) throw new Error('pi adapter: mcpConfig without sandboxHome would use the real pi config (see harness/pi.mjs)')
  const config = piMcpConfig(readMcpConfig(mcpConfig))
  const home = resolve(sandboxHome)
  const agentDir = join(home, AGENT_DIR)
  const realAgentDir = join(homedir(), AGENT_DIR)
  // Writing here would replace the owner's mcp.json, and the cleanup would delete their login.
  // Every level, because the agent dir may not exist yet and a symlinked .pi leads to the same place.
  if (['', '.pi', AGENT_DIR].some((sub) => sameDir(join(home, sub), join(homedir(), sub))))
    throw new Error('pi adapter: sandboxHome is the real HOME (see harness/pi.mjs)')
  mkdirSync(agentDir, { recursive: true, mode: 0o700 })
  writeFileSync(join(agentDir, 'mcp.json'), JSON.stringify(config, null, 2) + '\n')
  const auth = join(agentDir, 'auth.json')
  const removeAuth = () => rmSync(auth, { force: true })
  removeAuth()
  // No file is no login, which is not an error: ANTHROPIC_API_KEY may be set.
  if (existsSync(join(realAgentDir, 'auth.json'))) {
    copyFileSync(join(realAgentDir, 'auth.json'), auth)
    chmodSync(auth, 0o600)
  }
  return { env: { HOME: home, PI_CODING_AGENT_DIR: agentDir }, removeAuth }
}

// Run removeAuth once, when the child is gone or when this process is ending
// first (a signal's default action skips 'exit', so re-raise it after cleaning up).
function removeAuthAtEnd(child, removeAuth) {
  const onExit = () => removeAuth()
  const onSignal = (signal) => {
    done()
    process.kill(process.pid, signal)
  }
  const done = () => {
    removeAuth()
    process.off('exit', onExit)
    for (const s of EXIT_SIGNALS) process.off(s, onSignal)
  }
  process.on('exit', onExit)
  for (const s of EXIT_SIGNALS) process.on(s, onSignal)
  child.once('exit', done)
  child.once('close', done) // the only one of the two after a failed spawn
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
  const sandbox = prepareSandbox(o)
  let child
  try {
    child = spawn(o.bin || process.env.PI_BIN || 'pi', sessionArgs(o), {
      cwd: o.cwd,
      env: { ...process.env, ...o.env, ...sandbox?.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
  } catch (err) {
    sandbox?.removeAuth()
    throw err
  }
  const events = new EventEmitter()
  const norm = createNormalizer()
  if (sandbox) {
    removeAuthAtEnd(child, sandbox.removeAuth)
    // A failed spawn must end the attempt, not take the eval run (and its cleanup) down.
    child.on('error', (err) => events.emit('stderr', `pi adapter: ${err.message}\n`))
    child.stdin.on('error', () => {})
  }
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
