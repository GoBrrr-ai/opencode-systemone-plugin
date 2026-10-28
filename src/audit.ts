import { appendFile, mkdir } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { redactSecrets } from "./heuristics.js"
import type { Logger } from "./log.js"
import type { Decision, RiskCategory, Verdict } from "./types.js"

/**
 * Append-only JSONL audit trail of every System One verdict and every human
 * decision on a flagged action.
 *
 * - Off unless SYSTEMONE_AUDIT_LOG is set.
 * - Arguments are redacted and truncated; the file is created owner-only (0600).
 * - Writes are serialized and never throw: a broken log must not block the agent.
 */

export type Outcome =
  /** Ran without a System One prompt. */
  | "allowed"
  /** Human approved in the native prompt. */
  | "approved"
  /** Human rejected, gave feedback, or a configured rule denied it. */
  | "rejected"
  /** Blocked without asking (SYSTEMONE_HARD_DENY). */
  | "blocked"

export interface AuditRecord {
  ts: string
  event: "verdict" | "outcome"
  /** "call" = the tool call itself; "output" = what the tool returned. */
  stage: "call" | "output"
  sessionID: string
  callID: string
  tool: string
  decision?: Decision
  categories?: RiskCategory[]
  sources?: string[]
  summary?: string
  durationMs?: number
  args?: string
  outcome?: Outcome
  detail?: string
}

export interface AuditLog {
  verdict(input: {
    sessionID: string
    callID: string
    tool: string
    stage?: "call" | "output"
    args: unknown
    verdict: Verdict
  }): void
  outcome(input: {
    sessionID: string
    callID: string
    tool: string
    stage?: "call" | "output"
    outcome: Outcome
    detail?: string
  }): void
  /** Resolves once every queued write has been attempted. */
  flush(): Promise<void>
}

const MAX_ARGS_CHARS = 2_000

function serializeArgs(args: unknown): string {
  let text: string
  try {
    text = typeof args === "string" ? args : JSON.stringify(args)
  } catch {
    text = String(args)
  }
  text = redactSecrets(text ?? "").text
  return text.length > MAX_ARGS_CHARS ? `${text.slice(0, MAX_ARGS_CHARS)}…[truncated]` : text
}

/** Resolve the configured path, expanding a leading `~` to the home directory. */
export function resolveAuditPath(path: string, home: string = homedir()): string {
  if (path === "~") return home
  if (path.startsWith("~/")) return join(home, path.slice(2))
  return resolve(path)
}

export function createAuditLog(path: string | undefined, log: Logger, now: () => Date = () => new Date()): AuditLog {
  if (!path) {
    return { verdict() {}, outcome() {}, flush: async () => {} }
  }

  const file = resolveAuditPath(path)
  let queue: Promise<void> = mkdir(dirname(file), { recursive: true }).then(
    () => undefined,
    () => undefined,
  )
  let warned = false

  const write = (record: AuditRecord) => {
    const line = `${JSON.stringify(record)}\n`
    queue = queue.then(() =>
      appendFile(file, line, { mode: 0o600 }).catch((err: unknown) => {
        if (warned) return
        warned = true
        log.warn(`audit log write failed (${file}): ${err instanceof Error ? err.message : String(err)}`)
      }),
    )
  }

  return {
    verdict({ sessionID, callID, tool, stage = "call", args, verdict }) {
      const flagged = verdict.findings.filter((f) => f.decision !== "allow")
      write({
        ts: now().toISOString(),
        event: "verdict",
        stage,
        sessionID,
        callID,
        tool,
        decision: verdict.decision,
        categories: [...new Set(flagged.map((f) => f.category))],
        sources: [...new Set(flagged.map((f) => (f.rule ? `${f.source}:${f.rule}` : f.source)))],
        summary: verdict.summary,
        durationMs: verdict.durationMs,
        args: serializeArgs(args),
      })
    },
    outcome({ sessionID, callID, tool, stage = "call", outcome, detail }) {
      write({
        ts: now().toISOString(),
        event: "outcome",
        stage,
        sessionID,
        callID,
        tool,
        outcome,
        ...(detail ? { detail: redactSecrets(detail).text.slice(0, 500) } : {}),
      })
    },
    flush: () => queue,
  }
}
