import { batch, createEffect, createMemo, on, onCleanup, untrack } from "solid-js"
import { isRevisionConflict, type ProfileDocument, type ProfileSnapshot } from "@opencode/client/promise"
import { useGlobal } from "./runtime"
import { ServerConnection, useServers } from "./registry"
import { useTabs } from "@/shell/tabs/tabs"
import { usePlatform } from "@/runtime/platform/platform"
import { createApiForServer } from "./api"
import { profileSessionIDs, type ProfileSessionTarget } from "./tab-profile"
import {
  latestSessionInputAt,
  mergePortableProfiles,
  normalizePortableProfile,
  portableServerUrl,
  replayProfileOperations,
  sameProfile,
  type ProfileOperation,
} from "./server-profile"

export function ProfileSync() {
  const servers = useServers()
  const global = useGlobal()
  const tabs = useTabs()
  const platform = usePlatform()
  const homeConnection = createMemo(
    () =>
      servers.list.find((connection) => ServerConnection.key(connection) === servers.profile.home) ??
      servers.list.find((connection) => connection.type === "http" && !!portableServerUrl(connection)),
  )
  const identity = createMemo(() => {
    const home = homeConnection()
    return servers.hydrated() && tabs.ready() && home
      ? JSON.stringify([ServerConnection.key(home), home.http.url, home.http.password])
      : undefined
  })

  createEffect(
    on(identity, (key) => {
      const home = homeConnection()
      if (!key || !home) return
      const api = createApiForServer({ server: home.http, fetch: platform.fetch })
      const homeCtx = global.serverCtx(ServerConnection.key(home))
      const targets = (document: ProfileDocument): ProfileSessionTarget[] =>
        document.servers.flatMap((entry) => {
          const connection = servers.list.find((item) => portableServerUrl(item) === entry.url)
          return connection && entry.openSessionIDs !== undefined
            ? [{ key: ServerConnection.key(connection), url: entry.url, sessionIDs: entry.openSessionIDs }]
            : []
        })
      const read = (): ProfileDocument => {
        const document = servers.profile.read()
        return {
          ...document,
          servers: document.servers.map((entry) => {
            const connection = servers.list.find((item) => portableServerUrl(item) === entry.url)
            const inputAt = connection ? tabs.profile.inputAt(ServerConnection.key(connection)) : 0
            return {
              ...entry,
              openSessionIDs: connection
                ? profileSessionIDs([...tabs.store], { key: ServerConnection.key(connection), url: entry.url })
                : [],
              ...(inputAt ? { openSessionInputAt: inputAt } : {}),
            }
          }),
        }
      }
      let observed = untrack(read)
      const operations: ProfileOperation[] = observed.servers.flatMap((entry) =>
        entry.openSessionInputAt
          ? [
              {
                type: "session.update",
                url: entry.url,
                previousSessionIDs: [],
                sessionIDs: entry.openSessionIDs ?? [],
                inputAt: entry.openSessionInputAt,
              },
            ]
          : [],
      )
      let latest: ProfileSnapshot | undefined
      let running: Promise<void> | undefined
      let disposed = false
      let seeded = false
      let applying = false

      const apply = (snapshot: ProfileSnapshot) => {
        if (disposed) return
        latest = snapshot
        applying = true
        batch(() => {
          servers.profile.apply(snapshot.profile)
          tabs.profile.apply(targets(snapshot.profile))
        })
        observed = untrack(read)
        applying = false
      }

      const refresh = () => {
        if (disposed || running) return running
        let synced = false
        running = (async () => {
          for (let attempt = 0; attempt < 5 && !disposed; attempt++) {
            const remote = await api.profile.get()
            if (disposed) return
            const count = operations.length
            const local = untrack(read)
            const base = seeded
              ? normalizePortableProfile(remote.profile)
              : mergePortableProfiles(normalizePortableProfile(remote.profile), local)
            const pending = operations
              .slice(0, count)
              .map((operation) =>
                operation.type === "session.update"
                  ? {
                      ...operation,
                      inputAt: latestSessionInputAt(
                        operation.inputAt,
                        remote.profile.servers.find((entry) => entry.url === operation.url)?.openSessionInputAt,
                      ),
                    }
                  : operation,
              )
            const document = replayProfileOperations(base, pending)
            if (sameProfile(document, remote.profile)) {
              operations.splice(0, count)
              seeded = true
              apply(remote)
              synced = true
              return
            }
            try {
              const updated = await api.profile.replace({ revision: remote.revision, profile: document })
              operations.splice(0, count)
              seeded = true
              if (operations.length === 0) apply(updated)
              else latest = updated
              synced = true
              return
            } catch (error) {
              if (!isRevisionConflict(error)) throw error
            }
          }
        })()
          .catch(() => undefined)
          .finally(() => {
            running = undefined
            if (!disposed && synced && operations.length > 0 && latest) queueMicrotask(() => void refresh())
          })
        return running
      }

      createEffect(() => {
        const current = read()
        if (applying || sameProfile(current, observed)) return
        const previous = observed
        observed = current
        const before = new Map(previous.servers.map((entry) => [entry.url, entry]))
        const after = new Map(current.servers.map((entry) => [entry.url, entry]))
        previous.servers
          .filter((entry) => !after.has(entry.url))
          .forEach((entry) => operations.push({ type: "server.remove", url: entry.url }))
        current.servers.forEach((entry) => {
          const prior = before.get(entry.url)
          if (!prior || prior.name !== entry.name)
            operations.push({ type: "server.set", url: entry.url, name: entry.name })
          const previousProjects = new Set(prior?.projects.map((project) => project.worktree) ?? [])
          const projects = new Set(entry.projects.map((project) => project.worktree))
          prior?.projects
            .filter((project) => !projects.has(project.worktree))
            .forEach((project) =>
              operations.push({ type: "project.remove", url: entry.url, worktree: project.worktree }),
            )
          entry.projects.forEach((project, toIndex) => {
            if (!previousProjects.has(project.worktree))
              operations.push({ type: "project.open", url: entry.url, worktree: project.worktree })
            operations.push({ type: "project.move", url: entry.url, worktree: project.worktree, toIndex })
          })
          if (
            JSON.stringify(prior?.openSessionIDs ?? []) !== JSON.stringify(entry.openSessionIDs ?? []) ||
            prior?.openSessionInputAt !== entry.openSessionInputAt
          )
            operations.push({
              type: "session.update",
              url: entry.url,
              previousSessionIDs: prior?.openSessionIDs ?? [],
              sessionIDs: entry.openSessionIDs ?? [],
              ...(entry.openSessionInputAt ? { inputAt: entry.openSessionInputAt } : {}),
            })
        })
        untrack(() => void refresh())
      })

      const unsubscribe = homeCtx?.sdk.event.on("profile.updated", () => void refresh())
      const timer = setInterval(() => void refresh(), 10_000)
      const visible = () => {
        if (document.visibilityState === "visible") void refresh()
      }
      window.addEventListener("online", refresh)
      document.addEventListener("visibilitychange", visible)
      onCleanup(() => {
        disposed = true
        clearInterval(timer)
        unsubscribe?.()
        window.removeEventListener("online", refresh)
        document.removeEventListener("visibilitychange", visible)
      })
      untrack(() => void refresh())
    }),
  )
  return null
}
