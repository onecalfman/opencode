import type { ServerConnection } from "./server"
import { portableServerUrl } from "./server-profile"
import type { SessionTab, Tab } from "./tabs"

export type ProfileSessionTarget = {
  key: ServerConnection.Key
  url: string
  sessionIDs: string[]
}

export function profileSessionIDs(tabs: Tab[], target: Omit<ProfileSessionTarget, "sessionIDs">) {
  const seen = new Set<string>()
  return tabs.flatMap((tab) => {
    if (tab.type !== "session" || !matchesServer(tab.server, target)) return []
    if (!tab.sessionId.startsWith("ses") || seen.has(tab.sessionId)) return []
    seen.add(tab.sessionId)
    return [tab.sessionId]
  })
}

export function profileSessionTarget(server: ServerConnection.Key, targets: ProfileSessionTarget[]) {
  return targets.find((target) => matchesServer(server, target))
}

export function profileServersEqual(left: ServerConnection.Key, right: ServerConnection.Key) {
  if (left === right) return true
  const leftUrl = serverUrl(left)
  return !!leftUrl && leftUrl === serverUrl(right)
}

export function reconcileProfileSessionTabs(tabs: Tab[], targets: ProfileSessionTarget[]) {
  const byKey = new Map(targets.map((target) => [target.key, target]))
  const byUrl = new Map(targets.map((target) => [target.url, target]))
  const existing = new Map(
    tabs.flatMap((tab) => {
      if (tab.type !== "session") return []
      const url = serverUrl(tab.server)
      const target = byKey.get(tab.server) ?? (url ? byUrl.get(url) : undefined)
      return target ? ([[`${target.key}\n${tab.sessionId}`, tab]] as const) : []
    }),
  )
  const desired = targets.flatMap((target) => {
    const seen = new Set<string>()
    return target.sessionIDs.flatMap((sessionId) => {
      if (!sessionId.startsWith("ses") || seen.has(sessionId)) return []
      seen.add(sessionId)
      const current = existing.get(`${target.key}\n${sessionId}`)
      return [
        current?.server === target.key
          ? current
          : ({ type: "session", server: target.key, sessionId } satisfies SessionTab),
      ]
    })
  })
  let index = 0
  const next = tabs.flatMap<Tab>((tab) => {
    if (tab.type !== "session") return [tab]
    if (!byKey.has(tab.server) && !byUrl.has(serverUrl(tab.server) ?? "")) return [tab]
    const replacement = desired[index++]
    return replacement ? [replacement] : []
  })
  const remaining = desired.slice(index)
  if (remaining.length === 0) return next
  const last = next.findLastIndex(
    (tab) => tab.type === "session" && (byKey.has(tab.server) || byUrl.has(serverUrl(tab.server) ?? "")),
  )
  next.splice(last === -1 ? next.length : last + 1, 0, ...remaining)
  return next
}

function matchesServer(server: ServerConnection.Key, target: Omit<ProfileSessionTarget, "sessionIDs">) {
  return profileServersEqual(server, target.key) || serverUrl(server) === target.url
}

function serverUrl(server: ServerConnection.Key) {
  return portableServerUrl({ type: "http", http: { url: server } })
}
