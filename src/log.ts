const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const
export type LogLevel = keyof typeof LEVELS

export interface Logger {
  debug(msg: string): void
  info(msg: string): void
  warn(msg: string): void
  error(msg: string): void
}

/** Minimal stderr logger. Swap for `client.app.log` where an SDK client is available. */
export function createLogger(level: LogLevel = "info", sink: (line: string) => void = (l) => console.error(l)): Logger {
  const min = LEVELS[level]
  const at = (lvl: LogLevel) => (msg: string) => {
    if (LEVELS[lvl] >= min) sink(`[systemone] ${lvl}: ${msg}`)
  }
  return { debug: at("debug"), info: at("info"), warn: at("warn"), error: at("error") }
}
