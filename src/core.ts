/** Runtime-agnostic core: usable without OpenCode (tests, other harnesses). */
export { type Backend, captureSecretEnv, loadConfig, SECRET_ENV_KEYS, type SystemOneConfig } from "./config.js"
export { createGuard, type Guard, type GuardDeps, summarize } from "./guard.js"
export { redactSecrets, runHeuristics, SECRET_RULES } from "./heuristics.js"
export { createLogger, type Logger, type LogLevel } from "./log.js"
export {
  METADATA_KEY,
  permissionAction,
  resourcesFor,
  type SetupDeps,
  type SystemOneContext,
  setupSystemOne,
} from "./plugin.js"
export {
  createReasoningTracker,
  REASONING_EVENT_TYPES,
  type ReasoningTracker,
  type SessionStreamEvent,
} from "./reasoning.js"
export {
  createReviewer,
  type FetchLike,
  formatAction,
  type GenerateLike,
  httpTransport,
  opencodeTransport,
  parseModelRef,
  parseReviewerResponse,
  type Reviewer,
  SYSTEM_PROMPT,
  type Transport,
} from "./reviewer.js"
export * from "./types.js"
