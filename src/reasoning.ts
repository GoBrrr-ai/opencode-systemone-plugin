/**
 * Collects what the model said in the current turn — its reasoning and any
 * visible text — from OpenCode's live session event stream, keyed by the
 * assistant message that the tool call belongs to.
 *
 * OpenCode passes that same id as `messageID` to `tool.execute.before`
 * (packages/core/src/session/runner/step.ts: messageID: assistantMessageID),
 * so a tool call is joined to exactly the reasoning that produced it.
 *
 * Events reach plugins asynchronously, so a tool call can arrive before its
 * reasoning's `ended` event. When reasoning for that message is known to be
 * in flight, `get` waits briefly for it to finish.
 */

export const REASONING_EVENT_TYPES = [
  "session.reasoning.started",
  "session.reasoning.delta",
  "session.reasoning.ended",
  "session.text.ended",
] as const

export interface SessionStreamEvent {
  type: string
  data?: {
    sessionID?: string
    assistantMessageID?: string
    ordinal?: number
    delta?: string
    text?: string
  }
}

interface Segment {
  kind: "reasoning" | "text"
  ordinal: number
  text: string
  done: boolean
}

interface MessageState {
  segments: Map<string, Segment>
  waiters: Set<() => void>
}

export interface ReasoningTracker {
  handle(event: SessionStreamEvent): void
  /** Reasoning + text for this assistant message, waiting up to `waitMs` for in-flight reasoning. */
  get(sessionID: string, messageID: string, waitMs: number): Promise<string | undefined>
}

export function createReasoningTracker(maxMessages = 50): ReasoningTracker {
  const messages = new Map<string, MessageState>()
  const key = (sessionID: string, messageID: string) => `${sessionID}\u0000${messageID}`

  const state = (k: string): MessageState => {
    let s = messages.get(k)
    if (!s) {
      s = { segments: new Map(), waiters: new Set() }
      messages.set(k, s)
      while (messages.size > maxMessages) messages.delete(messages.keys().next().value as string)
    }
    return s
  }

  const inFlight = (s: MessageState) => [...s.segments.values()].some((seg) => seg.kind === "reasoning" && !seg.done)

  const render = (s: MessageState): string | undefined => {
    const parts = [...s.segments.values()]
      .sort((a, b) => a.ordinal - b.ordinal)
      .filter((seg) => seg.text.trim())
      .map((seg) => (seg.kind === "reasoning" ? seg.text : `[visible reply] ${seg.text}`))
    return parts.length ? parts.join("\n") : undefined
  }

  return {
    handle(event) {
      const d = event.data
      if (!d?.sessionID || !d.assistantMessageID) return
      const s = state(key(d.sessionID, d.assistantMessageID))
      const ordinal = d.ordinal ?? 0
      const kind = event.type === "session.text.ended" ? "text" : "reasoning"
      const segKey = `${kind}:${ordinal}`
      const seg = s.segments.get(segKey) ?? { kind, ordinal, text: "", done: false }

      switch (event.type) {
        case "session.reasoning.started":
          break
        case "session.reasoning.delta":
          if (!seg.done) seg.text += d.delta ?? ""
          break
        case "session.reasoning.ended":
        case "session.text.ended":
          // The ended event carries the full value; it replaces any streamed fragments.
          seg.text = d.text ?? seg.text
          seg.done = true
          break
        default:
          return
      }
      s.segments.set(segKey, seg)
      if (!inFlight(s)) {
        for (const wake of s.waiters) wake()
        s.waiters.clear()
      }
    },

    async get(sessionID, messageID, waitMs) {
      const k = key(sessionID, messageID)
      // Let already-dispatched events land before deciding there is nothing to read.
      await new Promise((r) => setTimeout(r, 0))
      const s = messages.get(k)
      if (s && inFlight(s) && waitMs > 0) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(done, waitMs)
          function done() {
            clearTimeout(timer)
            s!.waiters.delete(done)
            resolve()
          }
          s.waiters.add(done)
        })
      }
      const current = messages.get(k)
      return current ? render(current) : undefined
    },
  }
}
