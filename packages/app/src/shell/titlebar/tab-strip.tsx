import { createEffect, createMemo, createResource, For, onCleanup, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { DragDropProvider, PointerSensor } from "@dnd-kit/solid"
import { isSortable, useSortable } from "@dnd-kit/solid/sortable"
import { Accessibility, AutoScroller, Feedback, PointerActivationConstraints } from "@dnd-kit/dom"
import { RestrictToHorizontalAxis, RestrictToVerticalAxis } from "@dnd-kit/abstract/modifiers"
import { RestrictToElement } from "@dnd-kit/dom/modifiers"
import { arrayMove } from "@dnd-kit/helpers"
import { tabHref, tabKey, type SessionTab, type Tab } from "@/shell/tabs/tabs"
import { ServerConnection, serverName } from "@/runtime/server/registry"
import { DraftTabItem, TabNavItem } from "@/shell/titlebar/tab-nav"
import { useGlobal, useServerCtx, type ServerCtx } from "@/runtime/server/runtime"
import { useLanguage } from "@/runtime/i18n/language"
import { useCommand } from "@/shell/commands/command"
import { useTabs } from "@/shell/tabs/tabs"
import { useSessionTabAvatarState } from "@/shell/layout/project-avatar-state"
import { createTabComposerState } from "@/composer/persistence"
import { base64Encode } from "@opencode/util/encode"
import { showToast } from "@/shell/notifications/toast"
import { adjacentTabKey, mergeVisibleTabOrder } from "./tab-order"
import type { SessionInfo } from "@opencode/client/promise"
import { groupTabsByServerAndProject } from "./tab-group"
import { displayName } from "@opencode/ui/project-avatar"
import { pathKey } from "@/workspaces/path-key"
import { isProjectDirectory } from "@/workspaces/paths"
import { projectTag } from "@/shell/layout/helpers"

function SessionTabSlot(props: {
  tab: SessionTab
  id: string
  index: number
  active: boolean
  orientation: "horizontal" | "vertical"
  group?: string
  session: SessionInfo | undefined
  preparing: boolean
  unread: boolean
  loading: boolean
  fallbackTitle?: string
  onRename: (title: string) => Promise<void>
  onNavigate: (element: HTMLDivElement) => void
  onClose: () => void
}) {
  const sortable = useSortable({
    get group() {
      return props.group
    },
    get id() {
      return props.id
    },
    get index() {
      return props.index
    },
  })

  let ref!: HTMLDivElement

  return (
    <div
      ref={sortable.ref}
      data-titlebar-tab-slot
      data-tab-key={props.id}
      data-active={props.active}
      data-orientation={props.orientation}
      class="relative flex"
      classList={{
        "w-56 min-w-7 max-w-56 flex-shrink": props.orientation === "horizontal",
        "w-full shrink-0": props.orientation === "vertical",
      }}
    >
      <TabNavItem
        ref={(el) => {
          ref = el
        }}
        href={tabHref(props.tab)}
        server={props.tab.server}
        session={props.session}
        preparing={props.preparing}
        unread={props.unread}
        loading={props.loading}
        fallbackTitle={props.fallbackTitle}
        onRename={props.onRename}
        onNavigate={() => props.onNavigate(ref)}
        onClose={props.onClose}
        active={props.active}
        dragging={sortable.isDragSource()}
        orientation={props.orientation}
      />
    </div>
  )
}

function SessionTabEntry(props: {
  tab: SessionTab
  id: string
  index: number
  active: boolean
  orientation: "horizontal" | "vertical"
  group?: string
  serverCtx: ServerCtx | undefined
  onVisibleChange: (visible: boolean) => void
  onUnreadChange: (unread: boolean) => void
  onNavigate: (element: HTMLDivElement) => void
  onClose: () => void
}) {
  const tabs = useTabs()
  const language = useLanguage()
  const sdk = createMemo(() => props.serverCtx?.sdk ?? null)
  const pending = createMemo(() => tabs.pendingSession(props.tab.server, props.tab.sessionId))
  const cachedSession = createMemo(() => props.serverCtx?.data.session.get(props.tab.sessionId))
  const persisted = createMemo(() => tabs.info[props.id])

  const status = useSessionTabAvatarState(
    () => props.tab.server,
    () => props.tab.sessionId,
    () => true,
  )

  // A busy session shows its progress indicator instead of the unread dot.
  const unread = createMemo(() => status.unread() && !status.loading())

  const [loadedSession] = createResource(
    () => {
      if (pending()) return null
      const ctx = props.serverCtx

      return ctx ? { id: props.tab.sessionId, ctx } : null
    },
    ({ id, ctx }) =>
      ctx.data.session
        .sync(id)
        .then(() => ctx.data.session.get(id))
        .catch(() => undefined),
  )

  const session = createMemo(() => (pending() ? undefined : (cachedSession() ?? loadedSession())))
  const missingSession = createMemo(() => !pending() && !!props.serverCtx && !loadedSession.loading && !session())
  const visible = createMemo(() => !!pending() || !!session() || missingSession() || !!persisted()?.title)

  const rename = async (title: string) => {
    const value = session()
    const ctx = props.serverCtx

    if (!value || !ctx) return

    ctx.data.session.remember({ ...value, title })

    try {
      await ctx.sdk.api.session.update({ sessionID: value.id, title })
    } catch (err) {
      const current = session()
      const currentCtx = props.serverCtx

      if (current && currentCtx) currentCtx.data.session.remember({ ...current, title: value.title })
      showToast({
        title: language.t("common.requestFailed"),
        description: err instanceof Error ? err.message : undefined,
      })
    }
  }

  createEffect(() => props.onVisibleChange(visible()))
  createEffect(() => props.onUnreadChange(unread()))

  createEffect(() => {
    const ctx = props.serverCtx
    const value = session()

    if (!ctx || !value || props.active || ctx.sdk.connection.status() !== "connected") return

    const timer = window.setTimeout(
      () =>
        void Promise.allSettled([
          ctx.data.session.sync(value.id, { children: true }),
          // The selected timeline loads the transcript; inactive tabs need attention, metadata, and the inbox,
          // whose waiting work keeps the tab busy.
          ctx.data.session.permission.sync(value.id),
          ctx.data.session.form.sync(value.id),
          ctx.data.session.pending.sync(value.id),
        ]),
      300 + props.index * 50,
    )

    onCleanup(() => window.clearTimeout(timer))
  })

  createEffect(() => {
    const value = session()

    if (!value) return
    tabs.rememberSessionInfo(
      props.tab,
      value,
      props.serverCtx?.data.session.message.list(value.id).some((message) => message.type === "user") ?? false,
    )
    const current = sdk()

    if (!current) return
    createTabComposerState(tabs, props.tab, current.scope, {
      dir: base64Encode(value.location.directory),
      id: value.id,
    })
  })

  return (
    <Show when={visible()}>
      <SessionTabSlot
        tab={props.tab}
        id={props.id}
        index={props.index}
        active={props.active}
        orientation={props.orientation}
        group={props.group}
        session={session()}
        preparing={!!pending()}
        unread={unread()}
        loading={status.loading()}
        fallbackTitle={
          pending()
            ? language.t("session.tab.session")
            : (persisted()?.title ?? (missingSession() ? language.t("session.tab.unknown") : undefined))
        }
        onRename={rename}
        onNavigate={props.onNavigate}
        onClose={props.onClose}
      />
    </Show>
  )
}

function DraftTabSlot(props: {
  tab: Extract<Tab, { type: "draft" }>
  id: string
  index: number
  active: boolean
  orientation: "horizontal" | "vertical"
  group?: string
  tag?: string
  title: string
  onNavigate: (element: HTMLDivElement) => void
  onClose: () => void
}) {
  const sortable = useSortable({
    get group() {
      return props.group
    },
    get id() {
      return props.id
    },
    get index() {
      return props.index
    },
  })

  let ref!: HTMLDivElement

  return (
    <div
      ref={sortable.ref}
      data-titlebar-tab-slot
      data-tab-key={props.id}
      data-active={props.active}
      data-orientation={props.orientation}
      class="relative flex"
      classList={{
        "w-56 min-w-7 max-w-56 flex-shrink": props.orientation === "horizontal",
        "w-full shrink-0": props.orientation === "vertical",
      }}
    >
      <DraftTabItem
        ref={(el) => {
          ref = el
        }}
        href={tabHref(props.tab)}
        title={props.title}
        tag={props.tag}
        onNavigate={() => props.onNavigate(ref)}
        onClose={props.onClose}
        active={props.active}
        dragging={sortable.isDragSource()}
        orientation={props.orientation}
      />
    </div>
  )
}

export function TitlebarTabStrip(props: {
  orientation?: "horizontal" | "vertical"
  tabs: Tab[]
  currentTab: Tab | undefined
  onNavigate: (tab: Tab, el?: HTMLDivElement) => void
  onClose: (tab: Tab) => void
  onReorder: (keys: string[]) => void
}) {
  const global = useGlobal()
  const tabs = useTabs()
  const language = useLanguage()
  const command = useCommand()
  const vertical = () => props.orientation === "vertical"
  let listRef!: HTMLDivElement
  const [visibility, setVisibility] = createStore<Record<string, boolean>>({})
  const [unread, setUnread] = createStore<Record<string, boolean>>({})
  const projectForTab = (tab: Tab) => {
    const ctx = global.serverCtx(tab.server)
    const session = tab.type === "session" ? ctx?.data.session.get(tab.sessionId) : undefined
    const directory =
      tab.type === "draft"
        ? tab.directory
        : (session?.location.directory ??
          tabs.pendingSession(tab.server, tab.sessionId)?.draft.directory ??
          tabs.info[tabKey(tab)]?.directory)
    if (!directory) return
    const projects = [...(ctx?.projects.list() ?? []), ...(ctx?.sync.data.project ?? [])]
    return (
      projects.find((project) => project.id === session?.projectID && !!session) ??
      projects.find((project) => pathKey(project.worktree) === pathKey(directory)) ??
      projects
        .filter((project) => isProjectDirectory(project, directory))
        .sort((a, b) => b.worktree.length - a.worktree.length)[0] ?? { worktree: directory }
    )
  }
  const projectKey = (tab: Tab) => projectForTab(tab)?.worktree ?? tabKey(tab)
  // Render groups by these stable server/worktree keys so metadata refreshes retain tab hover and drag state.
  const groups = createMemo(() => groupTabsByServerAndProject(props.tabs, projectKey))
  const orderedTabs = createMemo(() =>
    vertical() ? groups().flatMap((group) => group.projects.flatMap((project) => project.tabs)) : props.tabs,
  )
  const visibleTabs = createMemo(() => orderedTabs().filter((tab) => tab.type === "draft" || visibility[tabKey(tab)]))
  const visibleTabIds = () => visibleTabs().map(tabKey)

  const renderTab = (tab: Tab) => {
    const id = tabKey(tab)
    let ref!: HTMLDivElement
    const visibleIndex = () => visibleTabs().findIndex((item) => tabKey(item) === id)
    const sortableIndex = () =>
      vertical()
        ? visibleTabs()
            .filter((item) => item.server === tab.server && projectKey(item) === projectKey(tab))
            .findIndex((item) => tabKey(item) === id)
        : visibleIndex()
    const group = () => (vertical() ? `${tab.server}\n${projectKey(tab)}` : undefined)
    useTabShortcut(visibleIndex, () => props.onNavigate(tab, ref))
    const serverCtx = useServerCtx(() =>
      global.servers.list().find((item) => ServerConnection.key(item) === tab.server),
    )
    if (tab.type === "session")
      return (
        <SessionTabEntry
          tab={tab}
          id={id}
          index={sortableIndex()}
          group={group()}
          active={props.currentTab === tab}
          orientation={vertical() ? "vertical" : "horizontal"}
          serverCtx={serverCtx()}
          onVisibleChange={(visible) => setVisibility(id, visible)}
          onUnreadChange={(value) => setUnread(id, value)}
          onNavigate={(element) => {
            ref = element
            props.onNavigate(tab, element)
          }}
          onClose={() => props.onClose(tab)}
        />
      )
    return (
      <DraftTabSlot
        tab={tab}
        id={id}
        index={sortableIndex()}
        group={group()}
        active={props.currentTab === tab}
        orientation={vertical() ? "vertical" : "horizontal"}
        title={language.t("session.tab.session")}
        tag={projectTag(projectForTab(tab) ?? { worktree: tab.directory })}
        onNavigate={(element) => {
          ref = element
          props.onNavigate(tab, element)
        }}
        onClose={() => props.onClose(tab)}
      />
    )
  }

  const projectLabel = (items: Tab[]) => {
    const tab = items[0]
    const project = tab ? projectForTab(tab) : undefined
    return project ? displayName(project) : language.t("session.tab.session")
  }

  command.register("titlebar-tab-cycle", () => [
    {
      id: `tab.prev`,
      category: "tab",
      title: "",
      keybind: `mod+option+ArrowLeft,ctrl+shift+tab`,
      hidden: true,
      onSelect: () => selectAdjacentTab(-1),
    },
    {
      id: `tab.next`,
      category: "tab",
      title: "",
      keybind: `mod+option+ArrowRight,ctrl+tab`,
      hidden: true,
      onSelect: () => selectAdjacentTab(1),
    },
    {
      id: "session.previous",
      category: language.t("command.category.session"),
      title: language.t("command.session.previous"),
      keybind: "alt+arrowup",
      onSelect: () => selectAdjacentTab(-1),
    },
    {
      id: "session.next",
      category: language.t("command.category.session"),
      title: language.t("command.session.next"),
      keybind: "alt+arrowdown",
      onSelect: () => selectAdjacentTab(1),
    },
    {
      id: "session.previous.unseen",
      category: language.t("command.category.session"),
      title: language.t("command.session.previous.unseen"),
      keybind: "shift+alt+arrowup",
      onSelect: () => selectAdjacentTab(-1, (key) => !!unread[key]),
    },
    {
      id: "session.next.unseen",
      category: language.t("command.category.session"),
      title: language.t("command.session.next.unseen"),
      keybind: "shift+alt+arrowdown",
      onSelect: () => selectAdjacentTab(1, (key) => !!unread[key]),
    },
  ])

  function selectAdjacentTab(offset: -1 | 1, include?: (key: string) => boolean) {
    const current = props.currentTab
    const key = adjacentTabKey(visibleTabIds(), current ? tabKey(current) : undefined, offset, include)
    const next = props.tabs.find((tab) => tabKey(tab) === key)

    if (next) props.onNavigate(next)
  }

  return (
    <div
      data-slot={vertical() ? "vertical-tabs" : "titlebar-tabs"}
      data-orientation={vertical() ? "vertical" : "horizontal"}
      class="relative min-w-0"
      classList={{ "min-h-0 overflow-hidden": vertical() }}
    >
      <div
        data-slot={vertical() ? "vertical-tabs-scroll" : "titlebar-tabs-scroll"}
        class="flex min-w-0 no-scrollbar [app-region:no-drag]"
        classList={{
          "flex-row items-center gap-1.5 overflow-x-auto": !vertical(),
          "max-h-full flex-col overflow-y-auto overflow-x-hidden": vertical(),
        }}
      >
        <DragDropProvider
          sensors={[
            PointerSensor.configure({
              activationConstraints: (event) =>
                event.pointerType === "touch"
                  ? [new PointerActivationConstraints.Distance({ value: 8 })]
                  : [new PointerActivationConstraints.Distance({ value: 4 })],
              preventActivation: (event) =>
                event.target instanceof Element &&
                !!event.target.closest('[data-slot="tab-close"], [contenteditable="true"]'),
            }),
          ]}
          modifiers={[
            vertical() ? RestrictToVerticalAxis : RestrictToHorizontalAxis,
            RestrictToElement.configure({ element: () => listRef }),
          ]}
          plugins={(defaults) => [
            ...defaults.filter((plugin) => plugin !== Accessibility),
            AutoScroller.configure({ acceleration: 8, threshold: vertical() ? { x: 0, y: 0.05 } : { x: 0.05, y: 0 } }),
            Feedback.configure({ dropAnimation: null }),
          ]}
          onDragStart={(event) => {
            const source = event.operation.source

            if (!source) return
            const tab = props.tabs.find((item) => tabKey(item) === source.id.toString())

            if (!tab) return

            if (vertical()) return
            const tabEl = source.element?.querySelector<HTMLDivElement>("[data-titlebar-tab]")
            props.onNavigate(tab, tabEl ?? undefined)
          }}
          onDragEnd={(event) => {
            const source = event.operation.source

            if (event.canceled || !isSortable(source)) return
            const sourceTab = props.tabs.find((tab) => tabKey(tab) === source.id.toString())
            const targetTab = props.tabs.find((tab) => tabKey(tab) === event.operation.target?.id.toString())
            if (!sourceTab) return
            if (
              vertical() &&
              targetTab &&
              (sourceTab.server !== targetTab.server || projectKey(sourceTab) !== projectKey(targetTab))
            )
              return
            const current = visibleTabs()
              .filter(
                (tab) => !vertical() || (tab.server === sourceTab.server && projectKey(tab) === projectKey(sourceTab)),
              )
              .map(tabKey)

            const { initialIndex, index } = source

            if (initialIndex !== index) {
              props.onReorder(
                mergeVisibleTabOrder(
                  props.tabs.map(tabKey),
                  current,
                  arrayMove(current, source.initialIndex, source.index),
                ),
              )
            }
          }}
        >
          <div
            data-titlebar-tab-list
            data-orientation={vertical() ? "vertical" : "horizontal"}
            class="flex w-full min-w-0"
            classList={{ "flex-row items-center": !vertical(), "flex-col items-stretch": vertical() }}
            ref={listRef}
          >
            <Show when={vertical()} fallback={<For each={props.tabs}>{renderTab}</For>}>
              <For each={groups().map((group) => group.server)}>
                {(server) => {
                  const projects = createMemo(() => groups().find((group) => group.server === server)?.projects ?? [])
                  return (
                    <section class="flex min-w-0 flex-col gap-1 pb-3">
                      <Show when={groups().length > 1}>
                        <h2 class="truncate px-1.5 text-[11px] font-semibold leading-4 text-v2-text-text-muted">
                          <bdi dir="auto">
                            {serverName(global.servers.list().find((item) => ServerConnection.key(item) === server)) ||
                              server}
                          </bdi>
                        </h2>
                      </Show>
                      <For each={projects().map((project) => project.project)}>
                        {(worktree) => {
                          const items = createMemo(
                            () => projects().find((project) => project.project === worktree)?.tabs ?? [],
                          )
                          return (
                            <section class="flex min-w-0 flex-col gap-1">
                              <h3 class="truncate px-1.5 text-[11px] font-medium leading-4 text-v2-text-text-muted">
                                <bdi dir="auto">{projectLabel(items())}</bdi>
                              </h3>
                              <For each={items()}>{renderTab}</For>
                            </section>
                          )
                        }}
                      </For>
                    </section>
                  )
                }}
              </For>
            </Show>
          </div>
        </DragDropProvider>
      </div>
      <Show when={!vertical()}>
        <div
          data-slot="titlebar-tabs-fade-left"
          aria-hidden="true"
          class="pointer-events-none absolute inset-y-0 left-0 z-10 w-6 bg-[linear-gradient(to_right,var(--v2-background-bg-deep),transparent)]"
        />
        <div
          data-slot="titlebar-tabs-fade-right"
          aria-hidden="true"
          class="pointer-events-none absolute inset-y-0 right-0 z-10 w-6 bg-[linear-gradient(to_left,var(--v2-background-bg-deep),transparent)]"
        />
      </Show>
    </div>
  )
}

function useTabShortcut(index: () => number, onSelect: () => void) {
  const command = useCommand()

  command.register(() => {
    const number = index() + 1

    if (number < 1 || number > 9) return []

    return [
      {
        id: `tab.${number}`,
        category: "tab",
        title: "",
        keybind: `mod+${number}`,
        hidden: true,
        onSelect,
      },
    ]
  })
}
