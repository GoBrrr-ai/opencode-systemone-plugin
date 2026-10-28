import type { Decision } from "./types.js"

/**
 * Runtime configuration. Everything comes from environment variables so the
 * plugin can be configured without touching opencode.json; plugin options
 * passed by OpenCode (v2 `context.options`) override the environment.
 */
export type Backend = "opencode" | "http"

export interface SystemOneConfig {
  /** Master switch. SYSTEMONE_ENABLED (default: true) */
  enabled: boolean
  /**
   * Where the System One model runs. SYSTEMONE_BACKEND.
   * - "opencode": a model from OpenCode's own configured providers, SYSTEMONE_MODEL="<provider>/<model>".
   * - "http": any OpenAI-compatible /chat/completions endpoint (SYSTEMONE_BASE_URL + SYSTEMONE_API_KEY).
   * Default: "http" when SYSTEMONE_BASE_URL or SYSTEMONE_API_KEY is set, otherwise "opencode".
   */
  backend: Backend
  /** OpenAI-compatible base URL (http backend). SYSTEMONE_BASE_URL (default: https://api.openai.com/v1) */
  baseUrl: string
  /** API key for the reviewer endpoint (http backend). SYSTEMONE_API_KEY */
  apiKey?: string
  /** Reviewer model. SYSTEMONE_MODEL. Without it only the well-known pattern checks run. */
  model?: string
  /** Reviewer request timeout. SYSTEMONE_TIMEOUT_MS (default: 15000) */
  timeoutMs: number
  /** What to do when the reviewer fails or times out. SYSTEMONE_FAIL_MODE (default: escalate) */
  failMode: Decision
  /**
   * Block "deny" verdicts outright instead of asking the human. SYSTEMONE_HARD_DENY (default: false).
   * By default every flagged action — escalate or deny — goes to the native OpenCode prompt.
   */
  hardDeny: boolean
  /** Tools that skip review entirely. SYSTEMONE_SKIP_TOOLS, comma-separated (default: none) */
  skipTools: string[]
  /** Skip the model call when heuristics already deny. SYSTEMONE_SHORT_CIRCUIT (default: true) */
  shortCircuit: boolean
  /** Redact detected secrets in tool output. SYSTEMONE_REDACT_OUTPUT (default: true) */
  redactOutput: boolean
  /** Max characters of tool args sent to the reviewer. SYSTEMONE_MAX_INPUT_CHARS (default: 16000) */
  maxInputChars: number
  /**
   * Send the model's reasoning for the current turn to the reviewer, so it can flag actions that
   * contradict it. SYSTEMONE_REVIEW_REASONING (default: true). Reasoning is redacted like everything else.
   */
  reviewReasoning: boolean
  /** Max wait for in-flight reasoning before reviewing a call. SYSTEMONE_REASONING_WAIT_MS (default: 500) */
  reasoningWaitMs: number
  /** JSONL audit trail of verdicts and human decisions. SYSTEMONE_AUDIT_LOG (default: off) */
  auditLog?: string
  /**
   * Review tool OUTPUT for prompt injection before the agent reads it. SYSTEMONE_REVIEW_OUTPUT
   * (default: false — a no-op). Adds one reviewer call per tool result when a model is configured.
   */
  reviewOutput: boolean
  /** Max characters of tool output sent to the reviewer (head + tail). SYSTEMONE_MAX_OUTPUT_CHARS (default: 20000) */
  maxOutputChars: number
  /** debug | info | warn | error. SYSTEMONE_LOG_LEVEL (default: info) */
  logLevel: "debug" | "info" | "warn" | "error"
}

type Env = Record<string, string | undefined>

const bool = (v: unknown, fallback: boolean): boolean => {
  if (v === undefined || v === null || v === "") return fallback
  if (typeof v === "boolean") return v
  return ["1", "true", "yes", "on"].includes(String(v).toLowerCase())
}

const int = (v: unknown, fallback: number): number => {
  const n = Number.parseInt(String(v ?? ""), 10)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

const nonNegative = (v: unknown, fallback: number): number => {
  const n = Number.parseInt(String(v ?? ""), 10)
  return Number.isFinite(n) && n >= 0 ? n : fallback
}

const decision = (v: unknown, fallback: Decision): Decision => {
  const s = String(v ?? "").toLowerCase()
  return s === "allow" || s === "escalate" || s === "deny" ? s : fallback
}

const list = (v: unknown): string[] =>
  Array.isArray(v)
    ? v.map(String)
    : String(v ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)

/** Env vars that must never reach processes the agent spawns. */
export const SECRET_ENV_KEYS = ["SYSTEMONE_API_KEY"] as const

let capturedSecrets: Partial<Record<(typeof SECRET_ENV_KEYS)[number], string>> | undefined

/**
 * Read the reviewer's secrets from process.env once and delete them, so
 * shells and subprocesses started by the agent don't inherit them (an agent
 * that can `echo $SYSTEMONE_API_KEY` can exfiltrate or misuse it). Later
 * calls return the captured values. Idempotent; safe if several adapters load.
 */
export function captureSecretEnv(env: Env = process.env): typeof capturedSecrets & object {
  if (!capturedSecrets) {
    capturedSecrets = {}
    for (const key of SECRET_ENV_KEYS) {
      const value = env[key]
      if (value) capturedSecrets[key] = value
      delete env[key]
    }
  }
  return capturedSecrets
}

/** Test helper: forget captured secrets. */
export function resetCapturedSecretEnv(): void {
  capturedSecrets = undefined
}

export function loadConfig(env: Env = process.env, options: Record<string, unknown> = {}): SystemOneConfig {
  // For the live process environment, use the captured (and scrubbed) secrets.
  const secrets = env === process.env ? captureSecretEnv(env) : {}
  const pick = (optKey: string, envKey: string) =>
    options[optKey] ?? env[envKey] ?? (secrets as Record<string, string | undefined>)[envKey]
  const level = String(pick("logLevel", "SYSTEMONE_LOG_LEVEL") ?? "info").toLowerCase()

  const baseUrlRaw = pick("baseUrl", "SYSTEMONE_BASE_URL") as string | undefined
  const backendRaw = String(pick("backend", "SYSTEMONE_BACKEND") ?? "").toLowerCase()
  const apiKey = (pick("apiKey", "SYSTEMONE_API_KEY") as string | undefined) || undefined
  // An explicit endpoint or key means an external reviewer; otherwise use OpenCode's own providers.
  const backend: Backend =
    backendRaw === "http" || backendRaw === "opencode" ? backendRaw : baseUrlRaw || apiKey ? "http" : "opencode"

  return {
    enabled: bool(pick("enabled", "SYSTEMONE_ENABLED"), true),
    backend,
    baseUrl: String(baseUrlRaw || "https://api.openai.com/v1").replace(/\/+$/, ""),
    apiKey,
    model: (pick("model", "SYSTEMONE_MODEL") as string | undefined) || undefined,
    timeoutMs: int(pick("timeoutMs", "SYSTEMONE_TIMEOUT_MS"), 15_000),
    failMode: decision(pick("failMode", "SYSTEMONE_FAIL_MODE"), "escalate"),
    hardDeny: bool(pick("hardDeny", "SYSTEMONE_HARD_DENY"), false),
    skipTools: list(pick("skipTools", "SYSTEMONE_SKIP_TOOLS")),
    shortCircuit: bool(pick("shortCircuit", "SYSTEMONE_SHORT_CIRCUIT"), true),
    redactOutput: bool(pick("redactOutput", "SYSTEMONE_REDACT_OUTPUT"), true),
    maxInputChars: int(pick("maxInputChars", "SYSTEMONE_MAX_INPUT_CHARS"), 16_000),
    reviewReasoning: bool(pick("reviewReasoning", "SYSTEMONE_REVIEW_REASONING"), true),
    reasoningWaitMs: nonNegative(pick("reasoningWaitMs", "SYSTEMONE_REASONING_WAIT_MS"), 500),
    auditLog: (pick("auditLog", "SYSTEMONE_AUDIT_LOG") as string | undefined) || undefined,
    reviewOutput: bool(pick("reviewOutput", "SYSTEMONE_REVIEW_OUTPUT"), false),
    maxOutputChars: int(pick("maxOutputChars", "SYSTEMONE_MAX_OUTPUT_CHARS"), 20_000),
    logLevel: (["debug", "info", "warn", "error"].includes(level) ? level : "info") as SystemOneConfig["logLevel"],
  }
}
