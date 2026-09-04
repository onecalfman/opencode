import type { ServerCtx } from "@/context/global"
import { tabKey, type Tab, type TabInfo } from "@/context/tabs"
import { projectForDirectory, projectForSession } from "@/pages/layout/helpers"

export function directoryForTab(tab: Tab, info: TabInfo | undefined, serverCtx: ServerCtx | undefined) {
  if (tab.type === "draft") return tab.directory
  return serverCtx?.sync.session.peek(tab.sessionId)?.directory ?? info?.directory
}

export function projectForTab(tab: Tab, info: TabInfo | undefined, serverCtx: ServerCtx | undefined) {
  const session = tab.type === "session" ? serverCtx?.sync.session.peek(tab.sessionId) : undefined
  const directory = directoryForTab(tab, info, serverCtx)
  if (!directory) return undefined
  const local = session
    ? projectForSession(session, serverCtx?.projects.list() ?? [])
    : projectForDirectory(directory, serverCtx?.projects.list() ?? [])
  if (local) return local
  return session
    ? projectForSession(session, serverCtx?.sync.data.project ?? [])
    : projectForDirectory(directory, serverCtx?.sync.data.project ?? [])
}

export function projectGroupKeyForTab(tab: Tab, info: TabInfo | undefined, serverCtx: ServerCtx | undefined) {
  const project = projectForTab(tab, info, serverCtx)
  if (project) return project.id ?? project.worktree
  if (tab.type === "draft") return tab.worktree ?? tab.directory
  return (
    serverCtx?.sync.session.peek(tab.sessionId)?.projectID ??
    info?.projectID ??
    directoryForTab(tab, info, serverCtx) ??
    tabKey(tab)
  )
}
