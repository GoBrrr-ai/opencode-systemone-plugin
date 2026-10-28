# Changelog

All notable changes to this project are documented here. From the first automated release onward, this file is
maintained by [release-please](https://github.com/googleapis/release-please) from
[Conventional Commits](https://www.conventionalcommits.org).

## Unreleased (first release: 0.2.0)

First public version.

### Features

- Review every OpenCode tool call (built-in, MCP and custom tools) with pattern checks and a System One reviewer
  model, before it runs.
- Escalate flagged calls to OpenCode's **native permission prompt** (TUI and Web UI), even when the user's
  rules would auto-allow the action; never relax the user's own rules.
- Reviewer backends: OpenCode's own providers (`opencode`, no extra key) or any OpenAI-compatible endpoint
  (`http`).
- Context-aware review: the user's request, the agent's live reasoning for the call, and earlier calls in the
  turn.
- Opt-in prompt-injection review of tool **output**, with the same native prompt.
- Redaction of secrets in reviewer input, tool output and the audit log (token formats, private-key blocks,
  JWTs, credential assignments).
- The reviewer's API key is kept out of every agent shell.
- JSONL audit log of every verdict and decision.
- `hardDeny`, `failMode`, `skipTools` and 15 other options, via `opencode.json` or `SYSTEMONE_*` variables.
