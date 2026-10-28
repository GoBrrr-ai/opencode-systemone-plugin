/**
 * A small fake of the parts of OpenCode's v2 plugin context the guard uses.
 *
 * Permission semantics mirror packages/core/src/permission.ts:
 *   configured rule → (deny short-circuits) → `permission.evaluate` hooks → allow | deny | ask
 *   ask → a prompt is shown to the human (scripted here) → resolve, or reject
 *
 * Tool calls mirror packages/core/src/tool.ts: execute.before (may reject the
 * call) → the tool's own permission check → execute.after.
 */
import type { SystemOneContext } from "../src/plugin.js"

type Effect = "allow" | "deny" | "ask"
type Callback = (event: any) => unknown

export interface Prompt {
  action: string
  resources: string[]
  message?: string
  metadata?: Record<string, unknown>
  sourceID?: string
}

export interface FakeOptions {
  /** Configured permission rule per action. Default "allow". */
  rules?: Record<string, Effect>
  /** How the human answers each prompt. Default: approve. */
  human?: (prompt: Prompt) => "once" | "reject" | { feedback: string }
  /** Model text returned by experimental.generate.text. */
  generate?: (prompt: string) => string
}

export function createFakeOpenCode(opts: FakeOptions = {}) {
  const hooks = new Map<string, Callback[]>()
  const prompts: Prompt[] = []
  const generateCalls: string[] = []
  let ids = 0

  const register = (domain: string) => async (name: string, cb: Callback) => {
    const key = `${domain}.${name}`
    hooks.set(key, [...(hooks.get(key) ?? []), cb])
    return {
      dispose: async () =>
        void hooks.set(
          key,
          (hooks.get(key) ?? []).filter((c) => c !== cb),
        ),
    }
  }
  const trigger = async (key: string, event: unknown) => {
    for (const cb of hooks.get(key) ?? []) await cb(event)
    return event
  }

  const assert = async (input: {
    sessionID: string
    agent?: string
    action: string
    resources: readonly string[]
    metadata?: Record<string, unknown>
    source?: { type: "tool"; messageID: string; id: string }
  }) => {
    const configured = opts.rules?.[input.action] ?? "allow"
    if (configured === "deny") throw new Error(`Blocked by rule: ${input.action}`)
    const event = (await trigger("permission.evaluate", {
      ...input,
      resources: [...input.resources],
      effect: configured,
    })) as {
      effect: Effect
      message?: string
    }
    if (event.effect === "allow") return
    if (event.effect === "deny") throw new Error(event.message ?? `Denied: ${input.action}`)
    const prompt: Prompt = {
      action: input.action,
      resources: [...input.resources],
      message: event.message,
      metadata: input.metadata,
      sourceID: input.source?.id,
    }
    prompts.push(prompt)
    const answer = opts.human?.(prompt) ?? "once"
    if (answer === "reject") throw new Error("The user rejected permission to use this specific tool call.")
    if (typeof answer === "object") throw new Error(answer.feedback)
  }

  // Live event stream: subscribers receive events emitted after they subscribe.
  const subscribers = new Set<{ types?: readonly string[]; push: (e: unknown) => void }>()
  let subscriptions = 0
  const subscribe = (options: { types?: readonly string[]; signal?: AbortSignal } = {}) => {
    subscriptions++
    const queue: unknown[] = []
    let wake: (() => void) | undefined
    const sub = {
      types: options.types,
      push: (e: unknown) => {
        queue.push(e)
        wake?.()
      },
    }
    subscribers.add(sub)
    options.signal?.addEventListener("abort", () => {
      subscribers.delete(sub)
      wake?.()
    })
    return {
      async *[Symbol.asyncIterator]() {
        while (!options.signal?.aborted) {
          if (queue.length) yield queue.shift()
          else await new Promise<void>((r) => (wake = r))
        }
      },
    }
  }
  /** Publish an event to subscribers, then let them run (events are async, as in OpenCode). */
  const emit = async (type: string, data: Record<string, unknown>) => {
    for (const s of subscribers) if (!s.types || s.types.includes(type)) s.push({ type, data })
    await new Promise((r) => setTimeout(r, 0))
  }

  const ctx = {
    options: {},
    event: { subscribe },
    tool: { hook: register("tool") },
    permission: { hook: register("permission"), assert },
    shell: { hook: register("shell") },
    session: { hook: register("session") },
    experimental: {
      generate: {
        text: async ({ prompt }: { prompt: string }) => {
          generateCalls.push(prompt)
          return { text: opts.generate?.(prompt) ?? '{"decision":"allow"}' }
        },
      },
    },
  } as unknown as SystemOneContext

  /** Simulate the user sending a prompt. */
  const userPrompt = (sessionID: string, text: string) =>
    trigger("session.prompt", { sessionID, messageID: "msg_user", prompt: { text }, delivery: "immediate" })

  /**
   * Simulate one tool call end to end. `gated` = the tool performs its own
   * permission check (as shell/edit/webfetch do) under `action`.
   */
  const callTool = async (
    tool: string,
    input: unknown,
    opts2: { gated?: boolean; action?: string; output?: string; messageID?: string } = {},
  ) => {
    const id = `call_${++ids}`
    const base = { tool, sessionID: "ses_1", agent: "build", messageID: opts2.messageID ?? "msg_1", id, input }
    try {
      await trigger("tool.execute.before", base)
      if (opts2.gated) {
        await assert({
          sessionID: "ses_1",
          agent: "build",
          action: opts2.action ?? tool,
          resources: ["x"],
          source: { type: "tool", messageID: "msg_1", id },
        })
      }
    } catch (error) {
      await trigger("tool.execute.after", { ...base, status: "error", error })
      return { id, ran: false, error: error instanceof Error ? error.message : String(error) }
    }
    const result = {
      output: opts2.output ?? "ok",
      content: [{ type: "text", text: opts2.output ?? "ok" }],
      metadata: { output: opts2.output ?? "ok" },
    }
    await trigger("tool.execute.after", { ...base, status: "completed", result })
    return { id, ran: true, result }
  }

  const spawnShell = async (env: Record<string, string | undefined>) =>
    (await trigger("shell.create.before", { command: "true", cwd: "/", timeout: 0, shell: "bash", env })) as {
      env: Record<string, string | undefined>
    }

  return {
    ctx,
    prompts,
    generateCalls,
    callTool,
    userPrompt,
    spawnShell,
    emit,
    subscriptions: () => subscriptions,
    subscribers,
  }
}
