import type { SystemOneConfig } from "./config.js"
import { runHeuristics } from "./heuristics.js"
import { createReviewer, type FetchLike, httpTransport, type Reviewer, type Transport } from "./reviewer.js"
import { type Action, type Decision, type Finding, strictest, type Verdict } from "./types.js"

/**
 * The guard combines the well-known pattern checks and the System One model
 * into one verdict. The strictest finding wins: deny > escalate > allow.
 */
export interface Guard {
  readonly config: SystemOneConfig
  check(action: Action): Promise<Verdict>
  /** Last verdict for a tool call id (lets separate hooks share one review). */
  verdictFor(callID: string): Verdict | undefined
  /** Drop the cached verdict once a call has finished. */
  forget(callID: string): void
}

export interface GuardDeps {
  /** Full reviewer override (tests). */
  reviewer?: Reviewer
  /** Transport to the System One model. Default: HTTP. */
  transport?: Transport
  /** fetch for the default HTTP transport (tests). */
  fetch?: FetchLike
  now?: () => number
}

export function summarize(decision: Decision, findings: Finding[]): string {
  const flagged = findings.filter((f) => f.decision !== "allow")
  if (decision === "allow" || flagged.length === 0) return "System One: allowed"
  const reasons = [...new Set(flagged.map((f) => `${f.reason} [${f.category}]`))].join("; ")
  return decision === "deny"
    ? `System One flagged this action as dangerous: ${reasons}`
    : `System One flagged this action: ${reasons}`
}

export function createGuard(config: SystemOneConfig, deps: GuardDeps = {}): Guard {
  const reviewer = deps.reviewer ?? createReviewer(config, deps.transport ?? httpTransport(config, deps.fetch))
  const now = deps.now ?? (() => performance.now())
  const verdicts = new Map<string, Verdict>()
  const MAX_CACHED = 500

  const remember = (action: Action, verdict: Verdict) => {
    if (!action.callID) return
    verdicts.set(action.callID, verdict)
    if (verdicts.size > MAX_CACHED) verdicts.delete(verdicts.keys().next().value as string)
  }

  return {
    config,
    verdictFor: (callID) => verdicts.get(callID),
    forget: (callID) => void verdicts.delete(callID),

    async check(action) {
      const started = now()
      const finish = (findings: Finding[]): Verdict => {
        const decision = findings.reduce<Decision>((acc, f) => strictest(acc, f.decision), "allow")
        const verdict = {
          decision,
          findings,
          summary: summarize(decision, findings),
          durationMs: Math.round(now() - started),
        }
        remember(action, verdict)
        return verdict
      }

      if (!config.enabled || config.skipTools.includes(action.tool)) return finish([])

      const findings = runHeuristics(action)
      if (config.shortCircuit && findings.some((f) => f.decision === "deny")) return finish(findings)

      if (reviewer.enabled) {
        try {
          findings.push(...(await reviewer.review(action)))
        } catch (err) {
          findings.push({
            source: "model",
            category: "reviewer_unavailable",
            decision: config.failMode,
            reason: `System One reviewer unavailable (${err instanceof Error ? err.message : String(err)})`,
          })
        }
      }

      return finish(findings)
    },
  }
}
