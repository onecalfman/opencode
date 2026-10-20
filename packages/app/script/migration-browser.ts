import { chromium, expect } from "@playwright/test"
import { Database } from "bun:sqlite"
import path from "node:path"

const [runtime] = process.argv.slice(2)
if (!runtime) throw new Error("Usage: migration-browser.ts <private preview runtime directory>")
const connection = await Bun.file(path.join(runtime, "connection-private.json")).json()
using db = new Database(connection.database, { readonly: true })
const retained = db.query<{ value: string }, []>("SELECT value FROM kv WHERE key = 'migration.pre-split-v2'").get()
if (!retained) throw new Error("Preview has no retained native session")
const sessionID = JSON.parse(retained.value)[0]
const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: "block" })
await context.addInitScript(
  ({ url, password }) => {
    localStorage.setItem(
      "opencode.global.dat:server",
      JSON.stringify({
        list: [{ type: "http", http: { url, password } }],
        hidden: {},
        projects: {},
        lastProject: {},
        recentlyClosed: {},
      }),
    )
  },
  { url: connection.url, password: connection.password },
)
const page = await context.newPage()
const errors: string[] = []
page.on("pageerror", (error) => errors.push(error.message))
const encoded = Buffer.from(connection.url).toString("base64url")
await page.goto(`${connection.url}/server/${encoded}/session/${sessionID}`)
await expect(page.locator('[data-timeline-row="UserMessage"]')).toHaveCount(1, { timeout: 60_000 })
await expect(page.locator('[data-component="composer-editor"]')).toBeEditable({ timeout: 60_000 })
await page.keyboard.press("Control+,")
const reload = page.getByRole("button", { name: "Reload app", exact: true })
await expect(reload).toBeVisible()
const navigated = page.waitForEvent("domcontentloaded")
await reload.click()
await navigated
await expect(page.getByRole("button", { name: "Reload app", exact: true })).toBeVisible({ timeout: 60_000 })
const report = {
  retainedSessionUserMessageRendered: true,
  composerReady: true,
  reloadAppVerified: true,
  pageErrors: errors.length,
}
await Bun.write(path.join(runtime, "browser-proof.json"), JSON.stringify(report, null, 2) + "\n", { mode: 0o600 })
console.log(JSON.stringify(report, null, 2))
await context.close()
await browser.close()
if (errors.length) throw new Error("Browser runtime errors were captured")
