import type { Plugin } from "@opencode/plugin"
import { createAuditLog } from "./audit.js"
import { loadConfig, SECRET_ENV_KEYS, type SystemOneConfig } from "./config.js"
import { createGuard, type Guard } from "./guard.js"
import { redactSecrets } from "./heuristics.js"
import { createLogger, type Logger } from "./log.js"
import { createOutputReviewer, UNTRUSTED_NOTE, WITHHELD_NOTICE } from "./output-review.js"
import {
  createReasoningTracker,
  REASONING_EVENT_TYPES,
  type ReasoningTracker,
  type SessionStreamEvent,
} from "./reasoning.js"
import { httpTransport, opencodeTransport, type Transport } from "./reviewer.js"
import type { Verdict } from "./types.js"

/**
 * System One guard for OpenCode v2 (`@opencode/plugin`).
 *
 * Every tool call the agent makes is reviewed before it runs:
 *
 *   tool.execute.before ─► well-known patterns ─► System One model ─► verdict
 *        allow    → the call runs (OpenCode's own permission rules still apply)
 *        flagged  → native OpenCode permission prompt (TUI / Web), with the
 *                   reviewer's reason; the human allows once or rejects
 *        deny + SYSTEMONE_HARD_DENY → blocked without asking
 *
 * The prompt is raised with `permission.assert` under the tool's own action
 * and the tool call as source, so OpenCode renders its normal rich card
 * (command, diff, URL). A `permission.evaluate` hook makes sure that prompt
 * is always shown (even if the user's rules would auto-allow the action) and
 * attaches the reviewer's reason as the request message.
 *
 * The plugin only ever makes OpenCode *stricter*. The single exception is
 * de-duplication: once the human has approved a flagged call, the tool's own
 * permission request for that same call and action is not asked twice.
 */

export const METADATA_KEY = "systemone"

/** Map a tool to the permission action OpenCode uses for it (and renders a card for). */
export function permissionAction(tool: string): string {
  return tool === "write" || tool === "patch" || tool === "apply_patch" ? "edit" : tool
}

/** Best-effort resource list for the prompt; the card itself renders the tool call's input. */
export function resourcesFor(tool: string, input: unknown): string[] {
  const args = (input && typeof input === "object" ? input : {}) as Record<string, unknown>
  for (const key of ["command", "filePath", "file_path", "path", "url", "pattern", "query"]) {
    const value = args[key]
    if (typeof value === "string" && value) return [value]
  }
  return [tool]
}

interface Flagged {
  verdict: Verdict
  action: string
  /** True only while our own permission.assert is in flight. */
  asking: boolean
  /** Set once the human approved this call. */
  approved: boolean
}

/** The pieces of the OpenCode plugin context this plugin uses (lets tests supply a fake). */
export type SystemOneContext = Pick<
  Plugin.Context,
  "options" | "tool" | "permission" | "shell" | "session" | "event"
> & {
  readonly experimental: Pick<Plugin.Context["experimental"], "generate">
}

export interface SetupDeps {
  /** Override the reviewer transport (tests). */
  transport?: Transport
  logger?: Logger
  env?: Record<string, string | undefined>
}

function selectTransport(config: SystemOneConfig, ctx: SystemOneContext): Transport | undefined {
  if (!config.model) return undefined
  return config.backend === "opencode" ? opencodeTransport(config, ctx.experimental.generate) : httpTransport(config)
}

type Stage = "call" | "output"

type MutableResult = { output?: unknown; content?: unknown; metadata?: unknown }

/** The text a model will read from a tool result. */
export function outputText(result: MutableResult): string {
  const parts: string[] = []
  if (typeof result.output === "string") parts.push(result.output)
  if (Array.isArray(result.content)) {
    for (const part of result.content as Array<{ type?: string; text?: unknown }>) {
      if (part?.type === "text" && typeof part.text === "string" && part.text !== result.output) parts.push(part.text)
    }
  }
  return parts.join("\n")
}

const OUTPUT_METADATA_KEYS = ["output", "stdout", "stderr", "preview"]

/** Replace everything the model could read with a notice. */
export function withhold(result: MutableResult): void {
  if (typeof result.output === "string") result.output = WITHHELD_NOTICE
  result.content = [{ type: "text", text: WITHHELD_NOTICE }]
  if (result.metadata && typeof result.metadata === "object") {
    const meta = result.metadata as Record<string, unknown>
    for (const key of OUTPUT_METADATA_KEYS) if (key in meta) meta[key] = WITHHELD_NOTICE
  }
}

/** Keep the output but put an "untrusted data" note in front of it. */
export function annotateUntrusted(result: MutableResult): void {
  if (typeof result.output === "string") result.output = UNTRUSTED_NOTE + result.output
  if (Array.isArray(result.content)) result.content = [{ type: "text", text: UNTRUSTED_NOTE.trim() }, ...result.content]
}

/**
 * Redact secrets in place. Only rewrites fields that already exist as strings,
 * and only when something was actually removed: OpenCode encodes the result
 * after this hook, and introducing keys (even `undefined` ones) can make that
 * encoding fail, which loses the tool result entirely (found by the e2e test).
 */
export function redactResult(result: MutableResult): number {
  let count = 0
  const scrubField = (holder: Record<string, unknown>, key: string) => {
    if (!Object.hasOwn(holder, key) || typeof holder[key] !== "string") return
    const r = redactSecrets(holder[key] as string)
    if (r.count === 0) return
    count += r.count
    holder[key] = r.text
  }
  scrubField(result as Record<string, unknown>, "output")
  if (Array.isArray(result.content)) {
    for (const part of result.content as Array<Record<string, unknown>>) {
      if (part && part.type === "text") scrubField(part, "text")
    }
  }
  if (result.metadata && typeof result.metadata === "object") {
    for (const key of OUTPUT_METADATA_KEYS) scrubField(result.metadata as Record<string, unknown>, key)
  }
  return count
}

function rejectionMessage(verdict: Verdict, err: unknown): string {
  // Covers a plain rejection, a rejection with feedback, and a configured deny rule.
  const detail = err instanceof Error && err.message ? ` Details: ${err.message}` : ""
  return (
    `This action was not approved after System One flagged it (${verdict.summary}).${detail} ` +
    "Do not retry it or attempt an equivalent action; ask the user how to proceed."
  )
}

/**
 * Follow the session event stream so each tool call can be reviewed together
 * with the reasoning that produced it. Returns a stop function.
 */
function followReasoning(ctx: SystemOneContext, tracker: ReasoningTracker, log: Logger): () => void {
  const controller = new AbortController()
  void (async () => {
    const events = ctx.event.subscribe({ types: [...REASONING_EVENT_TYPES], signal: controller.signal })
    for await (const event of events) tracker.handle(event as SessionStreamEvent)
  })().catch((err: unknown) => {
    if (!controller.signal.aborted)
      log.warn(`reasoning stream stopped: ${err instanceof Error ? err.message : String(err)}`)
  })
  return () => controller.abort()
}

export async function setupSystemOne(
  ctx: SystemOneContext,
  deps: SetupDeps = {},
): Promise<{ guard: Guard; dispose: () => void; flush: () => Promise<void> } | undefined> {
  const config = loadConfig(deps.env ?? process.env, ctx.options as Record<string, unknown>)
  const log = deps.logger ?? createLogger(config.logLevel)
  if (!config.enabled) {
    log.info("disabled via SYSTEMONE_ENABLED")
    return undefined
  }

  const transport = deps.transport ?? selectTransport(config, ctx)
  const guard = createGuard(config, transport ? { transport } : {})
  if (!config.model) log.warn("SYSTEMONE_MODEL not set — only well-known pattern checks will run")
  if (config.backend === "opencode" && config.apiKey) {
    log.warn("SYSTEMONE_API_KEY is ignored with SYSTEMONE_BACKEND=opencode (OpenCode's provider credentials are used)")
  }
  if (config.backend === "http" && config.model && !config.apiKey) {
    log.warn("SYSTEMONE_API_KEY not set for the http backend — fine for local endpoints, required for hosted ones")
  }

  const audit = createAuditLog(config.auditLog, log)
  // Off by default: without SYSTEMONE_REVIEW_OUTPUT the after-hook only redacts.
  const outputReviewer = config.reviewOutput ? createOutputReviewer(config, transport) : undefined

  const flagged = new Map<string, Flagged>()
  /** Latest user request per session, as context for the reviewer. */
  const tasks = new Map<string, string>()
  /** Recent calls per session, as context for the reviewer. */
  const recent = new Map<string, string[]>()

  // Reasoning only matters to the model reviewer; the pattern checks don't read it.
  const tracker = config.model && config.reviewReasoning ? createReasoningTracker() : undefined
  const stopReasoning = tracker ? followReasoning(ctx, tracker, log) : () => {}

  // Keep the reviewer's credentials out of every shell the agent spawns.
  await ctx.shell.hook("create.before", (event) => {
    for (const key of SECRET_ENV_KEYS) delete event.env[key]
  })

  await ctx.session.hook("prompt", (event) => {
    const text = event.prompt.text?.trim()
    if (!text) return
    tasks.set(event.sessionID, text)
    recent.set(event.sessionID, [])
  })

  await ctx.tool.hook("execute.before", async (event) => {
    const prior = recent.get(event.sessionID) ?? []
    const reasoning = tracker ? await tracker.get(event.sessionID, event.messageID, config.reasoningWaitMs) : undefined
    const verdict = await guard.check({
      tool: event.tool,
      args: event.input,
      sessionID: event.sessionID,
      callID: event.id,
      context: { task: tasks.get(event.sessionID), reasoning, priorCalls: prior.slice(-10) },
    })
    prior.push(`${event.tool}: ${JSON.stringify(event.input ?? null).slice(0, 200)}`)
    recent.set(event.sessionID, prior.slice(-20))

    const call = { sessionID: event.sessionID, callID: event.id, tool: event.tool }
    audit.verdict({ ...call, args: event.input, verdict })

    if (verdict.decision === "allow") {
      audit.outcome({ ...call, outcome: "allowed" })
      return
    }
    log.warn(`${verdict.decision} ${event.tool} ${event.id}: ${verdict.summary}`)

    if (verdict.decision === "deny" && config.hardDeny) {
      audit.outcome({ ...call, outcome: "blocked" })
      throw new Error(`${verdict.summary}. Blocked by policy; do not retry this action or an equivalent one.`)
    }

    const answer = await askHuman(event, verdict, "call")
    if (!answer.approved) throw new Error(rejectionMessage(verdict, answer.error))
  })

  /**
   * Raise the native OpenCode permission prompt for a flagged call or output and
   * wait for the human. Never throws; the caller decides what a rejection means.
   */
  async function askHuman(
    event: { sessionID: string; agent: string; messageID: string; id: string; tool: string; input: unknown },
    verdict: Verdict,
    stage: Stage,
  ): Promise<{ approved: boolean; error?: unknown }> {
    const call = { sessionID: event.sessionID, callID: event.id, tool: event.tool, stage }
    const action = permissionAction(event.tool)
    const entry: Flagged = { verdict, action, asking: true, approved: false }
    flagged.set(event.id, entry)
    try {
      await ctx.permission.assert({
        sessionID: event.sessionID as never,
        agent: event.agent as never,
        action,
        resources: stage === "output" ? [`output of ${event.tool}`] : resourcesFor(event.tool, event.input),
        // Nothing to save: an "always" reply must not whitelist future flagged calls.
        save: [],
        metadata: {
          [METADATA_KEY]: {
            stage,
            decision: verdict.decision,
            summary: verdict.summary,
            categories: [...new Set(verdict.findings.filter((f) => f.decision !== "allow").map((f) => f.category))],
          },
        },
        source: { type: "tool", messageID: event.messageID, id: event.id },
      })
    } catch (error) {
      flagged.delete(event.id)
      audit.outcome({ ...call, outcome: "rejected", detail: error instanceof Error ? error.message : String(error) })
      return { approved: false, error }
    } finally {
      entry.asking = false
    }
    entry.approved = true
    audit.outcome({ ...call, outcome: "approved" })
    log.info(`${event.tool} ${event.id}: ${stage} approved by user`)
    return { approved: true }
  }

  /** Review what a tool returned before the agent's model reads it. */
  async function reviewOutput(
    event: { sessionID: string; agent: string; messageID: string; id: string; tool: string; input: unknown },
    result: MutableResult,
  ): Promise<void> {
    if (!outputReviewer) return
    const text = outputText(result)
    if (!text.trim()) return
    const verdict = await outputReviewer.check({
      tool: event.tool,
      args: event.input,
      output: text,
      task: tasks.get(event.sessionID),
    })
    const call = { sessionID: event.sessionID, callID: event.id, tool: event.tool, stage: "output" as const }
    audit.verdict({ ...call, args: event.input, verdict })

    if (verdict.decision === "allow") {
      audit.outcome({ ...call, outcome: "allowed" })
      return
    }
    log.warn(`output ${verdict.decision} ${event.tool} ${event.id}: ${verdict.summary}`)

    if (verdict.decision === "deny" && config.hardDeny) {
      audit.outcome({ ...call, outcome: "blocked" })
      withhold(result)
      return
    }
    const answer = await askHuman(event, verdict, "output")
    if (answer.approved) annotateUntrusted(result)
    else withhold(result)
  }

  await ctx.permission.hook("evaluate", (event) => {
    const sourceID = event.source?.type === "tool" ? event.source.id : undefined
    const entry = sourceID ? flagged.get(sourceID) : undefined
    if (!entry) return

    // Our own escalation: always prompt, whatever the configured rules say.
    if (entry.asking && event.metadata?.[METADATA_KEY]) {
      event.effect = "ask"
      event.message = entry.verdict.summary
      return
    }

    // The tool's own request for the same call and action, after the human already approved it.
    if (entry.approved && event.action === entry.action && event.effect === "ask") {
      event.effect = "allow"
    }
  })

  await ctx.tool.hook("execute.after", async (event) => {
    try {
      if (event.status !== "completed") return
      const result = event.result as MutableResult
      if (config.redactOutput) {
        const count = redactResult(result)
        if (count > 0) log.warn(`redacted ${count} secret(s) from ${event.tool} output (${event.id})`)
      }
      // Reviewed after redaction, so the reviewer never sees the secrets either.
      if (!config.skipTools.includes(event.tool)) await reviewOutput(event, result)
    } finally {
      flagged.delete(event.id)
      guard.forget(event.id)
    }
  })

  log.info(
    `active (reviewer: ${config.model ? `${config.backend}:${config.model}` : "patterns only"}, ` +
      `reasoning: ${tracker ? "on" : "off"}, output review: ${outputReviewer ? "on" : "off"}, ` +
      `fail mode: ${config.failMode}, hard deny: ${config.hardDeny})`,
  )
  return {
    guard,
    flush: audit.flush,
    dispose: () => {
      stopReasoning()
      void audit.flush()
    },
  }
}

/**
 * The plugin. `Plugin.define` is an identity function, so a typed object literal
 * is equivalent; importing only types keeps the published package free of any
 * runtime dependency on `@opencode/plugin`.
 */
const plugin: Plugin.Plugin = {
  id: "systemone",
  setup: async (ctx) => {
    const instance = await setupSystemOne(ctx)
    return instance?.dispose
  },
}

export default plugin
