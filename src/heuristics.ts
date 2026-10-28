import type { Action, Decision, Finding, RiskCategory } from "./types.js"

/**
 * Fast, deterministic pre-checks that run before (and independently of) the
 * System One model. They catch the obvious cases for free and keep working
 * when the reviewer is down. Keep rules high-precision: the model handles nuance.
 */

interface Rule {
  id: string
  category: RiskCategory
  decision: Decision
  reason: string
  pattern: RegExp
}

/** Secret formats. Shared with the redactor. */
export const SECRET_RULES: Rule[] = [
  {
    id: "secret.aws_access_key",
    category: "secret_exposure",
    decision: "escalate",
    reason: "AWS access key id",
    pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  },
  {
    id: "secret.github_token",
    category: "secret_exposure",
    decision: "escalate",
    reason: "GitHub token",
    pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})\b/g,
  },
  {
    id: "secret.anthropic_key",
    category: "secret_exposure",
    decision: "escalate",
    reason: "Anthropic API key",
    pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g,
  },
  {
    id: "secret.openai_key",
    category: "secret_exposure",
    decision: "escalate",
    reason: "OpenAI-style API key",
    pattern: /\bsk-(?!ant-)(?:proj-)?[A-Za-z0-9_-]{32,}\b/g,
  },
  {
    id: "secret.slack_token",
    category: "secret_exposure",
    decision: "escalate",
    reason: "Slack token",
    pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
  },
  {
    id: "secret.google_api_key",
    category: "secret_exposure",
    decision: "escalate",
    reason: "Google API key",
    pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g,
  },
  {
    id: "secret.stripe_live",
    category: "secret_exposure",
    decision: "escalate",
    reason: "Stripe live key",
    pattern: /\b[rs]k_live_[0-9A-Za-z]{20,}\b/g,
  },
  {
    id: "secret.private_key",
    category: "secret_exposure",
    decision: "escalate",
    reason: "Private key material",
    pattern: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY(?: BLOCK)?-----/g,
  },
]

/** Shell / code patterns. Checked against the serialized action. */
const COMMAND_RULES: Rule[] = [
  // Outright destructive — deny without asking.
  {
    id: "cmd.rm_root",
    category: "destructive_operation",
    decision: "deny",
    reason: "Recursive delete of root or home",
    pattern:
      /\brm\s+(?:(?:-[a-zA-Z]+|--recursive|--force|--no-preserve-root|--)\s+)+["']?(?:\/|~|\$HOME|\$\{HOME\})\/?\*?["']?(?=\s|$|[;&|)])/,
  },
  {
    id: "cmd.fork_bomb",
    category: "malicious_code",
    decision: "deny",
    reason: "Fork bomb",
    pattern: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/,
  },
  {
    id: "cmd.mkfs",
    category: "destructive_operation",
    decision: "deny",
    reason: "Filesystem format",
    pattern: /\bmkfs(?:\.\w+)?\s+\/dev\//,
  },
  {
    id: "cmd.dd_device",
    category: "destructive_operation",
    decision: "deny",
    reason: "Raw write to block device",
    pattern: /\bdd\b[^|;&]*\bof=\/dev\/(?!null\b)/,
  },

  // Suspicious — ask a human.
  {
    id: "cmd.pipe_to_shell",
    category: "malicious_code",
    decision: "escalate",
    reason: "Downloads and executes remote code",
    pattern: /\b(?:curl|wget)\b[^|;&]*\|\s*(?:sudo\s+)?(?:ba|z|k|da)?sh\b/,
  },
  {
    id: "cmd.decode_exec",
    category: "malicious_code",
    decision: "escalate",
    reason: "Decodes and executes an obfuscated payload",
    pattern: /base64\s+(?:-d|--decode)[^|;&]*\|\s*(?:ba|z)?sh\b|\beval\s*\(\s*(?:atob|Buffer\.from)\(/,
  },
  {
    id: "cmd.reverse_shell",
    category: "malicious_code",
    decision: "escalate",
    reason: "Reverse-shell pattern",
    pattern: /\/dev\/tcp\/|\bnc\b[^|;&]*\s-e\s|\bsocat\b[^|;&]*exec:/i,
  },
  {
    id: "cmd.sudo",
    category: "privilege_escalation",
    decision: "escalate",
    reason: "Privilege escalation via sudo/su",
    pattern: /(?:^|[\s;&|(])(?:sudo|su|doas)\s/,
  },
  {
    id: "cmd.chmod_world",
    category: "privilege_escalation",
    decision: "escalate",
    reason: "World-writable or setuid permissions",
    pattern: /\bchmod\s+(?:-R\s+)?(?:[0-7]?777|[ugoa]*\+s)\b/,
  },
  {
    id: "cmd.persistence",
    category: "persistence",
    decision: "escalate",
    reason: "Modifies shell startup, cron or SSH authorized keys",
    pattern: /(?:>>?|tee\s+-a)\s*~?\/?[^\s]*(?:\.bashrc|\.zshrc|\.profile|authorized_keys)\b|\bcrontab\s+(?!-l\b)/,
  },
  {
    id: "cmd.history_wipe",
    category: "malicious_code",
    decision: "escalate",
    reason: "Clears shell history / covers tracks",
    pattern: /\bhistory\s+-c\b|\bunset\s+HISTFILE\b/,
  },
  {
    id: "cmd.read_secrets",
    category: "secret_exposure",
    decision: "escalate",
    reason: "Reads credential files",
    pattern:
      /(?:^|[\s"'=/])(?:\.env(?:\.[\w-]+)?|\.ssh\/id_[\w]+|\.aws\/credentials|\.netrc|\.npmrc|\.pypirc|\.docker\/config\.json)(?:["'\s]|$)/,
  },
  {
    id: "cmd.env_dump",
    category: "secret_exposure",
    decision: "escalate",
    reason: "Dumps the environment (may leak secrets)",
    pattern: /(?:^|[\s;&|"'])(?:printenv|env)\s*(?:$|[|>;&"'])/,
  },
  {
    id: "cmd.git_force_push",
    category: "destructive_operation",
    decision: "escalate",
    reason: "Force-pushes git history",
    pattern: /\bgit\s+push\b[^;&|]*(?:\s--force(?:-with-lease)?\b|\s-f\b)/,
  },
]

function stringify(value: unknown): string {
  if (typeof value === "string") return value
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

/** Collect the strings worth scanning: the full args, plus `command` unescaped. */
function scanTargets(action: Action): string[] {
  const targets = [stringify(action.args)]
  const args = action.args as Record<string, unknown> | null
  if (args && typeof args === "object") {
    for (const key of ["command", "content", "newString", "new_string", "filePath", "path", "url"]) {
      const v = args[key]
      if (typeof v === "string") targets.push(v)
    }
  }
  return targets
}

export function runHeuristics(action: Action): Finding[] {
  const targets = scanTargets(action)
  const findings: Finding[] = []
  for (const rule of [...COMMAND_RULES, ...SECRET_RULES]) {
    const re = new RegExp(rule.pattern.source, rule.pattern.flags.replace("g", ""))
    if (targets.some((t) => re.test(t))) {
      findings.push({
        source: "heuristic",
        rule: rule.id,
        category: rule.category,
        decision: rule.decision,
        reason: rule.reason,
      })
    }
  }
  return findings
}

/** Replace any detected secret with a placeholder. Used on tool output. */
/**
 * Redaction-only patterns. These widen what is removed from text (tool
 * output, reviewer input, audit log) without making the guard flag more
 * actions, so they can afford to be broader than SECRET_RULES.
 */

/** A whole PEM private-key block, header to footer, so no key material survives. */
const PRIVATE_KEY_BLOCK =
  /-----BEGIN ((?:RSA |EC |OPENSSH |DSA |ENCRYPTED |PGP )?PRIVATE KEY(?: BLOCK)?)-----[\s\S]*?-----END \1-----/g

/** JSON Web Tokens (header.payload.signature, base64url). */
const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g

/**
 * `name = value` / `"name": "value"` where the name ends in a credential word
 * (GITHUB_TOKEN, db_password, client_secret, apiKey, AWS_ACCESS_KEY…).
 * The name must *end* with the word, so `tokenizer=` or `secret_name=` don't match.
 */
const CREDENTIAL_ASSIGNMENT =
  /\b([A-Za-z0-9_.-]*?(?:secret|token|passw(?:or)?d|pwd|api[_-]?key|access[_-]?key|private[_-]?key))\b(\s*["']?\s*[:=]\s*["']?)([^\s"'`,;]{8,})/gi

/** Values that are references or placeholders, not secrets. */
function isPlaceholder(value: string): boolean {
  return (
    /^(?:\$|\{\{|<|\[REDACTED|process\.env|os\.environ|env\(|%)/i.test(value) ||
    /^\*+$/.test(value) ||
    /^\d+$/.test(value) ||
    /^(?:undefined|null|true|false|changeme|placeholder|your[_-].*|xxx+)$/i.test(value)
  )
}

const globalize = (re: RegExp) => new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`)

export function redactSecrets(text: string): { text: string; count: number } {
  let count = 0
  let out = text.replace(PRIVATE_KEY_BLOCK, () => {
    count++
    return "[REDACTED:private_key]"
  })
  for (const rule of SECRET_RULES) {
    out = out.replace(globalize(rule.pattern), () => {
      count++
      return `[REDACTED:${rule.id.replace("secret.", "")}]`
    })
  }
  out = out.replace(JWT, () => {
    count++
    return "[REDACTED:jwt]"
  })
  out = out.replace(CREDENTIAL_ASSIGNMENT, (match, name: string, sep: string, value: string) => {
    if (isPlaceholder(value)) return match
    count++
    return `${name}${sep}[REDACTED:credential]`
  })
  return { text: out, count }
}
