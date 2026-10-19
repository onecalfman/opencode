import { createEffect, onCleanup, untrack } from "solid-js"
import { createStore } from "solid-js/store"
import { createSimpleContext } from "@opencode-ai/ui/context"
import { Persist, persisted } from "@/utils/persist"
import { createPushApi, pushAvailability, pushKey, pushRegistration, pushScope } from "@/utils/push"
import { useGlobal } from "./global"
import { useLanguage } from "./language"
import { usePlatform } from "./platform"
import { ServerConnection } from "./server"
import { useSettings } from "./settings"

export const { use: usePushNotifications, provider: PushNotificationProvider } = createSimpleContext({
  name: "PushNotifications",
  gate: false,
  init: () => {
    const global = useGlobal()
    const language = useLanguage()
    const platform = usePlatform()
    const settings = useSettings()
    const [store, setStore, , ready] = persisted(
      Persist.global("push-devices.v1"),
      createStore({ devices: {} as Record<string, { id: string; enabled: boolean; pending?: boolean }> }),
    )
    const [state, setState] = createStore({
      busy: {} as Record<string, boolean>,
      active: {} as Record<string, boolean>,
      error: {} as Record<string, boolean>,
    })
    const pending = new Map<string, Promise<unknown>>()
    const snapshots = new Map<string, string>()
    const known = new Map<string, ServerConnection.Any>()
    const api = (conn: ServerConnection.Any) => createPushApi(conn.http, platform.fetch)
    const options = () => ({
      origin: location.origin,
      preferences: {
        agent: settings.notifications.agent(),
        permissions: settings.notifications.permissions(),
        errors: settings.notifications.errors(),
      },
      titles: {
        agent: language.t("notification.session.responseReady.title"),
        permission: language.t("notification.permission.title"),
        question: language.t("notification.question.title"),
        errors: language.t("notification.session.error.title"),
        test: language.t("settings.general.notifications.push.testTitle"),
      },
    })

    const sync = (conn: ServerConnection.Any, enable: boolean, permission?: Promise<NotificationPermission>) => {
      const key = ServerConnection.key(conn)
      const payload = options()
      const settled = () => {
        const record = store.devices[key]
        if (!record || record.enabled !== enable) return
        snapshots.set(key, JSON.stringify([JSON.stringify(payload), conn.http, { ...record, pending: false }]))
        setStore("devices", key, "pending", false)
      }
      setState("busy", key, true)
      setState("error", key, false)
      const task = (pending.get(key) ?? Promise.resolve())
        .catch(() => undefined)
        .then(async () => {
          const record = store.devices[key]
          if (!record) return
          if (!enable) {
            // Attempt both sides: browser revocation can succeed while the backend is offline and vice versa.
            const results = await Promise.allSettled([
              navigator.serviceWorker.getRegistration(pushScope(key)).then(async (registration) => {
                const subscription = await registration?.pushManager.getSubscription()
                await subscription?.unsubscribe()
              }),
              api(conn).remove(record.id),
            ])
            if (results.some((result) => result.status === "fulfilled")) setState("active", key, false)
            if (results.some((result) => result.status === "rejected")) throw new Error("Push revocation is incomplete")
            settled()
            return
          }
          if (permission && (await permission) !== "granted") throw new Error("Push permission was not granted")
          if (pushAvailability()) throw new Error("Push notifications are unavailable")
          const configuration = await api(conn).configuration()
          const registration = await pushRegistration(key)
          const existing = await registration.pushManager.getSubscription()
          const bytes = pushKey(configuration.publicKey)
          const previous = existing?.options.applicationServerKey
          const matches =
            previous &&
            new Uint8Array(previous).every((value, index) => value === bytes[index]) &&
            previous.byteLength === bytes.byteLength
          if (existing && !matches) await existing.unsubscribe()
          const subscription =
            existing && matches
              ? existing
              : await registration.pushManager.subscribe({
                  userVisibleOnly: true,
                  applicationServerKey: bytes,
                })
          const json = subscription.toJSON()
          if (!json.endpoint || !json.keys?.p256dh || !json.keys.auth) throw new Error("Incomplete push subscription")
          await api(conn).register(record.id, {
            ...payload,
            serverKey: key,
            subscription: { endpoint: json.endpoint, keys: { p256dh: json.keys.p256dh, auth: json.keys.auth } },
          })
          setState("active", key, true)
          settled()
        })
        .catch(() => setState("error", key, true))
        .finally(() => {
          if (pending.get(key) !== task) return
          pending.delete(key)
          setState("busy", key, false)
        })
      pending.set(key, task)
      return task
    }

    createEffect(() => {
      if (platform.platform !== "web" || !ready() || !("serviceWorker" in navigator)) return
      const connections = global.servers.list()
      const payload = JSON.stringify(options())
      connections.forEach((conn) => {
        const key = ServerConnection.key(conn)
        known.set(key, conn)
        const record = store.devices[key]
        if (!record || (!record.enabled && !record.pending)) return
        const snapshot = JSON.stringify([payload, conn.http, record])
        if (snapshots.get(key) === snapshot) return
        snapshots.set(key, snapshot)
        untrack(() => void sync(conn, record.enabled))
      })
      known.forEach((conn, key) => {
        if (connections.some((connection) => ServerConnection.key(connection) === key)) return
        known.delete(key)
        snapshots.delete(key)
        if (!store.devices[key]?.enabled) return
        setStore("devices", key, { ...store.devices[key], enabled: false, pending: true })
        untrack(() => void sync(conn, false))
      })
    })

    const refresh = () => {
      snapshots.clear()
      global.servers.list().forEach((conn) => {
        const record = store.devices[ServerConnection.key(conn)]
        if (record && (record.enabled || record.pending)) void sync(conn, record.enabled)
      })
    }
    const visible = () => {
      if (document.visibilityState === "visible") refresh()
    }
    if (platform.platform === "web") {
      window.addEventListener("online", refresh)
      document.addEventListener("visibilitychange", visible)
      onCleanup(() => {
        window.removeEventListener("online", refresh)
        document.removeEventListener("visibilitychange", visible)
      })
    }

    return {
      ready,
      state,
      enabled: (key: string) => store.devices[key]?.enabled === true,
      retry(conn: ServerConnection.Any) {
        const enable = store.devices[ServerConnection.key(conn)]?.enabled === true
        return sync(conn, enable, enable ? Notification.requestPermission().catch(() => "denied" as const) : undefined)
      },
      toggle(conn: ServerConnection.Any, enable: boolean) {
        const key = ServerConnection.key(conn)
        // Request permission directly in the user's click, before any network await (required by iOS).
        const permission = enable ? Notification.requestPermission().catch(() => "denied" as const) : undefined
        setStore("devices", key, { id: store.devices[key]?.id ?? crypto.randomUUID(), enabled: enable, pending: true })
        snapshots.set(key, JSON.stringify([JSON.stringify(options()), conn.http, store.devices[key]]))
        return sync(conn, enable, permission)
      },
      async test(conn: ServerConnection.Any) {
        const key = ServerConnection.key(conn)
        const record = store.devices[key]
        if (!record) return
        setState("busy", key, true)
        setState("error", key, false)
        await api(conn)
          .test(record.id)
          .then(async (sent) => {
            if (sent) return
            setState("error", key, true)
            setState("active", key, false)
            const registration = await navigator.serviceWorker.getRegistration(pushScope(key))
            const subscription = await registration?.pushManager.getSubscription()
            await subscription?.unsubscribe()
          })
          .catch(() => setState("error", key, true))
          .finally(() => setState("busy", key, false))
      },
    }
  },
})
