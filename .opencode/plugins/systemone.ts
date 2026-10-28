// Local dev shim: OpenCode loads plugins from .opencode/plugins/, so running
// `opencode` inside this repo dogfoods the guard from source.
export { default } from "../../src/plugin.ts"
