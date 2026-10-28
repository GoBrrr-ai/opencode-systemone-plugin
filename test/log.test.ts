import { describe, expect, spyOn, test } from "bun:test"
import { createLogger } from "../src/log.js"

describe("createLogger", () => {
  test("drops messages below the configured level", () => {
    const lines: string[] = []
    const log = createLogger("warn", (l) => lines.push(l))
    log.debug("d")
    log.info("i")
    log.warn("w")
    log.error("e")
    expect(lines).toEqual(["[systemone] warn: w", "[systemone] error: e"])
  })

  test("writes to stderr by default", () => {
    const spy = spyOn(console, "error").mockImplementation(() => {})
    try {
      createLogger("info").info("hello")
      expect(spy).toHaveBeenCalledWith("[systemone] info: hello")
    } finally {
      spy.mockRestore()
    }
  })
})
