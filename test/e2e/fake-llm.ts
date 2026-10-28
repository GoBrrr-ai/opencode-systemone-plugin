/**
 * A scripted OpenAI-compatible server for end-to-end tests. It plays two roles:
 *
 * - the AGENT model OpenCode talks to: on the first turn it streams some
 *   reasoning and one tool call; once the tool result comes back it replies
 *   with plain text and stops;
 * - the SYSTEM ONE reviewer (the plugin's http backend): it answers with the
 *   verdict the scenario asks for.
 *
 * Every request body is recorded so tests can assert on what each side saw.
 */

export interface Scenario {
  /** Arguments for the shell tool call the agent model makes. */
  command: string
  /** Reasoning streamed before the tool call (as reasoning_content). */
  reasoning?: string
  /** Reviewer answer for the CALL review. */
  callVerdict?: string
  /** Reviewer answer for the OUTPUT review. */
  outputVerdict?: string
}

export interface RecordedRequest {
  role: "agent" | "call-review" | "output-review" | "other"
  body: any
}

type Message = { role: string; content?: unknown; tool_calls?: unknown }

const text = (content: unknown): string =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.map((p: any) => (typeof p?.text === "string" ? p.text : "")).join("")
      : ""

function classify(body: any): RecordedRequest["role"] {
  const messages: Message[] = body?.messages ?? []
  const system = messages
    .filter((m) => m.role === "system")
    .map((m) => text(m.content))
    .join("\n")
  if (system.includes("You are System One")) {
    return messages.some((m) => text(m.content).includes("BEGIN TOOL_OUTPUT")) ? "output-review" : "call-review"
  }
  return Array.isArray(body?.tools) && body.tools.length > 0 ? "agent" : "other"
}

function sse(chunks: object[]): Response {
  const encoder = new TextEncoder()
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`))
      controller.enqueue(encoder.encode("data: [DONE]\n\n"))
      controller.close()
    },
  })
  return new Response(stream, { headers: { "content-type": "text/event-stream" } })
}

function completion(id: string, model: string, message: object, finish: string, stream: boolean): Response {
  if (!stream) {
    return Response.json({
      id,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, message, finish_reason: finish }],
      usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
    })
  }
  const base = { id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model }
  const m = message as { content?: string; reasoning_content?: string; tool_calls?: any[] }
  const chunks: object[] = [{ ...base, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] }]
  if (m.reasoning_content)
    chunks.push({
      ...base,
      choices: [{ index: 0, delta: { reasoning_content: m.reasoning_content }, finish_reason: null }],
    })
  if (m.content) chunks.push({ ...base, choices: [{ index: 0, delta: { content: m.content }, finish_reason: null }] })
  for (const [index, call] of (m.tool_calls ?? []).entries()) {
    chunks.push({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index, ...call }] }, finish_reason: null }] })
  }
  chunks.push({
    ...base,
    choices: [{ index: 0, delta: {}, finish_reason: finish }],
    usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
  })
  return sse(chunks)
}

export function startFakeLLM(scenario: Scenario) {
  const requests: RecordedRequest[] = []
  let calls = 0

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url)
      if (url.pathname.endsWith("/models")) {
        return Response.json({
          object: "list",
          data: [
            { id: "agent-model", object: "model" },
            { id: "reviewer-model", object: "model" },
          ],
        })
      }
      if (!url.pathname.endsWith("/chat/completions")) return new Response("not found", { status: 404 })

      const body = (await req.json()) as any
      const role = classify(body)
      requests.push({ role, body })
      const stream = Boolean(body.stream)
      const model = String(body.model ?? "fake")

      if (role === "call-review") {
        return completion(
          "rev",
          model,
          { role: "assistant", content: scenario.callVerdict ?? '{"decision":"allow"}' },
          "stop",
          false,
        )
      }
      if (role === "output-review") {
        return completion(
          "rev",
          model,
          { role: "assistant", content: scenario.outputVerdict ?? '{"decision":"allow"}' },
          "stop",
          false,
        )
      }
      if (role === "other") {
        // Titles and other housekeeping generations.
        return completion("other", model, { role: "assistant", content: "E2E session" }, "stop", stream)
      }

      // Agent turn: tool call first, then finish once a tool result is in the history.
      const messages: Message[] = body.messages ?? []
      if (messages.some((m) => m.role === "tool")) {
        return completion(`a${++calls}`, model, { role: "assistant", content: "Done." }, "stop", stream)
      }
      const names: string[] = (body.tools ?? []).map((t: any) => t?.function?.name).filter(Boolean)
      const shell = names.find((n) => n === "shell") ?? names.find((n) => n === "bash") ?? names[0]
      return completion(
        `a${++calls}`,
        model,
        {
          role: "assistant",
          content: null,
          ...(scenario.reasoning ? { reasoning_content: scenario.reasoning } : {}),
          tool_calls: [
            {
              id: `call_e2e_${calls}`,
              type: "function",
              function: {
                name: shell,
                arguments: JSON.stringify({ command: scenario.command, description: "e2e step" }),
              },
            },
          ],
        },
        "tool_calls",
        stream,
      )
    },
  })

  return {
    url: `http://127.0.0.1:${server.port}/v1`,
    requests,
    /** The tool results the agent model received back, as text. */
    toolResults: () =>
      requests
        .filter((r) => r.role === "agent")
        .flatMap((r) => (r.body.messages as Message[]).filter((m) => m.role === "tool").map((m) => text(m.content))),
    stop: () => server.stop(true),
  }
}
