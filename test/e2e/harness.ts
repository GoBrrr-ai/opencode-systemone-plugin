/**
 * Runs a real OpenCode CLI against a temporary project with this plugin
 * loaded from .opencode/plugins/ and a scripted model (fake-llm.ts).
 *
 * Everything is isolated: HOME and the XDG dirs point into a temp directory,
 * so the developer's own OpenCode config, credentials and sessions are never
 * touched.
 */
import { spawn } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { type Scenario, startFakeLLM } from "./fake-llm.js"

const REPO = resolve(import.meta.dir, "../..")

/**
 * Which build of the plugin OpenCode loads. Default: the TypeScript source.
 * E2E_PLUGIN_ENTRY=dist loads the compiled package entry, exactly what users install.
 */
export function pluginEntry(): string {
  return process.env.E2E_PLUGIN_ENTRY === "dist" ? join(REPO, "dist", "index.js") : join(REPO, "src", "plugin.ts")
}

export interface RunOptions {
  scenario: Scenario
  /** true → `--auto` (OpenCode approves prompts once); false → OpenCode rejects every prompt. */
  approve: boolean
  /** Extra SYSTEMONE_* settings. The reviewer always points at the fake server. */
  env?: Record<string, string>
  /**
   * Configure the plugin the way the README recommends: as an installed package in
   * opencode.json `plugins` with `options`, and NO SYSTEMONE_* environment at all.
   * Loads the built package through its package.json exports (run `bun run build` first).
   */
  viaConfigOptions?: boolean
  timeoutMs?: number
}

export interface RunResult {
  exitCode: number | null
  stdout: string
  stderr: string
  /** Events from `--format json`, parsed line by line. */
  events: any[]
  project: string
  llm: ReturnType<typeof startFakeLLM>
  auditPath: string
  audit: () => any[]
  /** True if the shell command's side-effect marker exists. */
  marker: (name: string) => boolean
}

export function opencodeBin(): string | undefined {
  return process.env.OPENCODE_BIN || undefined
}

export async function runOpenCode(opts: RunOptions): Promise<RunResult> {
  const bin = opencodeBin()
  if (!bin) throw new Error("set OPENCODE_BIN to the opencode executable")

  const root = mkdtempSync(join(tmpdir(), "systemone-e2e-"))
  const home = join(root, "home")
  const project = join(root, "project")
  for (const dir of [home, project, join(project, ".opencode", "plugins")]) mkdirSync(dir, { recursive: true })

  const llm = startFakeLLM(opts.scenario)
  const auditPath = join(root, "audit.jsonl")

  writeFileSync(
    join(project, "opencode.json"),
    JSON.stringify(
      {
        $schema: "https://opencode.ai/config.json",
        provider: {
          fake: {
            npm: "@ai-sdk/openai-compatible",
            name: "Fake",
            options: { baseURL: llm.url, apiKey: "e2e" },
            models: { "agent-model": { name: "Agent model" } },
          },
        },
        model: "fake/agent-model",
        small_model: "fake/agent-model",
        ...(opts.viaConfigOptions
          ? {
              plugins: [
                {
                  package: `file://${REPO}`,
                  options: {
                    model: "reviewer-model",
                    baseUrl: llm.url,
                    apiKey: "sk-e2e-reviewer-key",
                    auditLog: auditPath,
                    ...opts.env,
                  },
                },
              ],
            }
          : {}),
      },
      null,
      2,
    ),
  )
  if (!opts.viaConfigOptions) {
    writeFileSync(
      join(project, ".opencode", "plugins", "systemone.ts"),
      `export { default } from ${JSON.stringify(pluginEntry())}\n`,
    )
  }

  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    XDG_STATE_HOME: join(home, ".local", "state"),
    XDG_CACHE_HOME: join(home, ".cache"),
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    ...(opts.viaConfigOptions
      ? {}
      : {
          SYSTEMONE_BASE_URL: llm.url,
          SYSTEMONE_API_KEY: "sk-e2e-reviewer-key",
          SYSTEMONE_MODEL: "reviewer-model",
          SYSTEMONE_AUDIT_LOG: auditPath,
          SYSTEMONE_LOG_LEVEL: "debug",
          ...opts.env,
        }),
  }

  const args = [
    "run",
    "--standalone",
    ...(process.env.E2E_LOGS ? ["--print-logs", "--log-level", "error"] : []),
    "--format",
    "json",
    ...(opts.approve ? ["--auto"] : []),
    "Please run the e2e step.",
  ]
  const child = spawn(bin, args, { cwd: project, env, stdio: ["ignore", "pipe", "pipe"] })
  let stdout = ""
  let stderr = ""
  child.stdout.on("data", (d) => (stdout += d))
  child.stderr.on("data", (d) => (stderr += d))

  const exitCode = await new Promise<number | null>((done) => {
    const timer = setTimeout(() => child.kill("SIGKILL"), opts.timeoutMs ?? 120_000)
    child.on("close", (code) => {
      clearTimeout(timer)
      done(code)
    })
  })

  const events = stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("{"))
    .flatMap((l) => {
      try {
        return [JSON.parse(l)]
      } catch {
        return []
      }
    })

  return {
    exitCode,
    stdout,
    stderr,
    events,
    project,
    llm,
    auditPath,
    audit: () =>
      existsSync(auditPath)
        ? readFileSync(auditPath, "utf8")
            .trim()
            .split("\n")
            .filter(Boolean)
            .map((l) => JSON.parse(l))
        : [],
    marker: (name) => existsSync(join(project, name)),
  }
}
