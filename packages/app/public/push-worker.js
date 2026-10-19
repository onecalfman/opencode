/* This worker handles push only. It does not cache pages, API responses, or credentials. */
self.addEventListener("install", (event) => event.waitUntil(self.skipWaiting()))

self.addEventListener("push", (event) => {
  event.waitUntil(
    Promise.resolve().then(() => {
      const payload = event.data?.json()
      if (!payload || typeof payload.title !== "string" || typeof payload.url !== "string") return
      const url = new URL(payload.url, self.location.origin)
      if (url.origin !== self.location.origin) return
      return self.registration.showNotification(payload.title, {
        body: typeof payload.body === "string" ? payload.body : "",
        icon: "/web-app-manifest-192x192.png",
        badge: "/favicon-96x96-v3.png",
        tag: typeof payload.tag === "string" ? payload.tag : undefined,
        data: { url: url.href },
      })
    }),
  )
})

self.addEventListener("notificationclick", (event) => {
  event.notification.close()
  event.waitUntil(
    Promise.resolve().then(async () => {
      const url = new URL(event.notification.data?.url ?? "/", self.location.origin)
      if (url.origin !== self.location.origin) return
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true })
      const existing = windows.find((client) => client.url === url.href)
      if (existing) return existing.focus()
      return self.clients.openWindow(url.href)
    }),
  )
})
