import { expect, test } from "@playwright/test"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { mockOpenCodeServer } from "../utils/mock-server"
import { fixture } from "../performance/timeline/session-timeline-stress.fixture"

const draftID = "draft_server_route_regression"
const sessionID = "ses_server_route_regression"
const server = `http://${process.env.PLAYWRIGHT_SERVER_HOST ?? "127.0.0.1"}:${process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"}`

test("keeps a new chat usable when the server profile refreshes during submission", async ({ page }) => {
  const session = { ...fixture.sessions[0], id: sessionID, title: "New chat route regression" }
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  const profile = Promise.withResolvers<void>()
  const messages = Promise.withResolvers<void>()
  // Hold navigation open while a profile response invalidates the server list.
  // The pending session route must not read the committed draft route's params.
  await mockOpenCodeServer(page, {
    directory: fixture.directory,
    project: fixture.project,
    provider: fixture.provider,
    sessions: [session],
    pageMessages: () => ({ items: [] }),
    beforeMessagesResponse: () => messages.promise,
  })
  await page.route("**/api/profile", async (route) => {
    await profile.promise
    await route.fulfill({ json: { revision: 1, profile: { version: 1, servers: [] } } })
  })
  await page.route(
    (url) => url.pathname === "/session",
    async (route) => {
      if (route.request().method() !== "POST") return route.fallback()
      await route.fulfill({ json: session })
    },
  )
  await page.route(
    (url) => url.pathname === `/session/${sessionID}/prompt_async`,
    (route) => route.fulfill({ status: 204 }),
  )
  await page.addInitScript(
    ({ draftID, server, directory }) => {
      localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: true } }))
      localStorage.setItem("opencode.global.dat:server", JSON.stringify({ profileImported: true }))
      localStorage.setItem(
        "opencode.window.browser.dat:tabs",
        JSON.stringify([{ type: "draft", draftID, server, directory }]),
      )
    },
    { draftID, server, directory: fixture.directory },
  )

  await page.goto(`/new-session?draftId=${draftID}`)
  const input = page.locator('[data-component="prompt-input-v2"] [data-component="prompt-input"]')
  await expect(input).toBeEditable()
  await expect(page.getByRole("button", { name: "Claude Opus 4.6", exact: true })).toBeVisible()
  await input.fill("First message route regression")
  await expect(input).toHaveText("First message route regression")
  const loading = page.waitForRequest((request) => new URL(request.url()).pathname === `/session/${sessionID}/message`)
  const refreshed = page.waitForResponse("**/api/profile")
  const submitted = page.waitForRequest(
    (request) =>
      request.method() === "POST" && new URL(request.url()).pathname === `/session/${sessionID}/prompt_async`,
  )
  await page.getByRole("button", { name: "Send", exact: true }).click()
  await loading
  profile.resolve()
  await refreshed
  messages.resolve()

  expect((await submitted).postDataJSON()).toMatchObject({
    parts: [expect.objectContaining({ type: "text", text: "First message route regression" })],
  })
  await expect(page).toHaveURL(new RegExp(`/server/${base64Encode(server)}/session/${sessionID}$`))
  await expect(input).toBeEditable()
  await input.fill("Follow-up after profile refresh")
  await expect(input).toHaveText("Follow-up after profile refresh")
  await expect(page.getByText("Invalid server route", { exact: false })).toHaveCount(0)
  expect(errors).toEqual([])
})
