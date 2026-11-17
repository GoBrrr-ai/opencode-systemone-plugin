# Security policy

System One is a security control, so reports about it are taken seriously and handled privately.

## Supported versions

| Version              | Supported           |
| -------------------- | ------------------- |
| latest `0.x` release | ✅                  |
| older releases       | ❌ (please upgrade) |

## Reporting a vulnerability

**Please don't open a public issue.** Report privately through
[GitHub security advisories](https://github.com/GoBrrr-ai/opencode-systemone-plugin/security/advisories/new).

Include what you can:

- the plugin and OpenCode versions, and the reviewer backend;
- the tool call or content involved (with real secrets removed);
- what you expected the plugin to do, and what it did;
- `SYSTEMONE_LOG_LEVEL=debug` output or an audit-log excerpt.

You'll get an acknowledgement within a few days and a fix plan once the issue is confirmed. Credit is given in
the release notes unless you prefer otherwise.

## In scope

- Getting a flagged action to **run without the human prompt** (bypassing the guard or the evaluate hook).
- The plugin **relaxing** a user's own OpenCode permission rules.
- **Secret leaks**: to the reviewer, the audit log, the agent's model or agent shells (including
  `SYSTEMONE_API_KEY`).
- **Prompt injection against the reviewer** that changes its decision through tool arguments or output.
- Crashes or hangs that make tool calls fail open.

## Out of scope

- The reviewer model making a wrong call on a borderline action, without a systematic bypass. Please open a
  regular issue with the example instead.
- Risks the plugin doesn't claim to cover yet; see the open items in [`task/`](./task).

## What this plugin is not

System One is a **review layer with a human in the loop, not a sandbox.** For untrusted models or code, also
isolate the agent: run it in a container or VM with restricted network egress and no access to production
credentials.
