import { afterEach, expect, test } from "bun:test"
import type { PluginInput } from "@opencode-ai/plugin"
import GoogleChat from "../plugins/google-chat"

const servers: ReturnType<typeof Bun.serve>[] = []
afterEach(() => {
  servers.splice(0).forEach((server) => server.stop(true))
})

async function setup(statuses = [200]) {
  const messages: { text: string }[] = []
  const times: number[] = []
  const logs: string[] = []
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      expect(request.method).toBe("POST")
      expect(request.headers.get("content-type")).toContain("application/json")
      messages.push(await request.json())
      times.push(Date.now())
      return new Response("{}", { status: statuses.shift() ?? 200, headers: { "retry-after": "0" } })
    },
  })
  servers.push(server)
  const hooks = await GoogleChat(
    {
      directory: "/project",
      client: {
        app: {
          log: async (input: { body: { message: string } }) => {
            logs.push(input.body.message)
          },
        },
      },
    } as unknown as PluginInput,
    { webhookUrl: server.url.href },
  )
  const emit = (type: string, properties: unknown) =>
    hooks.event!({
      event: { type, properties } as Parameters<NonNullable<typeof hooks.event>>[0]["event"],
    })
  const status = (type: string, sessionID = "ses_main") => emit("session.status", { sessionID, status: { type } })
  return { hooks, emit, status, messages, times, logs }
}

test("questions and permissions send details once, with rate limiting", async () => {
  const ctx = await setup()
  const question = {
    id: "q1",
    sessionID: "ses_main",
    questions: [{ question: "Which branch?", options: [{ label: "dev", description: "Default branch" }] }],
  }
  await ctx.emit("question.asked", question)
  await ctx.emit("question.asked", question)
  await ctx.emit("permission.asked", { id: "p1", sessionID: "ses_main", permission: "bash", patterns: ["git push"] })
  await ctx.hooks.dispose!()
  expect(ctx.messages).toHaveLength(2)
  expect(ctx.messages[0].text).toContain("Which branch?")
  expect(ctx.messages[0].text).toContain("dev: Default branch")
  expect(ctx.messages[1].text).toContain("Permission: bash\ngit push")
  expect(ctx.times[1] - ctx.times[0]).toBeGreaterThanOrEqual(1000)
})

test("completion requires active to idle and excludes errors and subagents", async () => {
  const ctx = await setup()
  await ctx.status("idle")
  await ctx.emit("session.updated", { info: { id: "ses_main", title: "Webhook work" } })
  await ctx.status("busy")
  await ctx.status("idle")
  await ctx.status("idle")
  await ctx.emit("session.idle", { sessionID: "ses_main" })
  await ctx.status("busy")
  await ctx.emit("session.error", { sessionID: "ses_main" })
  await ctx.status("idle")
  await ctx.emit("session.created", { info: { id: "ses_child", title: "Child", parentID: "ses_main" } })
  await ctx.status("busy", "ses_child")
  await ctx.status("idle", "ses_child")
  await ctx.hooks.dispose!()
  expect(ctx.messages).toHaveLength(1)
  expect(ctx.messages[0].text).toContain("Chat done")
  expect(ctx.messages[0].text).toContain("Webhook work")
})

test("rate-limit responses are retried", async () => {
  const ctx = await setup([429, 200])
  await ctx.status("busy")
  await ctx.status("idle")
  await ctx.hooks.dispose!()
  expect(ctx.messages).toHaveLength(2)
  expect(ctx.messages[0]).toEqual(ctx.messages[1])
  expect(ctx.logs).toEqual([])
})

test("HTTP errors do not poison subsequent delivery or log credentials", async () => {
  const ctx = await setup([403, 200])
  await ctx.status("busy")
  await ctx.status("idle")
  await ctx.status("busy")
  await ctx.status("idle")
  await ctx.hooks.dispose!()
  expect(ctx.messages).toHaveLength(2)
  expect(ctx.logs).toEqual(["Notification delivery failed (HTTP 403)"])
})

test("empty webhook disables the plugin", async () => {
  expect(await GoogleChat({} as PluginInput, { webhookUrl: "" })).toEqual({})
})
