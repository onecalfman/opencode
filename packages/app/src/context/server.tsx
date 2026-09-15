import { createSimpleContext } from "@opencode-ai/ui/context"
import type { ProfileSnapshot } from "@opencode-ai/sdk/v2/types"
import { type Accessor, batch, createMemo, onCleanup } from "solid-js"
import { createStore, type SetStoreFunction, type Store } from "solid-js/store"
import { Persist, persisted } from "@/utils/persist"
import { pathKey } from "@/utils/path-key"
import { ServerScope } from "@/utils/server-scope"
import { createSdkForServer } from "@/utils/server"
import { usePlatform } from "./platform"
import {
  applyProfileOperation,
  applyProfileProjects,
  applyProfileServers,
  mergeOpenSessionIDs,
  mergePortableProfiles,
  normalizePortableProfile,
  portableServerUrl,
  projectPortableProfile,
  replayProfileOperations,
  sameProfile,
  type ProfileOperation,
} from "./server-profile"
import type { ProfileSessionTarget } from "./tab-profile"

type StoredProject = { worktree: string; expanded: boolean }
type StoredServer = string | ServerConnection.HttpBase | ServerConnection.Http
type ServerProjectState = {
  projects: Record<string, StoredProject[]>
  lastProject: Record<string, string>
  recentlyClosed: Record<string, string[]>
}
type ServerProjectOperation =
  | { type: "project.open"; scope: ServerScope; worktree: string }
  | { type: "project.remove"; scope: ServerScope; worktree: string }
  | { type: "project.move"; scope: ServerScope; worktree: string; toIndex: number }
type ProfileSessionBridge = {
  ready: () => boolean
  read: (target: Omit<ProfileSessionTarget, "sessionIDs">) => string[]
  apply: (targets: ProfileSessionTarget[]) => void
}
const HEALTH_POLL_INTERVAL_MS = 10_000
// The store retains more history than is displayed. Consumers filter recently closed entries
// against the live project list (dropping deleted projects) and then cap the visible count via
// RECENTLY_CLOSED_DISPLAY_LIMIT. Retaining extra history ensures entries that are temporarily
// filtered out do not evict still-visible ones from the persisted store.
const RECENTLY_CLOSED_HISTORY_LIMIT = 16
export const RECENTLY_CLOSED_DISPLAY_LIMIT = 5

export function normalizeServerUrl(input: string) {
  const trimmed = input.trim()
  if (!trimmed) return
  const withProtocol = /^https?:\/\//.test(trimmed) ? trimmed : `http://${trimmed}`
  return withProtocol.replace(/\/+$/, "")
}

export function serverName(conn?: ServerConnection.Any, ignoreDisplayName = false) {
  if (!conn) return ""
  if (conn.displayName && !ignoreDisplayName) return conn.displayName
  return conn.http.url.replace(/^https?:\/\//, "").replace(/\/+$/, "")
}

function isLocalHost(url: string) {
  const host = url.replace(/^https?:\/\//, "").split(":")[0]
  if (host === "localhost" || host === "127.0.0.1") return "local"
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function migrateCanonicalLocalServerState(value: unknown, canonicalLocalServer?: ServerConnection.Key) {
  if (!canonicalLocalServer || canonicalLocalServer === "local") return value
  if (!isRecord(value)) return value
  const projects = isRecord(value.projects) ? value.projects : undefined
  const lastProject = isRecord(value.lastProject) ? value.lastProject : undefined
  const previousProjects = projects?.[canonicalLocalServer]
  const previousLastProject = lastProject?.[canonicalLocalServer]
  if (!Array.isArray(previousProjects) && typeof previousLastProject !== "string") return value

  const next = { ...value }
  if (projects && Array.isArray(previousProjects)) {
    const local = Array.isArray(projects.local) ? projects.local : []
    const worktrees = new Set(
      local.flatMap((project) => (isRecord(project) && typeof project.worktree === "string" ? [project.worktree] : [])),
    )
    const migrated = previousProjects.filter((project) => {
      if (!isRecord(project) || typeof project.worktree !== "string") return true
      if (worktrees.has(project.worktree)) return false
      worktrees.add(project.worktree)
      return true
    })
    const nextProjects: Record<string, unknown> = { ...projects, local: [...local, ...migrated] }
    delete nextProjects[canonicalLocalServer]
    next.projects = nextProjects
  }
  if (lastProject && typeof previousLastProject === "string") {
    const nextLastProject = { ...lastProject }
    if (typeof nextLastProject.local !== "string") nextLastProject.local = previousLastProject
    delete nextLastProject[canonicalLocalServer]
    next.lastProject = nextLastProject
  }
  return next
}

export function createServerProjects<T extends ServerProjectState>(input: {
  scope: Accessor<ServerScope>
  store: Store<T>
  setStore: SetStoreFunction<T>
  onChange?: (operation: ServerProjectOperation) => void
}) {
  const setStore = input.setStore as unknown as SetStoreFunction<ServerProjectState>
  const current = () => input.store.projects[input.scope()] ?? []
  const currentClosed = () => input.store.recentlyClosed?.[input.scope()] ?? []
  const remove = (directory: string) => {
    const scope = input.scope()
    if (!current().some((project) => project.worktree === directory)) return
    setStore(
      "projects",
      scope,
      current().filter((project) => project.worktree !== directory),
    )
    input.onChange?.({ type: "project.remove", scope, worktree: directory })
  }
  return {
    list: current,
    recentlyClosed: currentClosed,
    remove,
    open(directory: string) {
      const scope = input.scope()
      const key = pathKey(directory)
      const closed = currentClosed()
      if (closed.some((worktree) => pathKey(worktree) === key)) {
        setStore(
          "recentlyClosed",
          scope,
          closed.filter((worktree) => pathKey(worktree) !== key),
        )
      }
      if (current().some((project) => project.worktree === directory)) return
      setStore("projects", scope, [{ worktree: directory, expanded: true }, ...current()])
      input.onChange?.({ type: "project.open", scope, worktree: directory })
    },
    // User-initiated close: removes the project and records it in recently closed.
    // Internal, non-user removals (e.g. sandbox/worktree normalization) should use remove().
    close(directory: string) {
      remove(directory)
      const key = pathKey(directory)
      const closed = [directory, ...currentClosed().filter((worktree) => pathKey(worktree) !== key)].slice(
        0,
        RECENTLY_CLOSED_HISTORY_LIMIT,
      )
      setStore("recentlyClosed", input.scope(), closed)
    },
    expand(directory: string) {
      const index = current().findIndex((project) => project.worktree === directory)
      if (index !== -1) setStore("projects", input.scope(), index, "expanded", true)
    },
    collapse(directory: string) {
      const index = current().findIndex((project) => project.worktree === directory)
      if (index !== -1) setStore("projects", input.scope(), index, "expanded", false)
    },
    move(directory: string, toIndex: number) {
      const scope = input.scope()
      const fromIndex = current().findIndex((project) => project.worktree === directory)
      if (fromIndex === -1 || fromIndex === toIndex) return
      const next = [...current()]
      const [item] = next.splice(fromIndex, 1)
      next.splice(toIndex, 0, item)
      setStore("projects", scope, next)
      input.onChange?.({
        type: "project.move",
        scope,
        worktree: directory,
        toIndex: next.findIndex((project) => project.worktree === directory),
      })
    },
    last() {
      return input.store.lastProject[input.scope()]
    },
    touch(directory: string) {
      setStore("lastProject", input.scope(), directory)
    },
  }
}

export function resolveServerList(input: {
  props?: Array<ServerConnection.Any>
  stored: StoredServer[]
}): Array<ServerConnection.Any> {
  const identity = (server: ServerConnection.Any) => portableServerUrl(server) ?? ServerConnection.key(server)
  const deduped = new Map<string, ServerConnection.Any>(input.props?.map((server) => [identity(server), server]) ?? [])

  for (const value of input.stored) {
    const conn = storedHttpConnection(value)
    const key = identity(conn)

    const existing = deduped.get(key)
    if (existing)
      deduped.set(key, {
        ...existing,
        ...conn,
        http: {
          ...conn.http,
          ...existing.http,
          username: existing.http.username ?? conn.http.username,
          password: existing.http.password ?? conn.http.password,
        },
      })
    else deduped.set(key, conn)
  }

  return [...deduped.values()]
}

function storedHttpConnection(value: StoredServer): ServerConnection.Http {
  if (typeof value === "string") return { type: "http", http: { url: value } }
  if ("http" in value) return value
  return { type: "http", http: value }
}

export namespace ServerConnection {
  type Base = { displayName?: string; label?: string }

  export type HttpBase = {
    url: string
    username?: string
    password?: string
  }

  // Regular web connections
  export type Http = {
    type: "http"
    http: HttpBase
    authToken?: boolean
  } & Base

  export type Sidecar = {
    type: "sidecar"
    http: HttpBase
  } & (
    | // Regular desktop server
    { variant: "base" }
    // WSL server (windows only)
    | {
        variant: "wsl"
        distro: string
      }
  ) &
    Base

  // Remote server desktop can SSH into
  export type Ssh = {
    type: "ssh"
    host: string
    // SSH client exposes an HTTP server for the app to use as a proxy
    http: HttpBase
  } & Base

  export type Any =
    | Http
    // All these are desktop-only
    | (Sidecar | Ssh)

  export const key = (conn: Any): Key => {
    switch (conn.type) {
      case "http":
        return Key.make(conn.http.url)
      case "sidecar": {
        if (conn.variant === "wsl") return Key.make(`wsl:${conn.distro}`)
        return Key.make("sidecar")
      }
      case "ssh":
        return Key.make(`ssh:${conn.host}`)
    }
  }

  export type Key = string & { _brand: "Key" }
  export const Key = { make: (v: string) => v as Key }

  export const builtin = (conn: Any) => conn.type === "sidecar" && conn.variant === "base"
  export const local = (conn?: Any) =>
    !!conn && (builtin(conn) || (conn.type === "http" && isLocalHost(conn.http.url) === "local"))
}

export function nextServerAfterRemoval(
  servers: ServerConnection.Any[],
  removed: ServerConnection.Key,
  fallback: ServerConnection.Key,
) {
  const remaining = servers.filter((server) => ServerConnection.key(server) !== removed)
  const next = remaining.find((server) => ServerConnection.key(server) === fallback) ?? remaining[0]
  return next ? ServerConnection.key(next) : fallback
}

export const { use: useServer, provider: ServerProvider } = createSimpleContext({
  name: "Server",
  gate: true,
  init: (props: {
    defaultServer: ServerConnection.Key
    canonicalLocalServer?: ServerConnection.Key
    servers?: Array<ServerConnection.Any>
  }) => {
    const platform = usePlatform()
    const [store, setStore, _, ready] = persisted(
      {
        ...Persist.global("server", ["server.v3"]),
        migrate: (value) => migrateCanonicalLocalServerState(value, props.canonicalLocalServer),
      },
      createStore({
        list: [] as StoredServer[],
        projects: {} as Record<string, StoredProject[]>,
        lastProject: {} as Record<string, string>,
        recentlyClosed: {} as Record<string, string[]>,
        profileImported: false,
        profileSessionImported: {} as Record<string, true>,
        profilePending: [] as ProfileOperation[],
      }),
    )

    const url = (x: StoredServer) => (typeof x === "string" ? x : "type" in x ? x.http.url : x.url)

    const allServers = createMemo((): Array<ServerConnection.Any> => {
      return resolveServerList({ stored: store.list, props: props.servers })
    })

    const [state, setState] = createStore({
      active: props.defaultServer,
    })
    const scope = (key = state.active) => ServerScope.fromServerKey(key, props.canonicalLocalServer)
    const home = props.canonicalLocalServer
      ? props.servers?.find((server) => ServerConnection.key(server) === props.canonicalLocalServer)
      : undefined
    const homeUrl = home ? portableServerUrl(home) : undefined
    const profileScope = (serverUrl: string) => {
      if (serverUrl === homeUrl) return ServerScope.local
      const connection = allServers().find((server) => portableServerUrl(server) === serverUrl)
      return scope(connection ? ServerConnection.key(connection) : ServerConnection.Key.make(serverUrl))
    }
    const abort = new AbortController()
    const profileClient = createMemo(() => {
      const effectiveHome = props.canonicalLocalServer
        ? allServers().find((server) => ServerConnection.key(server) === props.canonicalLocalServer)
        : undefined
      return effectiveHome
        ? createSdkForServer({
            server: effectiveHome.http,
            fetch: platform.fetch,
            signal: abort.signal,
            throwOnError: false,
          })
        : undefined
    })
    const profileState = {
      revision: undefined as number | undefined,
      base: { version: 1, servers: [] } as ProfileSnapshot["profile"],
      pending: [] as ProfileOperation[],
      deferred: undefined as ProfileSnapshot | undefined,
      hydrated: false,
      applying: false,
      disabled: false,
      disposed: false,
      storageReady: false,
      sending: false,
      loading: undefined as Promise<void> | undefined,
      retryAttempt: 0,
      retryTimer: undefined as ReturnType<typeof setTimeout> | undefined,
      sessionBridge: undefined as ProfileSessionBridge | undefined,
      sessionSynced: new Set<string>(),
      sessionInputAt: new Map<string, number>(),
    }

    const localProfile = () =>
      projectPortableProfile({
        servers: allServers(),
        projects: (serverUrl) => store.projects[profileScope(serverUrl)] ?? [],
      })

    const disableUnsupported = (status?: number) => {
      if (status !== 404 && status !== 405) return false
      profileState.disabled = true
      profileState.pending = []
      if (profileState.retryTimer) clearTimeout(profileState.retryTimer)
      profileState.retryTimer = undefined
      if (!profileState.disposed) setStore("profilePending", [])
      return true
    }

    const retryableStatus = (status?: number) =>
      status === undefined || status === 408 || status === 429 || status >= 500

    const applySnapshot = (snapshot: ProfileSnapshot) => {
      if (profileState.disabled || profileState.disposed) return
      if (profileState.revision !== undefined && snapshot.revision < profileState.revision) return
      profileState.retryAttempt = 0
      if (profileState.retryTimer) clearTimeout(profileState.retryTimer)
      profileState.retryTimer = undefined
      const base = normalizePortableProfile(snapshot.profile)
      profileState.revision = snapshot.revision
      profileState.base = base
      const desired = replayProfileOperations(base, profileState.pending)
      const portableUrls = allServers().flatMap((server) => {
        const serverUrl = portableServerUrl(server)
        return serverUrl ? [serverUrl] : []
      })
      const projects = applyProfileProjects({
        profile: desired,
        projects: store.projects,
        portableUrls,
        scope: profileScope,
      })
      const suppliedUrls = new Set(
        props.servers?.flatMap((server) => {
          const serverUrl = portableServerUrl(server)
          return serverUrl ? [serverUrl] : []
        }),
      )
      const storedProfile = {
        ...desired,
        servers: desired.servers.filter((server) => !suppliedUrls.has(server.url)),
      }
      const localServers = store.list.map(storedHttpConnection)
      const suppliedConnections = new Map(
        props.servers?.flatMap((server) => {
          const serverUrl = portableServerUrl(server)
          return serverUrl && server.type === "http" ? [[serverUrl, server] as const] : []
        }),
      )
      const suppliedOverlays = [...suppliedConnections].flatMap(([serverUrl, supplied]) => {
        const current = resolveServerList({
          stored: localServers.filter((server) => portableServerUrl(server) === serverUrl),
        }).find((server) => server.type === "http")
        const remote = desired.servers.find((server) => server.url === serverUrl)
        if (!current && !remote?.name) return []
        return [
          {
            ...(current ?? { type: "http" as const, http: { url: supplied.http.url } }),
            displayName: remote?.name,
          },
        ]
      })
      const servers = [
        ...suppliedOverlays,
        ...applyProfileServers(
          localServers.filter((server) => {
            const serverUrl = portableServerUrl(server)
            return !serverUrl || !suppliedUrls.has(serverUrl)
          }),
          storedProfile,
        ),
      ]
      const nextServers = resolveServerList({ stored: servers, props: props.servers })
      const nextActive = nextServers.some((server) => ServerConnection.key(server) === state.active)
        ? state.active
        : ServerConnection.key(
            nextServers.find((server) => ServerConnection.key(server) === props.defaultServer) ?? nextServers[0],
          )
      profileState.applying = true
      batch(() => {
        setStore("list", servers)
        setStore("projects", projects)
        if (nextActive && nextActive !== state.active) setState("active", nextActive)
      })
      profileState.applying = false
      applyProfileSessions(desired)
    }

    function applyProfileSessions(profile = replayProfileOperations(profileState.base, profileState.pending)) {
      const bridge = profileState.sessionBridge
      if (!bridge?.ready()) return
      const targets = profile.servers.flatMap((item) => {
        if (item.openSessionIDs === undefined) return []
        if (!store.profileSessionImported[item.url]) return []
        const connection = allServers().find((server) => portableServerUrl(server) === item.url)
        if (!connection) return []
        profileState.sessionSynced.add(item.url)
        return [{ key: ServerConnection.key(connection), url: item.url, sessionIDs: [...item.openSessionIDs] }]
      })
      if (targets.length > 0) bridge.apply(targets)
    }

    function sessionTabsChanged() {
      const bridge = profileState.sessionBridge
      if (!bridge?.ready() || !profileState.hydrated || profileState.disabled || profileState.disposed) return
      const desired = replayProfileOperations(profileState.base, profileState.pending)
      const targets: ProfileSessionTarget[] = []
      allServers().forEach((connection) => {
        const serverUrl = portableServerUrl(connection)
        if (!serverUrl) return
        const key = ServerConnection.key(connection)
        const sessionIDs = bridge.read({ key, url: serverUrl })
        const remote = desired.servers.find((item) => item.url === serverUrl)
        if (!profileState.sessionSynced.has(serverUrl) && !store.profileSessionImported[serverUrl]) {
          if (remote?.openSessionInputAt !== undefined) {
            profileState.sessionSynced.add(serverUrl)
            targets.push({ key, url: serverUrl, sessionIDs: [...(remote.openSessionIDs ?? [])] })
            setStore("profileSessionImported", serverUrl, true)
            return
          }
          const merged = mergeOpenSessionIDs(remote?.openSessionIDs ?? [], sessionIDs)
          profileState.sessionSynced.add(serverUrl)
          enqueueProfileOperation({
            type: "session.merge",
            url: serverUrl,
            sessionIDs: merged,
          })
          targets.push({ key, url: serverUrl, sessionIDs: merged })
          setStore("profileSessionImported", serverUrl, true)
          return
        }
        if (!profileState.sessionSynced.has(serverUrl) && remote?.openSessionIDs !== undefined) {
          profileState.sessionSynced.add(serverUrl)
          targets.push({ key, url: serverUrl, sessionIDs: [...remote.openSessionIDs] })
          return
        }
        profileState.sessionSynced.add(serverUrl)
        if (remote?.openSessionIDs === undefined) {
          enqueueProfileOperation({ type: "session.merge", url: serverUrl, sessionIDs })
          return
        }
        if (
          remote.openSessionIDs.length === sessionIDs.length &&
          remote.openSessionIDs.every((sessionID, index) => sessionID === sessionIDs[index])
        )
          return
        enqueueProfileOperation({
          type: "session.update",
          url: serverUrl,
          previousSessionIDs: [...remote.openSessionIDs],
          sessionIDs,
          inputAt: profileState.sessionInputAt.get(serverUrl),
        })
      })
      if (targets.length > 0) bridge.apply(targets)
    }

    function registerSessionBridge(bridge: ProfileSessionBridge) {
      profileState.sessionBridge = bridge
      profileState.sessionSynced.clear()
      if (profileState.hydrated) {
        applyProfileSessions()
        sessionTabsChanged()
      }
      return () => {
        if (profileState.sessionBridge !== bridge) return
        profileState.sessionBridge = undefined
        profileState.sessionSynced.clear()
      }
    }

    function sessionInput(input: { url: string; timeCreated: number }) {
      const serverUrl = portableServerUrl({ type: "http", http: { url: input.url } })
      if (!serverUrl) return
      const previous = profileState.sessionInputAt.get(serverUrl)
      if (previous !== undefined && previous > input.timeCreated) return
      profileState.sessionInputAt.set(serverUrl, input.timeCreated)
      const bridge = profileState.sessionBridge
      if (!bridge?.ready() || profileState.disabled || profileState.disposed) return
      const connection = allServers().find((server) => portableServerUrl(server) === serverUrl)
      if (!connection) return
      const key = ServerConnection.key(connection)
      const desired = replayProfileOperations(profileState.base, profileState.pending)
      enqueueProfileOperation({
        type: "session.update",
        url: serverUrl,
        previousSessionIDs: desired.servers.find((server) => server.url === serverUrl)?.openSessionIDs ?? [],
        sessionIDs: bridge.read({ key, url: serverUrl }),
        inputAt: input.timeCreated,
      })
    }

    const getProfile = () =>
      profileClient()
        ?.v2.profile.get({ throwOnError: false })
        .catch(() => undefined)
    const replaceProfile = (snapshot: ProfileSnapshot) =>
      profileClient()
        ?.v2.profile.replace(
          { profileReplaceInput: { revision: snapshot.revision, profile: snapshot.profile } },
          { throwOnError: false },
        )
        .catch(() => undefined)

    const importProfile = async (
      snapshot: ProfileSnapshot,
      local: ProfileSnapshot["profile"],
      attempts = 0,
    ): Promise<ProfileSnapshot | undefined> => {
      const merged = mergePortableProfiles(normalizePortableProfile(snapshot.profile), local)
      if (sameProfile(merged, snapshot.profile)) return snapshot
      const result = await replaceProfile({ revision: snapshot.revision, profile: merged })
      if (profileState.disposed) return undefined
      const status = result?.response?.status
      if (!result || disableUnsupported(status)) {
        if (!result) scheduleProfileRetry()
        return undefined
      }
      if (status === 200 && result.data) return result.data
      if (status !== 409) {
        if (retryableStatus(status)) scheduleProfileRetry()
        return undefined
      }
      const latest = await getProfile()
      if (profileState.disposed) return undefined
      if (!latest || disableUnsupported(latest.response?.status)) {
        if (!latest) scheduleProfileRetry()
        return undefined
      }
      if (latest.response?.status !== 200 || !latest.data) {
        if (retryableStatus(latest.response?.status)) scheduleProfileRetry()
        return undefined
      }
      if (attempts >= 4) {
        scheduleProfileRetry()
        return undefined
      }
      return importProfile(latest.data, local, attempts + 1)
    }

    const completeHydration = (snapshot: ProfileSnapshot) => {
      applySnapshot(snapshot)
      if (profileState.disposed) return
      profileState.hydrated = true
      profileState.retryAttempt = 0
      if (profileState.retryTimer) clearTimeout(profileState.retryTimer)
      profileState.retryTimer = undefined
      const deferred = profileState.deferred
      profileState.deferred = undefined
      if (deferred) applySnapshot(deferred)
      sessionTabsChanged()
      if (profileState.pending.length > 0) void flushProfile()
    }

    const hydrateProfile = (): Promise<void> | undefined => {
      if (
        !profileClient() ||
        !profileState.storageReady ||
        profileState.disabled ||
        profileState.disposed ||
        profileState.hydrated
      )
        return undefined
      if (profileState.loading) return profileState.loading
      const loading = (async () => {
        const result = await getProfile()
        if (profileState.disposed) return
        if (!result || disableUnsupported(result.response?.status)) {
          if (!result) scheduleProfileRetry()
          return
        }
        if (result.response?.status !== 200 || !result.data) {
          if (retryableStatus(result.response?.status)) scheduleProfileRetry()
          return
        }
        if (store.profileImported) {
          completeHydration(result.data)
          return
        }
        const imported = await importProfile(result.data, localProfile())
        if (!imported || profileState.disposed) return
        setStore("profileImported", true)
        completeHydration(imported)
      })().finally(() => {
        if (profileState.loading === loading) profileState.loading = undefined
      })
      profileState.loading = loading
      return loading
    }

    const pullProfile = (): Promise<void> | undefined => {
      if (
        !profileClient() ||
        !profileState.storageReady ||
        profileState.disabled ||
        profileState.disposed ||
        profileState.loading
      )
        return undefined
      if (!profileState.hydrated) return hydrateProfile()
      if (profileState.sending || profileState.pending.length > 0) return flushProfile()
      const loading = (async () => {
        const result = await getProfile()
        if (profileState.disposed) return
        if (!result || disableUnsupported(result.response?.status)) {
          if (!result) scheduleProfileRetry()
          return
        }
        if (result.response?.status === 200 && result.data) applySnapshot(result.data)
        if (result.response?.status !== 200 && retryableStatus(result.response?.status)) scheduleProfileRetry()
      })().finally(() => {
        if (profileState.loading === loading) profileState.loading = undefined
      })
      profileState.loading = loading
      return loading
    }

    const enqueueProfileOperation = (operation: ProfileOperation) => {
      if (!home || profileState.applying || profileState.disabled || profileState.disposed) return
      if (!profileState.hydrated) {
        profileState.pending.push(operation)
        setStore("profilePending", [...profileState.pending])
        return
      }
      const current = replayProfileOperations(profileState.base, profileState.pending)
      if (sameProfile(current, applyProfileOperation(current, operation))) return
      profileState.pending.push(operation)
      setStore("profilePending", [...profileState.pending])
      void flushProfile()
    }

    const scheduleProfileRetry = () => {
      if (profileState.retryTimer || profileState.disabled || profileState.disposed) return
      const delay = Math.min(1_000 * 2 ** profileState.retryAttempt, 30_000)
      profileState.retryAttempt += 1
      profileState.retryTimer = setTimeout(() => {
        profileState.retryTimer = undefined
        if (!profileState.hydrated) {
          void hydrateProfile()
          return
        }
        if (profileState.pending.length > 0) {
          void flushProfile()
          return
        }
        void pullProfile()
      }, delay)
    }

    async function flushProfile() {
      if (
        !profileClient() ||
        profileState.disabled ||
        profileState.disposed ||
        !profileState.hydrated ||
        profileState.sending ||
        profileState.revision === undefined ||
        profileState.pending.length === 0
      )
        return

      profileState.sending = true
      if (profileState.retryTimer) clearTimeout(profileState.retryTimer)
      profileState.retryTimer = undefined
      const count = profileState.pending.length
      const revision = profileState.revision
      const desired = replayProfileOperations(profileState.base, profileState.pending.slice(0, count))
      const retry = await (async () => {
        const result = await replaceProfile({ revision, profile: desired })
        if (profileState.disposed) return false
        const status = result?.response?.status
        if (status === 200 && result?.data) {
          profileState.retryAttempt = 0
          profileState.pending.splice(0, count)
          setStore("profilePending", [...profileState.pending])
          applySnapshot(result.data)
        }

        const latest = status === 409 ? await getProfile() : undefined
        if (profileState.disposed) return false
        if (latest) disableUnsupported(latest.response?.status)
        if (latest?.response?.status === 200 && latest.data) {
          profileState.retryAttempt = 0
          applySnapshot(latest.data)
        }
        if (status !== undefined) disableUnsupported(status)
        if ((status === 200 || latest?.response?.status === 200) && profileState.pending.length > 0) return true
        if (retryableStatus(status) || (status === 409 && latest?.response?.status !== 200)) scheduleProfileRetry()
        return false
      })().finally(() => {
        profileState.sending = false
      })
      if (retry && !profileState.disposed) void flushProfile()
    }

    const projectChanged = (operation: ServerProjectOperation) => {
      const connection =
        operation.scope === ServerScope.local
          ? home
          : allServers().find((server) => String(ServerConnection.key(server)) === String(operation.scope))
      const serverUrl = connection ? portableServerUrl(connection) : undefined
      if (!serverUrl) return
      if (operation.type === "project.move") {
        enqueueProfileOperation({
          type: operation.type,
          url: serverUrl,
          worktree: operation.worktree,
          toIndex: operation.toIndex,
        })
        return
      }
      enqueueProfileOperation({ type: operation.type, url: serverUrl, worktree: operation.worktree })
    }

    const refreshProfile = (snapshot?: ProfileSnapshot): Promise<void> | undefined => {
      if (!snapshot) return pullProfile()
      if (!profileState.hydrated) {
        if (!profileState.deferred || snapshot.revision > profileState.deferred.revision)
          profileState.deferred = snapshot
        return undefined
      }
      applySnapshot(snapshot)
      if (profileState.pending.length > 0) void flushProfile()
      return undefined
    }

    const initializeProfile = async () => {
      if (ready.promise) await ready.promise.catch(() => undefined)
      if (profileState.disposed) return
      profileState.storageReady = true
      if (!profileClient()) {
        if (store.profilePending.length > 0) setStore("profilePending", [])
        return
      }
      profileState.pending = [...store.profilePending]
      await hydrateProfile()
    }
    void initializeProfile()
    const onFocus = () => {
      void refreshProfile()
    }
    if (home) window.addEventListener("focus", onFocus)
    if (home) window.addEventListener("online", onFocus)
    onCleanup(() => {
      profileState.disposed = true
      abort.abort()
      if (profileState.retryTimer) clearTimeout(profileState.retryTimer)
      if (home) window.removeEventListener("focus", onFocus)
      if (home) window.removeEventListener("online", onFocus)
    })

    function setActive(input: ServerConnection.Key) {
      if (state.active !== input) setState("active", input)
    }

    function add(input: ServerConnection.Http): ServerConnection.Http | undefined {
      const url_ = normalizeServerUrl(input.http.url)
      if (!url_) return undefined
      const conn: ServerConnection.Http = { ...input, authToken: undefined, http: { ...input.http, url: url_ } }
      const result = batch(() => {
        const existing = store.list.findIndex((x) => url(x) === url_)
        if (existing !== -1) {
          setStore("list", existing, conn)
        } else {
          setStore("list", store.list.length, conn)
        }
        setState("active", ServerConnection.key(conn))
        return conn
      })
      const serverUrl = portableServerUrl(conn)
      if (serverUrl) enqueueProfileOperation({ type: "server.set", url: serverUrl, name: conn.displayName })
      if (
        props.canonicalLocalServer &&
        (ServerConnection.key(conn) === props.canonicalLocalServer ||
          (serverUrl !== undefined && serverUrl === homeUrl))
      )
        void refreshProfile()
      return result
    }

    function remove(key: ServerConnection.Key) {
      const connection = allServers().find((server) => ServerConnection.key(server) === key)
      const serverUrl = connection ? portableServerUrl(connection) : undefined
      const next = nextServerAfterRemoval(allServers(), key, props.defaultServer)
      const list = store.list.filter((x) => url(x) !== key)
      batch(() => {
        setStore("list", list)
        if (state.active === key) setState("active", next)
      })
      const supplied = props.servers?.some((server) => ServerConnection.key(server) === key)
      if (serverUrl && !supplied) enqueueProfileOperation({ type: "server.remove", url: serverUrl })
    }

    const isReady = Object.assign(
      createMemo(() => ready() && !!state.active),
      { promise: ready.promise },
    )

    const projects = createServerProjects({ scope, store, setStore, onChange: projectChanged })
    const projectStores = new Map<ServerConnection.Key, ReturnType<typeof createServerProjects>>()
    const projectsForServer = (key: ServerConnection.Key) => {
      const existing = projectStores.get(key)
      if (existing) return existing
      const next = createServerProjects({ scope: () => scope(key), store, setStore, onChange: projectChanged })
      projectStores.set(key, next)
      return next
    }
    const current: Accessor<ServerConnection.Any | undefined> = createMemo(
      () => allServers().find((s) => ServerConnection.key(s) === state.active) ?? allServers()[0],
    )
    const isLocal = createMemo(() => ServerConnection.local(current()))

    return {
      ready: isReady,
      isLocal,
      get key() {
        return state.active
      },
      get name() {
        return serverName(current())
      },
      get list() {
        return allServers()
      },
      get current() {
        return current()
      },
      setActive,
      add,
      remove,
      profile: {
        home: home ? props.canonicalLocalServer : undefined,
        refresh: refreshProfile,
        sessions: {
          register: registerSessionBridge,
          changed: sessionTabsChanged,
          input: sessionInput,
        },
      },
      scope,
      projects: {
        ...projects,
        forServer: projectsForServer,
      },
    }
  },
})
