# Contributing

Thanks for helping make coding agents safer! This guide covers local setup, the quality gates, and how
releases work.

## Setup

You need [Bun](https://bun.sh) 1.4+ (the exact version is pinned in `package.json` → `packageManager`).

```bash
git clone https://github.com/OWNER/opencode-systemone-plugin.git
cd opencode-systemone-plugin
bun install          # installs dependencies and the git hooks
```

## Everyday commands

| Command                     | What it does                                                           |
| --------------------------- | ---------------------------------------------------------------------- |
| `bun test`                  | Unit and plugin-flow tests (fast, offline; live e2e tests are skipped) |
| `bun run test:coverage`     | Tests plus the coverage gate (90% lines, 85% functions per file)       |
| `bun run lint` / `lint:fix` | Biome lint and format check / apply fixes                              |
| `bun run typecheck`         | TypeScript, strict                                                     |
| `bun run check:package`     | Build, then `publint` and `arethetypeswrong` on the package            |
| `bun run check`             | **All of the above**: the same gates CI runs                           |
| `bun run test:e2e`          | Live end-to-end tests against a real OpenCode (see below)              |

## Git hooks

[lefthook](https://lefthook.dev) installs these on `bun install`:

| Hook         | Runs                                                           |
| ------------ | -------------------------------------------------------------- |
| `pre-commit` | Biome on staged files (auto-fixes are re-staged) and typecheck |
| `commit-msg` | commitlint: the message must follow Conventional Commits       |
| `pre-push`   | Unit tests                                                     |

To skip them once in an emergency: `LEFTHOOK=0 git commit …`. CI runs the same checks anyway.

## Commit messages

We use [Conventional Commits](https://www.conventionalcommits.org). They drive versioning and the changelog:

| Prefix                                                   | Release | Example                                                             |
| -------------------------------------------------------- | ------- | ------------------------------------------------------------------- |
| `fix:`                                                   | patch   | `fix(redaction): keep tool results intact when nothing is redacted` |
| `feat:`                                                  | minor   | `feat(output): review tool output for prompt injection`             |
| `feat!:` or a `BREAKING CHANGE:` footer                  | major   | `feat!: rename SYSTEMONE_MODEL option`                              |
| `docs:`, `test:`, `ci:`, `build:`, `refactor:`, `chore:` | none    | `docs: add Ollama recipe`                                           |

Pull requests are squash-merged, so the **PR title** is what counts.

## Live end-to-end tests

`test/e2e` drives a **real OpenCode CLI** against a throwaway project, with this plugin loaded and a scripted
OpenAI-compatible server playing both the agent's model and the reviewer. HOME and the XDG dirs are isolated,
and each run uses its own private server, so your OpenCode setup is never touched.

```bash
npm install --global @opencode/cli@2.2.0
OPENCODE_BIN="$(command -v opencode)" bun run test:e2e                          # against src/
bun run build && E2E_PLUGIN_ENTRY=dist OPENCODE_BIN="$(command -v opencode)" bun run test:e2e   # against dist/
```

The `dist` run also covers configuring the plugin purely through `opencode.json` options. Set `E2E_LOGS=1` to
see OpenCode's server errors. CI runs both variants on every pull request.

## Design rules

- **Only ever make OpenCode stricter.** Never relax a user's own permission rules. The single exception is
  de-duplicating a prompt the user already answered for the same call and action.
- **Fail closed by default.** Unknown or failed reviews go to a human (`failMode: escalate`).
- **Never forward secrets.** Anything sent to the reviewer, written to the audit log or returned to the agent
  passes through redaction.
- **Patterns must be high-precision.** The model handles nuance; patterns catch well-known shapes. Every new
  pattern needs positive _and_ negative tests.
- **Don't hardcode vendors or hosts.** Detect behaviour classes; host lists belong in user configuration.

## Releasing

Releases are automated by [release-please](https://github.com/googleapis/release-please) and published to npm
with [trusted publishing](https://docs.npmjs.com/trusted-publishers/): no npm token is stored anywhere, and
every release carries a provenance attestation.

1. Merging to `main` updates a **release PR** with the version bump and changelog.
2. Merging the release PR tags the release, and `.github/workflows/release.yml` publishes to npm after running
   every quality gate.

### One-time setup

1. **Replace the `OWNER` placeholder** with the real GitHub owner, everywhere:
   `grep -rl OWNER --exclude-dir=node_modules . | xargs sed -i 's#OWNER/opencode-systemone-plugin#<owner>/opencode-systemone-plugin#g'`.
   npm checks `repository.url` in `package.json` against the publishing repository, so this is required.
2. **GitHub → Settings → Actions → General:** allow GitHub Actions to create and approve pull requests (needed
   by release-please).
3. **GitHub → Settings → Environments:** create an environment named `npm`. Optionally add required reviewers
   to approve each publish.
4. **npmjs.com → package settings → Trusted publishing:** add a GitHub Actions publisher with your
   owner/user, the repository name, workflow `release.yml` and environment `npm`.
   - If npm requires the package to exist first, do the very first publish manually from a clean checkout:
     `bun install && bun run check && npm publish --access public --provenance=false`, then add the trusted
     publisher. A new trusted-publisher configuration must be used for a successful publish within 2 days.
5. **Branch protection on `main`:** require the _CI_ checks and pull requests.
6. **Enable** Dependabot alerts/updates and CodeQL code scanning (workflows are included).

## Reporting security issues

Please don't open public issues for vulnerabilities; see [SECURITY.md](./SECURITY.md).
