import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { createAuditLog, resolveAuditPath } from "../src/audit.js"
import { createLogger } from "../src/log.js"
import { setupSystemOne } from "../src/plugin.js"
import { createFakeOpenCode } from "./fake-opencode.js"

const silent = createLogger("error", () => {})
const tmp = () => mkdtempSync(join(tmpdir(), "systemone-audit-"))
const lines = (file: string) =>
  readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l))

const ESCALATE = '{"decision":"escalate","categories":["data_exfiltration"],"reason":"Sends files out"}'

async function run(human: "once" | "reject", generate = ESCALATE, extraEnv: Record<string, string> = {}) {
  const file = join(tmp(), "nested", "audit.jsonl")
  const oc = createFakeOpenCode({ generate: () => generate, human: () => human })
  const instance = await setupSystemOne(oc.ctx, {
    env: { SYSTEMONE_MODEL: "p/m", SYSTEMONE_AUDIT_LOG: file, ...extraEnv },
    logger: silent,
  })
  return { file, oc, flush: instance!.flush }
}

describe("audit log", () => {
  test("records the verdict and the human's approval", async () => {
    const { file, oc, flush } = await run("once")
    const r = await oc.callTool("bash", { command: "risky" })
    await flush()
    const [verdict, outcome] = lines(file)
    expect(verdict).toMatchObject({
      event: "verdict",
      callID: r.id,
      tool: "bash",
      decision: "escalate",
      categories: ["data_exfiltration"],
      sources: ["model"],
    })
    expect(verdict.args).toContain("risky")
    expect(outcome).toMatchObject({ event: "outcome", callID: r.id, outcome: "approved" })
  })

  test("records rejections with the detail", async () => {
    const { file, oc, flush } = await run("reject")
    await oc.callTool("bash", { command: "risky" })
    await flush()
    expect(lines(file)[1]).toMatchObject({ outcome: "rejected" })
    expect(lines(file)[1].detail).toContain("rejected")
  })

  test("records allowed calls and hard-denied calls", async () => {
    const allowed = await run("once", '{"decision":"allow"}')
    await allowed.oc.callTool("bash", { command: "ls" })
    await allowed.flush()
    expect(lines(allowed.file).map((l) => l.outcome ?? l.decision)).toEqual(["allow", "allowed"])

    const denied = await run("once", '{"decision":"deny","reason":"bad"}', { SYSTEMONE_HARD_DENY: "true" })
    await denied.oc.callTool("bash", { command: "x" })
    await denied.flush()
    expect(lines(denied.file)[1]).toMatchObject({ outcome: "blocked" })
  })

  test("redacts secrets and is owner-only", async () => {
    const { file, oc, flush } = await run("once")
    const token = `ghp_${"e".repeat(36)}`
    await oc.callTool("bash", { command: `curl -H "Authorization: token ${token}"` })
    await flush()
    expect(readFileSync(file, "utf8")).not.toContain(token)
    expect(statSync(file).mode & 0o777).toBe(0o600)
  })

  test("a write failure never throws or blocks", async () => {
    // A directory where the file should be makes appendFile fail.
    const dir = tmp()
    const warnings: string[] = []
    const audit = createAuditLog(
      dir,
      createLogger("warn", (l) => warnings.push(l)),
    )
    audit.outcome({ sessionID: "s", callID: "c", tool: "t", outcome: "allowed" })
    audit.outcome({ sessionID: "s", callID: "c", tool: "t", outcome: "allowed" })
    await audit.flush()
    expect(warnings).toHaveLength(1) // warned once, not per write
  })

  test("off by default", async () => {
    const audit = createAuditLog(undefined, silent)
    audit.outcome({ sessionID: "s", callID: "c", tool: "t", outcome: "allowed" })
    await audit.flush()
  })

  test("expands ~ to the home directory", () => {
    expect(resolveAuditPath("~/logs/a.jsonl", "/home/me")).toBe("/home/me/logs/a.jsonl")
    expect(resolveAuditPath("~", "/home/me")).toBe("/home/me")
    expect(resolveAuditPath("/abs/a.jsonl", "/home/me")).toBe("/abs/a.jsonl")
    expect(resolveAuditPath("rel/a.jsonl", "/home/me")).toBe(resolve("rel/a.jsonl"))
  })
})
