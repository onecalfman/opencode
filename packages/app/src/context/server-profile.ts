import type { ProfileDocument, ProfileServer } from "@opencode-ai/sdk/v2/types"

type Connection = {
  type: string
  http: { url: string; username?: string; password?: string }
  displayName?: string
  label?: string
  authToken?: boolean
}

export type ProfileLocalServer = {
  type: "http"
  http: {
    url: string
    username?: string
    password?: string
  }
  displayName?: string
  label?: string
  authToken?: boolean
}

export type ProfileLocalProject = { worktree: string; expanded: boolean }

export type ProfileOperation =
  | { type: "server.set"; url: string; name?: string }
  | { type: "server.remove"; url: string }
  | { type: "project.open"; url: string; worktree: string }
  | { type: "project.remove"; url: string; worktree: string }
  | { type: "project.move"; url: string; worktree: string; toIndex: number }
  | { type: "session.merge"; url: string; sessionIDs: string[] }
  | { type: "session.update"; url: string; previousSessionIDs: string[]; sessionIDs: string[] }

export function portableServerUrl(connection: Connection): string | undefined {
  if (connection.type !== "http") return undefined
  const value = connection.http.url.trim()
  if (!/^https?:\/\//i.test(value)) return undefined
  if (!URL.canParse(value)) return undefined
  const parsed = new URL(value)
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined
  const authority = value.slice(value.indexOf("//") + 2).split(/[/?#]/, 1)[0]
  if (authority.includes("@") || parsed.search || parsed.hash) return undefined
  const hostname = parsed.hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "")
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname === "0.0.0.0" ||
    hostname === "::" ||
    hostname === "::1" ||
    /^::ffff:(?:0:0|7f[0-9a-f]{2}:)/.test(hostname) ||
    hostname.startsWith("127.") ||
    parsed.port === "0"
  )
    return undefined
  parsed.hostname = parsed.hostname.replace(/\.$/, "")
  parsed.pathname = parsed.pathname.replace(/\/+$/, "")
  return parsed.href
}

export function projectPortableProfile(input: {
  servers: readonly Connection[]
  projects: (url: string) => readonly { worktree: string }[]
}): ProfileDocument {
  const seen = new Set<string>()
  return {
    version: 1,
    servers: input.servers.flatMap((connection) => {
      const url = portableServerUrl(connection)
      if (!url || seen.has(url)) return []
      seen.add(url)
      const server: ProfileServer = {
        url,
        projects: input.projects(url).map((project) => ({ worktree: project.worktree })),
      }
      if (connection.displayName) server.name = connection.displayName
      return [server]
    }),
  }
}

export function normalizePortableProfile(profile: ProfileDocument): ProfileDocument {
  const servers = new Map<string, ProfileServer>()
  profile.servers.forEach((server) => {
    const url = portableServerUrl({ type: "http", http: { url: server.url } })
    if (!url) return
    const normalized = {
      ...server,
      url,
      projects: dedupeProjects(server.projects),
      ...(server.openSessionIDs === undefined ? {} : { openSessionIDs: dedupeSessionIDs(server.openSessionIDs) }),
    }
    const current = servers.get(url)
    if (!current) {
      servers.set(url, normalized)
      return
    }
    const worktrees = new Set(current.projects.map((project) => project.worktree))
    servers.set(url, {
      ...current,
      name: current.name ?? server.name,
      ...(current.openSessionIDs === undefined && normalized.openSessionIDs === undefined
        ? {}
        : {
            openSessionIDs: mergeOpenSessionIDs(
              current.openSessionIDs ?? [],
              normalized.openSessionIDs ?? [],
            ),
          }),
      projects: [
        ...current.projects,
        ...server.projects.filter((project) => {
          if (worktrees.has(project.worktree)) return false
          worktrees.add(project.worktree)
          return true
        }),
      ],
    })
  })
  return { version: 1, servers: [...servers.values()] }
}

function dedupeSessionIDs(sessionIDs: readonly string[]) {
  const seen = new Set<string>()
  return sessionIDs.filter((sessionID) => {
    if (!sessionID.startsWith("ses") || seen.has(sessionID)) return false
    seen.add(sessionID)
    return true
  })
}

function dedupeProjects(projects: ProfileServer["projects"]) {
  const worktrees = new Set<string>()
  return projects.filter((project) => {
    if (worktrees.has(project.worktree)) return false
    worktrees.add(project.worktree)
    return true
  })
}

export function mergePortableProfiles(remote: ProfileDocument, local: ProfileDocument): ProfileDocument {
  const localByUrl = new Map(local.servers.map((server) => [server.url, server]))
  const merged = remote.servers.map((server) => {
    const localServer = localByUrl.get(server.url)
    if (!localServer) return server
    localByUrl.delete(server.url)
    const worktrees = new Set(server.projects.map((project) => project.worktree))
    const projects = [...server.projects, ...localServer.projects.filter((project) => !worktrees.has(project.worktree))]
    return {
      ...server,
      name: server.name ?? localServer.name,
      openSessionIDs: server.openSessionIDs ?? localServer.openSessionIDs,
      projects,
    }
  })
  return { version: 1, servers: [...merged, ...localByUrl.values()] }
}

export function mergeOpenSessionIDs(remote: readonly string[], local: readonly string[]) {
  return dedupeSessionIDs([...remote, ...local])
}

export function applyProfileServers(local: readonly ProfileLocalServer[], profile: ProfileDocument) {
  const existing = new Map(
    local.flatMap((server) => {
      const url = portableServerUrl(server)
      return url ? [[url, server] as const] : []
    }),
  )
  const excluded = local.filter((server) => !portableServerUrl(server))
  const remote = profile.servers.flatMap((server) => {
    const url = portableServerUrl({ type: "http", http: { url: server.url } })
    if (!url) return []
    const current = existing.get(url)
    const next: ProfileLocalServer = current
      ? { ...current, displayName: server.name }
      : { type: "http", displayName: server.name, http: { url } }
    return [next]
  })
  return [...excluded, ...remote]
}

export function applyProfileProjects(input: {
  profile: ProfileDocument
  projects: Readonly<Record<string, readonly ProfileLocalProject[]>>
  portableUrls: readonly string[]
  scope: (url: string) => string
}) {
  const next: Record<string, ProfileLocalProject[]> = Object.fromEntries(
    Object.entries(input.projects).map(([scope, projects]) => [scope, [...projects]]),
  )
  const remote = new Map(
    input.profile.servers.flatMap((server) => {
      const url = portableServerUrl({ type: "http", http: { url: server.url } })
      return url ? [[url, server] as const] : []
    }),
  )

  input.portableUrls.forEach((url) => {
    if (!remote.has(url)) delete next[input.scope(url)]
  })
  remote.forEach((server, url) => {
    const scope = input.scope(url)
    const expanded = new Map((next[scope] ?? []).map((project) => [project.worktree, project.expanded]))
    next[scope] = server.projects.map((project) => ({
      worktree: project.worktree,
      expanded: expanded.get(project.worktree) ?? true,
    }))
  })
  return next
}

export function applyProfileOperation(profile: ProfileDocument, operation: ProfileOperation): ProfileDocument {
  if (operation.type === "server.set") {
    const index = profile.servers.findIndex((server) => server.url === operation.url)
    const server: ProfileServer = {
      ...(index === -1 ? { url: operation.url, projects: [] } : profile.servers[index]),
      name: operation.name,
    }
    if (index === -1) return { ...profile, servers: [...profile.servers, server] }
    return { ...profile, servers: profile.servers.with(index, server) }
  }
  if (operation.type === "server.remove") {
    return { ...profile, servers: profile.servers.filter((server) => server.url !== operation.url) }
  }

  const index = profile.servers.findIndex((server) => server.url === operation.url)
  if (operation.type === "session.merge" || operation.type === "session.update") {
    const incoming = dedupeSessionIDs(operation.sessionIDs)
    if (index === -1) {
      return {
        ...profile,
        servers: [...profile.servers, { url: operation.url, projects: [], openSessionIDs: incoming }],
      }
    }
    const server = profile.servers[index]
    const sessionIDs =
      operation.type === "session.merge"
        ? mergeOpenSessionIDs(server.openSessionIDs ?? [], incoming)
        : updateOpenSessionIDs(server.openSessionIDs ?? [], operation.previousSessionIDs, incoming)
    if (
      server.openSessionIDs !== undefined &&
      server.openSessionIDs.length === sessionIDs.length &&
      server.openSessionIDs.every((sessionID, itemIndex) => sessionID === sessionIDs[itemIndex])
    )
      return profile
    return { ...profile, servers: profile.servers.with(index, { ...server, openSessionIDs: sessionIDs }) }
  }
  if (index === -1) {
    if (operation.type !== "project.open") return profile
    return {
      ...profile,
      servers: [...profile.servers, { url: operation.url, projects: [{ worktree: operation.worktree }] }],
    }
  }
  const server = profile.servers[index]
  if (operation.type === "project.open") {
    if (server.projects.some((project) => project.worktree === operation.worktree)) return profile
    return {
      ...profile,
      servers: profile.servers.with(index, {
        ...server,
        projects: [{ worktree: operation.worktree }, ...server.projects],
      }),
    }
  }
  if (operation.type === "project.remove") {
    const projects = server.projects.filter((project) => project.worktree !== operation.worktree)
    if (projects.length === server.projects.length) return profile
    return { ...profile, servers: profile.servers.with(index, { ...server, projects }) }
  }

  const fromIndex = server.projects.findIndex((project) => project.worktree === operation.worktree)
  if (fromIndex === -1 || fromIndex === operation.toIndex) return profile
  const projects = [...server.projects]
  const [project] = projects.splice(fromIndex, 1)
  projects.splice(Math.max(0, Math.min(operation.toIndex, projects.length)), 0, project)
  return { ...profile, servers: profile.servers.with(index, { ...server, projects }) }
}

function updateOpenSessionIDs(current: readonly string[], previous: readonly string[], desired: readonly string[]) {
  const before = new Set(dedupeSessionIDs(previous))
  const next = new Set(desired)
  const removed = new Set([...before].filter((sessionID) => !next.has(sessionID)))
  const added = new Set(desired.filter((sessionID) => !before.has(sessionID)))
  const alive = dedupeSessionIDs(current).filter((sessionID) => !removed.has(sessionID))
  const available = new Set([...alive, ...added])
  return [...desired.filter((sessionID) => available.has(sessionID)), ...alive.filter((sessionID) => !next.has(sessionID))]
}

export function replayProfileOperations(profile: ProfileDocument, operations: readonly ProfileOperation[]) {
  return operations.reduce(applyProfileOperation, profile)
}

export function sameProfile(left: ProfileDocument, right: ProfileDocument) {
  return JSON.stringify(left) === JSON.stringify(right)
}
