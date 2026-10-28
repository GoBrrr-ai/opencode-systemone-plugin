# 001 — Network egress policy

**Status:** not implemented — declined by the assistant
**Priority:** high (largest coverage gap against the reviewed article)

## Goal

Treat unexpected outbound network activity by the agent as a privacy risk, independent of the reviewer
model, so the plugin still catches it when `SYSTEMONE_MODEL` is unset or the reviewer is fooled.

Behaviours from the article this should cover: unrequested uploads of data to remote storage, probing of
cloud instance-metadata endpoints (credential access), and unrequested downloads from unfamiliar hosts.

Today these are caught **only** by the reviewer model. With heuristics alone, all of them pass silently.

## Why it is not implemented

While writing this module, the assistant's output was stopped by a safety classifier. After a stop like
that, the assistant must not produce the same content again, even reworded. That covers the detection
logic and also a detailed written spec of it.

For the same reason this file contains **no implementation details** (patterns, address forms, flag
lists). It records scope, constraints and integration points only. A human maintainer needs to design and
write the detection logic.

## Constraints (agreed)

- **No hardcoded hosts or vendors.** The hosts named in the article are illustrative. Detect behaviour
  classes, not specific destinations.
- **Host lists are user configuration only**, for example an allowlist and a denylist via env vars, both
  empty by default.
- **Privacy-first default.** Outbound activity the user did not ask for should escalate rather than pass.
- **Low noise for normal dev work.** Package installs and git operations against configured hosts should
  not require approval on every call.
- **Decisions stay in the existing model:** `allow | escalate | deny`, strictest wins.

## Integration points in this codebase

- **New module:** `src/network.ts`, exporting a function with the same shape as `runHeuristics`
  (`(action, config) => Finding[]`).
- **`src/guard.ts`:** call it next to `runHeuristics`, so its findings join the same strictest-wins
  reduction and the same deny short-circuit.
- **`src/config.ts`:** add the egress settings (policy plus allow/deny lists). Document them in
  `.env.example` and in the README config table.
- **`src/types.ts`:** the categories it needs already exist (`data_exfiltration`, `network_access`,
  `credential_access`).
- **`src/heuristics.ts`:** the existing `scanTargets` helper shows how tool arguments are collected for
  scanning. Reuse it rather than duplicating it.
- **Escalation needs no extra work.** Any `escalate` or `deny` finding already goes through
  `src/plugin.ts` to the native OpenCode permission prompt, with the finding's reason as the message.
- **Tests:** a new `test/network.test.ts`. Cover both detection and the absence of false positives for
  ordinary dev commands. Add one flow test in `test/plugin.test.ts` using the fake context, to show a
  network finding reaching the native prompt.
- **README:** when this lands, remove the egress item from the Roadmap and add the policy to "How it works".

## Acceptance criteria

- With no reviewer model configured, the guard escalates or denies each of the article's behaviour classes
  (upload, metadata access, unfamiliar download) when the call carries no user-configured allowance.
- No vendor, host or IP literal from the article appears anywhere in the source or tests.
- `bun test` and `bun run typecheck` pass. The existing suite stays green.
