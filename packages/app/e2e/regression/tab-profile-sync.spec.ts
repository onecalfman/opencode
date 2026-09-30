import { expect, test } from "@playwright/test"
import type { ProfileSnapshot } from "@opencode-ai/sdk/v2/types"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { mockOpenCodeServer } from "../utils/mock-server"

for (const tabLayout of ["horizontal", "vertical"]) {
  test(`${tabLayout} closed tabs stay closed after profile refresh and reload`, async ({ page }) => {
    const server = "http://tabs.example:4096"
    const sessions = ["ses_close", "ses_keep"].map((id) => ({
      id,
      slug: id,
      projectID: "project-tabs",
      directory: "/repo",
      title: id === "ses_close" ? "Close this tab" : "Keep this tab",
      version: "dev",
      time: { created: 1, updated: 1 },
    }))
    const profile: { snapshot: ProfileSnapshot } = {
      snapshot: {
        revision: 1,
        profile: {
          version: 1,
          servers: [{ url: server, projects: [], openSessionIDs: sessions.map((s) => s.id), openSessionInputAt: 200 }],
        },
      },
    }
    await mockOpenCodeServer(page, {
      protocol: "v2",
      directory: "/repo",
      project: { id: "project-tabs", worktree: "/repo", time: { created: 1, updated: 1 }, sandboxes: [] },
      sessions,
      provider: { all: [], connected: [], default: {} },
      pageMessages: () => ({ items: [] }),
    })
    await page.route("**/api/profile", async (route) => {
      if (route.request().method() === "PUT") {
        const input = route.request().postDataJSON() as ProfileSnapshot
        profile.snapshot = { revision: input.revision + 1, profile: input.profile }
      }
      await route.fulfill({
        contentType: "application/json",
        headers: { "access-control-allow-origin": "*" },
        body: JSON.stringify(profile.snapshot),
      })
    })
    await page.addInitScript(
      ({ server, tabLayout }) => {
        if (localStorage.getItem("tab-profile-seeded")) return
        localStorage.setItem("tab-profile-seeded", "true")
        localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: true, tabLayout } }))
        localStorage.setItem(
          "opencode.global.dat:server",
          JSON.stringify({ list: [server], profileImported: true, profileSessionImported: { [server]: true } }),
        )
        localStorage.setItem(
          "opencode.window.browser.dat:tabs",
          JSON.stringify(["ses_close", "ses_keep"].map((sessionId) => ({ type: "session", server, sessionId }))),
        )
      },
      { server, tabLayout },
    )
    const closeHref = `/server/${base64Encode(server)}/session/ses_close`
    const keepHref = `/server/${base64Encode(server)}/session/ses_keep`
    const closed = page.locator(`[data-titlebar-tab-slot]:has(a[href="${closeHref}"])`)
    const kept = page.locator(`[data-titlebar-tab-slot]:has(a[href="${keepHref}"])`)
    const hydrated = page.waitForResponse((response) => response.url().endsWith("/api/profile"))
    await page.goto(closeHref)
    await hydrated
    await expect(closed).toContainText("Close this tab")
    await expect(kept).toContainText("Keep this tab")
    const saved = page.waitForResponse(
      (response) => response.url().endsWith("/api/profile") && response.request().method() === "PUT",
    )
    await closed.locator('[data-slot="tab-close"] button').click()
    await saved
    expect(profile.snapshot.profile.servers[0].openSessionIDs).toEqual(["ses_keep"])
    await expect(closed).toHaveCount(0)
    await expect(page).toHaveURL(new RegExp(`${keepHref}$`))
    const refreshed = page.waitForResponse(
      (response) => response.url().endsWith("/api/profile") && response.request().method() === "GET",
    )
    await page.evaluate(() => window.dispatchEvent(new Event("focus")))
    await refreshed
    await expect(closed).toHaveCount(0)
    await expect(kept).toContainText("Keep this tab")
    await page.reload()
    await expect(kept).toContainText("Keep this tab")
    await expect(closed).toHaveCount(0)
  })
}
