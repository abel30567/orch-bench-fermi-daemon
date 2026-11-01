// Session-mode attempts: the warm worker's own turn sequence in one live harness
// session (startSession), for behaviour a single drain cannot show: an emergency
// stop that interrupts a turn mid-task, a Teams message (a warm turn, not a queue
// task), and the session still answering afterwards. A scenario opts in with
//
//   "session": [ { "turn": "drain", "interruptAfterClaim": true }, { "turn": "stop" }, { "turn": "keepalive" } ]
//
// turn: drain | stop | teams | keepalive (texts below). A turn may be interrupted,
// as the control endpoint's POST /abort does, by calling the session's interrupt():
//   interruptAfterClaim: true   on the first Fermi tool call after a task_claim
//                               (whatever the model does next: bootstrap, reply, ask)
//   interruptAfterMs: n         n ms after the turn starts
//   interruptAfter: "<tool>"    as soon as the turn calls that tool
// whichever comes first. That turn's turn_end is marked `interrupted: true` so the
// runner does not count it as a harness failure.
import { EventEmitter } from 'node:events'
import { isFermiCall } from './assertions.mjs'

// The turn texts warm-worker.mjs sends (test/evals-control.test.mjs keeps them in sync).
export const TURNS = {
  drain: () =>
    'There are pending tasks in the queue. Claim and process every pending task now (claim one at a time, bootstrap, reply, complete), looping until task_claim returns empty. Then stop.',
  stop: ({ channel, chat }) =>
    `EMERGENCY STOP from the user — you were just interrupted. Do ONLY these steps, then stop:\n` +
    `(1) If DURING THIS TURN you claimed a task (its id is in your immediate context just above), call task_complete on THAT task id with status "failed" and result "stopped by user". Only that one task — do NOT call task_list to hunt for others, and do NOT touch older or unrelated tasks.\n` +
    `(2) channel_send a brief "🛑 Stopped." to channel "${channel}" chat_id "${chat}".\n` +
    `(3) Do NOT resume, retry, or redo the interrupted work.`,
  // The worker's last sentence names the owner's real chat; a placeholder stands in.
  teams: ({ sender, text }) =>
    `New message(s) from the Microsoft Teams "fermi-bridge" channel (Daniel's-agents test bridge — treat like a normal user chat):\n- From ${sender}: ${text}\n\n` +
    `Reply by running (Bash tool, directly on this Mac — do NOT use mac_shell for this): ~/fermi-daemon/tools/teams-send.sh 'your reply text' — single quotes, escape as needed; keep replies concise (they render as a Teams card). ` +
    `These messages are NOT queue tasks: do NOT call task_claim or task_complete for them. Use context_bootstrap only if you need user context (channel sl, chat_id D0EVAL is the same person: Eval Owner).`,
  keepalive: () => 'Keep-alive. Do not call any tools. Reply with exactly: OK',
}

const died = (detail) => ({ type: 'turn_end', ok: false, kind: 'unknown_error', detail, durationMs: 0, raw: null })

// One turn: send `text`, forward its events, interrupt as `t` says (see above); resolves with its turn_end.
function runTurn(session, text, t, emit) {
  return new Promise((resolve) => {
    let interrupted = false
    let claimed = false
    const interrupt = () => {
      if (interrupted) return
      interrupted = true
      session.interrupt()
    }
    const timer = t.interruptAfterMs != null ? setTimeout(interrupt, t.interruptAfterMs) : null
    const onEvent = (ev) => {
      if (ev.type === 'turn_end') {
        off()
        const end = interrupted ? { ...ev, interrupted: true } : ev
        emit(end)
        return resolve(end)
      }
      emit(ev)
      if (ev.type !== 'tool_call') return
      if (t.interruptAfter && ev.name === t.interruptAfter) interrupt()
      if (t.interruptAfterClaim && isFermiCall(ev)) {
        if (claimed) interrupt()
        else claimed = ev.name === 'task_claim'
      }
    }
    const onExit = (code) => {
      off()
      const end = died(`session exited (${code}) mid-turn`)
      emit(end)
      resolve(end)
    }
    const off = () => {
      clearTimeout(timer)
      session.events.off('event', onEvent)
      session.events.off('exit', onExit)
    }
    session.events.on('event', onEvent)
    session.events.on('exit', onExit)
    session.send(text)
  })
}

// Same handle shape as an adapter's runOnce: { events, done, close }.
export function runSession(harness, opts, { turns, inbound }) {
  const events = new EventEmitter()
  const all = []
  const emit = (ev) => {
    all.push(ev)
    events.emit('event', ev)
  }
  let session = null
  let closed = false
  const done = (async () => {
    await null // let the caller attach listeners first
    session = harness.startSession(opts)
    session.events.on('raw', (line) => events.emit('raw', line))
    session.events.on('stderr', (s) => events.emit('stderr', s))
    let outcome = null
    for (const [i, t] of turns.entries()) {
      if (closed) break
      if (!session.alive) {
        emit((outcome = died(`session died before turn ${i + 1} (${t.turn})`)))
        break
      }
      outcome = await runTurn(session, TURNS[t.turn](inbound), t, emit)
    }
    session.close()
    return { code: outcome?.ok ? 0 : 1, outcome, events: all, stderr: '' }
  })()
  return {
    events,
    done,
    close: (signal) => {
      closed = true
      session?.close(signal)
    },
  }
}
