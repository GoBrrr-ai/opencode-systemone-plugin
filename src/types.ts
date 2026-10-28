/**
 * Shared types for the System One guard.
 */

/** What the guard decided to do with an action. Ordered from least to most strict. */
export type Decision = "allow" | "escalate" | "deny"

/** Why an action was flagged. Extend as new detectors are added. */
export type RiskCategory =
  | "malicious_code"
  | "secret_exposure"
  | "data_exfiltration"
  | "destructive_operation"
  | "privilege_escalation"
  | "persistence"
  | "prompt_injection"
  | "network_access"
  | "credential_access"
  | "reconnaissance"
  | "guard_tampering"
  | "reasoning_mismatch"
  | "reviewer_unavailable"
  | "other"

export const RISK_CATEGORIES: readonly RiskCategory[] = [
  "malicious_code",
  "secret_exposure",
  "data_exfiltration",
  "destructive_operation",
  "privilege_escalation",
  "persistence",
  "prompt_injection",
  "network_access",
  "credential_access",
  "reconnaissance",
  "guard_tampering",
  "reasoning_mismatch",
  "other",
]

/**
 * What the agent said around the action. Lets the reviewer spot actions
 * that are off-task or contradict the agent's own reasoning (a pattern seen
 * in the wild: a trace saying "no tools needed" followed by an upload).
 */
export interface ActionContext {
  /** Latest user request in the conversation. */
  task?: string
  /** Reasoning / text the model produced in the same turn before the call. */
  reasoning?: string
  /** Earlier tool calls in this turn, as "tool: summary" lines. */
  priorCalls?: string[]
}

/** A single LLM-initiated action awaiting review. */
export interface Action {
  /** Tool name as OpenCode reports it, e.g. "bash", "write", "edit", "webfetch". */
  tool: string
  /** Parsed tool arguments. */
  args: unknown
  sessionID?: string
  callID?: string
  /** Working directory, when known. */
  cwd?: string
  context?: ActionContext
}

/** One finding from a detector (heuristic or model). */
export interface Finding {
  source: "heuristic" | "model"
  category: RiskCategory
  decision: Decision
  reason: string
  /** Optional rule id for heuristic findings. */
  rule?: string
}

/** Final verdict for an action. */
export interface Verdict {
  decision: Decision
  findings: Finding[]
  /** Human-readable summary suitable for showing to the user or the agent. */
  summary: string
  /** Milliseconds spent reviewing. */
  durationMs: number
}

export const DECISION_RANK: Record<Decision, number> = {
  allow: 0,
  escalate: 1,
  deny: 2,
}

export function strictest(a: Decision, b: Decision): Decision {
  return DECISION_RANK[a] >= DECISION_RANK[b] ? a : b
}
