import { base64Encode } from "@opencode-ai/core/util/encode"
import { Push } from "@opencode-ai/schema/push"
import { Schema } from "effect"
import type { ServerConnection } from "@/context/server"
import { authTokenFromCredentials } from "./server"

// The app's compatibility client is vendored; new server-global endpoints use the shared wire schemas.
export function createPushApi(
  server: ServerConnection.HttpBase,
  fetcher: (input: string, init: RequestInit) => Promise<Response> = fetch,
) {
  const request = async (method: string, path: string, body?: Push.Registration) => {
    const response = await fetcher(`${server.url.replace(/\/$/, "")}/api/push${path}`, {
      method,
      headers: {
        Accept: "application/json",
        ...(body ? { "Content-Type": "application/json" } : {}),
        ...(server.password
          ? {
              Authorization: `Basic ${authTokenFromCredentials({ username: server.username, password: server.password })}`,
            }
          : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15_000),
    })
    if (!response.ok) throw new Error(`Push request failed (${response.status})`)
    return response.json() as Promise<unknown>
  }
  const boolean = Schema.decodeUnknownSync(Schema.Boolean)
  return {
    configuration: () => request("GET", "").then(Schema.decodeUnknownSync(Push.Configuration)),
    register: (id: string, input: Push.Registration) =>
      request("PUT", `/subscriptions/${encodeURIComponent(id)}`, input).then(boolean),
    remove: (id: string) => request("DELETE", `/subscriptions/${encodeURIComponent(id)}`).then(boolean),
    test: (id: string) => request("POST", `/subscriptions/${encodeURIComponent(id)}/test`).then(boolean),
  }
}

export function pushAvailability() {
  if (typeof window === "undefined" || !window.isSecureContext) return "secure"
  const ios =
    /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
  if (ios && !window.matchMedia("(display-mode: standalone)").matches) return "install"
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) return "unsupported"
  if (Notification.permission === "denied") return "denied"
}

export function pushScope(key: string) {
  // Independent registrations allow different OpenCode servers to use different VAPID keys.
  return `/_opencode/push/${base64Encode(key)}/`
}

export async function pushRegistration(key: string) {
  const registration = await navigator.serviceWorker.register("/push-worker.js", {
    scope: pushScope(key),
    updateViaCache: "none",
  })
  if (registration.active?.state === "activated") return registration
  const worker = registration.installing ?? registration.waiting ?? registration.active
  if (!worker) throw new Error("Push worker is unavailable")
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error("Push worker activation timed out")), 15_000)
    const finish = (error?: Error) => {
      clearTimeout(timer)
      worker.removeEventListener("statechange", change)
      if (error) reject(error)
      else resolve()
    }
    const change = () => {
      if (worker.state === "activated") finish()
      if (worker.state === "redundant") finish(new Error("Push worker activation failed"))
    }
    worker.addEventListener("statechange", change)
    change()
  })
  return registration
}

export function pushKey(publicKey: string) {
  return Uint8Array.from(atob(publicKey.replaceAll("-", "+").replaceAll("_", "/")), (character) =>
    character.charCodeAt(0),
  )
}
