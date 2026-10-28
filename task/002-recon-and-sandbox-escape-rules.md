# 002 — Reconnaissance & sandbox-escape heuristics

**Status:** not implemented — declined by the assistant. When the assistant tried to implement it, a
safety classifier stopped the output, so the assistant cannot write it. The spec below was written before
that stop and is intended for a human maintainer.
**Priority:** medium

## Goal

Add local heuristics for two behaviour classes from the article that currently pass silently when no
reviewer model is configured:

1. **Off-task environment reconnaissance.** In the article the agent, mid-task, listed temp directories,
   checked which file-transfer tools were installed, and read the system resolver config, none of which
   the task asked for.
2. **Working around a permission wall.** After being refused admin rights, the agent created a private
   user namespace to obtain root inside it, then mounted a filesystem there. The article notes this is a
   common first step toward kernel privilege escalation.

## Implementation details

### Rules (`src/heuristics.ts`, `COMMAND_RULES`)

All of these should **escalate**, not deny. Each has legitimate uses, and the reviewer model (with the
user's task in context) is better placed to judge scope.

| id                  | category               | what to match                                                                                                                                    |
| ------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `cmd.userns`        | `privilege_escalation` | `unshare` with user-namespace or map-root flags (`-U`, `-r`, `--user`, `--map-root-user`, including combined short flags like `-Urm`)            |
| `cmd.nsenter`       | `privilege_escalation` | any `nsenter` invocation                                                                                                                         |
| `cmd.mount`         | `privilege_escalation` | `mount` as a command (not as a substring of another word, and not `mount --help` / bare `mount` listing)                                         |
| `cmd.chroot`        | `privilege_escalation` | `chroot` invocation                                                                                                                              |
| `cmd.caps`          | `privilege_escalation` | `setcap`, `capsh`                                                                                                                                |
| `cmd.resolver_read` | `reconnaissance`       | reads of system resolver / hosts config under `/etc`                                                                                             |
| `cmd.tool_probe`    | `reconnaissance`       | `which` / `command -v` / `type` asking about **two or more** file-transfer or interpreter tools in one command (a single `which node` is normal) |

Notes:

- Keep the existing rule style: one regex per rule, high precision, anchored on command boundaries
  (`(?:^|[\s;&|(])`) so words inside paths or strings don't trigger.
- `ls /tmp` alone is too common to flag. Leave temp-dir listing to the reviewer and the session signal below.

### Session signal (optional, second step)

A single recon command is weak evidence; several in a row are strong. `src/plugin.ts` already keeps
per-session state reset on each user prompt (`tasks`, `recent`). Add a recon counter next to them:

- Increment it on every verdict with a `reconnaissance` finding.
- Once it reaches a threshold (default 2, configurable via `SYSTEMONE_RECON_THRESHOLD`), add an extra
  `escalate` finding to the following actions in that session until the next user prompt. The human then
  sees them in the native prompt.
- Pass the count to the reviewer through `ActionContext` so the model sees the pattern too.

### Reviewer prompt

`SYSTEM_PROMPT` already names `reconnaissance` and `privilege_escalation`. Add one line: working around a
refused permission (namespaces, mounts, capability changes) should escalate even when the reasoning
explains it.

### Tests (`test/heuristics.test.ts`)

- Positive: `unshare -Urm sh -c 'true'`, `unshare --user --map-root-user bash`, `nsenter -t 1 -m`,
  `mount -t tmpfs tmpfs /mnt`, `cat /etc/resolv.conf`, `which curl wget python3`.
- Negative (must stay allowed): `which node`, `command -v bun`, `ls /tmp`, `npm run mount-assets`,
  `grep mount README.md`, `docker compose up`.
- Session signal (in `test/plugin.test.ts`, using the fake context): two recon findings in one session
  escalate the next benign action to the native prompt; a new user prompt resets the count; a different
  session is unaffected.

## Acceptance criteria

- The article's namespace and recon commands escalate with heuristics only.
- The negative cases above stay `allow`.
- `bun test` and `bun run typecheck` pass.
