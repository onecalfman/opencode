import { test } from "bun:test"
import { chromium, expect } from "@playwright/test"
import { createServer } from "node:http"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

test("receives push after the app page closes without fetching authenticated resources", async () => {
  const requests: string[] = []
  const source = await Bun.file(`${import.meta.dir}/../public/push-worker.js`).text()
  const server = createServer((request, response) => {
    const path = request.url ?? "/"
    requests.push(path)
    response.writeHead(200, { "content-type": path === "/push-worker.js" ? "application/javascript" : "text/html" })
    response.end(path === "/push-worker.js" ? source : "<!doctype html><title>Push worker test</title>")
  })
  const directory = await mkdtemp(join(tmpdir(), "opencode-push-worker-"))
  const context = await chromium.launchPersistentContext(directory, { channel: "chromium" })
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("Missing test HTTP listener")
    const origin = `http://127.0.0.1:${address.port}`
    await context.grantPermissions(["notifications"], { origin })
    const app = await context.newPage()
    const observer = await context.newPage()
    const cdp = await context.newCDPSession(observer)
    const registered = new Promise<string>((resolve) => {
      cdp.on("ServiceWorker.workerRegistrationUpdated", (event) => {
        const registration = event.registrations.find(
          (item) => item.scopeURL === `${origin}/_opencode/push/test/` && !item.isDeleted,
        )
        if (registration) resolve(registration.registrationId)
      })
    })
    await cdp.send("ServiceWorker.enable")
    await app.goto(origin)
    const workerReady = context.waitForEvent("serviceworker")
    await app.evaluate(async () => {
      const registration = await navigator.serviceWorker.register("/push-worker.js", { scope: "/_opencode/push/test/" })
      const worker = registration.installing ?? registration.waiting ?? registration.active
      if (worker?.state === "activated") return
      await new Promise<void>((resolve) =>
        worker?.addEventListener("statechange", () => {
          if (worker.state === "activated") resolve()
        }),
      )
    })
    const worker = await workerReady
    expect(
      await app.evaluate(() => ({ url: location.href, secure: isSecureContext, permission: Notification.permission })),
    ).toEqual({ url: `${origin}/`, secure: true, permission: "granted" })
    expect(await worker.evaluate(() => Notification.permission)).toBe("granted")
    const registrationId = await registered
    await app.close()
    const path = "/server/remote/session/ses_finished"
    await cdp.send("ServiceWorker.deliverPushMessage", {
      origin,
      registrationId,
      data: JSON.stringify({
        title: "Task complete",
        body: "Ready to review",
        url: `${origin}${path}`,
        tag: "completion",
      }),
    })
    await expect
      .poll(() =>
        worker.evaluate(async () => {
          const notifications = await self.registration.getNotifications()
          return notifications.map((notification) => ({
            title: notification.title,
            body: notification.body,
            url: notification.data.url,
          }))
        }),
      )
      .toEqual([{ title: "Task complete", body: "Ready to review", url: `${origin}${path}` }])
    expect(requests.filter((path) => path.startsWith("/api/"))).toEqual([])
    await worker.evaluate(async () => {
      const promises: Promise<unknown>[] = []
      const event = new PushEvent("push", {
        data: JSON.stringify({ title: "External URL", url: "https://untrusted.example/" }),
      })
      Object.defineProperty(event, "waitUntil", { value: (promise: Promise<unknown>) => promises.push(promise) })
      self.dispatchEvent(event)
      await Promise.all(promises)
    })
    await expect.poll(() => worker.evaluate(async () => (await self.registration.getNotifications()).length)).toBe(1)
  } finally {
    await context.close()
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
    await rm(directory, { recursive: true, force: true })
  }
}, 30_000)
