## What and why

<!-- What does this change, and why? Link the issue if there is one. -->

## How it was tested

<!-- Unit tests, e2e (`bun run test:e2e`), a manual check in OpenCode? -->

## Checklist

- [ ] PR title follows [Conventional Commits](https://www.conventionalcommits.org) (`feat:`, `fix:`, `docs:` …); it becomes the changelog entry
- [ ] `bun run check` passes (lint, typecheck, tests + coverage, package checks)
- [ ] New behaviour is covered by tests
- [ ] Docs updated (README / `docs/`) if user-facing behaviour or configuration changed
- [ ] The change only ever makes OpenCode **stricter** (never relaxes a user's own permission rules), or explains why not
