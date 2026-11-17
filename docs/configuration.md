# Configuration reference

Every setting can be given in two ways:

- **Plugin options** in `opencode.json` (recommended): they travel with your config and take effect when
  OpenCode loads the plugin.
- **Environment variables** (`SYSTEMONE_*`): handy for secrets and for CI. OpenCode 2 runs a background
  service, so run `opencode service restart` after changing them.

If both are set, **the plugin option wins**.

```jsonc
// opencode.json
{
  "plugins": [
    {
      "package": "@narandill/opencode-systemone-plugin",
      "options": {
        "model": "anthropic/claude-haiku-4-5",
        "reviewOutput": true,
        "auditLog": "~/.local/state/systemone/audit.jsonl"
      }
    }
  ]
}
```

> [!IMPORTANT]
> Keep secrets out of `opencode.json`. Set `SYSTEMONE_API_KEY` in your environment instead. The plugin reads
> it once and removes it from the environment, so commands the agent runs can never see it.

## All options

### Reviewer

| Option      | Environment variable   | Default                     | Description                                                                                                                                                 |
| ----------- | ---------------------- | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `model`     | `SYSTEMONE_MODEL`      | —                           | The System One reviewer model. For `opencode`: `"<provider>/<model>[#variant]"`. For `http`: the id your endpoint expects. **Unset → pattern checks only.** |
| `backend`   | `SYSTEMONE_BACKEND`    | see below                   | `opencode` uses a model from your OpenCode providers (no extra key). `http` uses any OpenAI-compatible `/chat/completions` endpoint.                        |
| `baseUrl`   | `SYSTEMONE_BASE_URL`   | `https://api.openai.com/v1` | Endpoint for the `http` backend.                                                                                                                            |
| `apiKey`    | `SYSTEMONE_API_KEY`    | —                           | Bearer token for the `http` backend. Prefer the environment variable.                                                                                       |
| `timeoutMs` | `SYSTEMONE_TIMEOUT_MS` | `15000`                     | Reviewer request timeout.                                                                                                                                   |
| `failMode`  | `SYSTEMONE_FAIL_MODE`  | `escalate`                  | If the reviewer fails or times out: `allow`, `escalate` (ask you) or `deny`.                                                                                |

**Backend selection:** `http` if `baseUrl` or `apiKey` is set, otherwise `opencode`. Set `backend` to override.

### Decisions

| Option         | Environment variable      | Default | Description                                                                                                                 |
| -------------- | ------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------- |
| `hardDeny`     | `SYSTEMONE_HARD_DENY`     | `false` | Block `deny` verdicts without asking. By default every flagged action, `escalate` or `deny`, goes to the permission prompt. |
| `skipTools`    | `SYSTEMONE_SKIP_TOOLS`    | —       | Tools never reviewed. Array in options, comma-separated in the env (`todowrite,question`).                                  |
| `shortCircuit` | `SYSTEMONE_SHORT_CIRCUIT` | `true`  | Skip the model call when a pattern already says `deny`.                                                                     |

### Context sent to the reviewer

| Option            | Environment variable          | Default | Description                                                                                                  |
| ----------------- | ----------------------------- | ------- | ------------------------------------------------------------------------------------------------------------ |
| `reviewReasoning` | `SYSTEMONE_REVIEW_REASONING`  | `true`  | Include the agent's reasoning for the call (redacted), so the reviewer can catch actions that contradict it. |
| `reasoningWaitMs` | `SYSTEMONE_REASONING_WAIT_MS` | `500`   | Longest wait for reasoning that is still streaming when the call arrives.                                    |
| `maxInputChars`   | `SYSTEMONE_MAX_INPUT_CHARS`   | `16000` | Tool arguments sent to the reviewer are truncated to this.                                                   |

### Tool output

| Option           | Environment variable         | Default | Description                                                                        |
| ---------------- | ---------------------------- | ------- | ---------------------------------------------------------------------------------- |
| `redactOutput`   | `SYSTEMONE_REDACT_OUTPUT`    | `true`  | Redact secrets from tool output before the agent's model reads it.                 |
| `reviewOutput`   | `SYSTEMONE_REVIEW_OUTPUT`    | `false` | Check tool output for prompt injection. Adds one reviewer request per tool result. |
| `maxOutputChars` | `SYSTEMONE_MAX_OUTPUT_CHARS` | `20000` | Output sent to the reviewer; the head and the tail are kept.                       |

### Operations

| Option     | Environment variable  | Default | Description                                                                  |
| ---------- | --------------------- | ------- | ---------------------------------------------------------------------------- |
| `enabled`  | `SYSTEMONE_ENABLED`   | `true`  | Master switch.                                                               |
| `auditLog` | `SYSTEMONE_AUDIT_LOG` | off     | Path of a JSONL audit trail (see below). `~` expands to your home directory. |
| `logLevel` | `SYSTEMONE_LOG_LEVEL` | `info`  | `debug`, `info`, `warn` or `error`.                                          |

## Recipes

**Use a model you already have in OpenCode** (no extra key):

```jsonc
{ "options": { "model": "anthropic/claude-haiku-4-5" } }
```

**Keep reviews on your machine** with Ollama, LM Studio or vLLM:

```jsonc
{
  "options": {
    "backend": "http",
    "baseUrl": "http://localhost:11434/v1",
    "model": "qwen2.5-coder:7b"
  }
}
```

**Use a hosted OpenAI-compatible API** (OpenAI, OpenRouter, Groq, …), with the key kept out of the config:

```bash
export SYSTEMONE_API_KEY=sk-...
export SYSTEMONE_BASE_URL=https://openrouter.ai/api/v1
export SYSTEMONE_MODEL=meta-llama/llama-3.3-70b-instruct
opencode service restart
```

**Unattended runs (CI)**: never wait for a human, never fail open:

```bash
SYSTEMONE_HARD_DENY=true SYSTEMONE_FAIL_MODE=deny opencode run --standalone "…"
```

> `--standalone` gives the run its own server, so these variables actually reach the plugin; without it,
> `opencode run` uses the background service and its environment. In a non-interactive run, permission
> prompts are rejected automatically unless you pass `--auto`.

**Maximum protection:**

```jsonc
{ "options": { "model": "…", "reviewOutput": true, "auditLog": "./.systemone/audit.jsonl" } }
```

## Audit log format

One JSON object per line. Each tool call produces a `verdict` and an `outcome`, for the call itself
(`stage: "call"`) and, with `reviewOutput`, for its output (`stage: "output"`):

```json
{"ts":"2026-10-27T15:49:25.746Z","event":"verdict","stage":"call","sessionID":"ses_…","callID":"call_…","tool":"shell","decision":"escalate","categories":["data_exfiltration"],"sources":["model"],"summary":"System One flagged this action: …","durationMs":412,"args":"{\"command\":\"…\"}"}
{"ts":"2026-10-27T15:49:27.102Z","event":"outcome","stage":"call","sessionID":"ses_…","callID":"call_…","tool":"shell","outcome":"approved"}
```

| `outcome`  | Meaning                                                                     |
| ---------- | --------------------------------------------------------------------------- |
| `allowed`  | Ran without a System One prompt.                                            |
| `approved` | You allowed it in the prompt.                                               |
| `rejected` | You rejected it, rejected it with feedback, or one of your rules denied it. |
| `blocked`  | Blocked without asking (`hardDeny`).                                        |

`sources` names the pattern rules that fired (`heuristic:cmd.pipe_to_shell`) and/or `model`. Arguments are
redacted and truncated. The file is created readable only by you (0600). A failed write is logged once and
never blocks a tool call.
