import { createEffect, createMemo, createResource, createRoot, For, onCleanup, onMount, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { createResizeObserver } from "@solid-primitives/resize-observer"
import { DragDropProvider, PointerSensor } from "@dnd-kit/solid"
import { isSortable, useSortable } from "@dnd-kit/solid/sortable"
import { Accessibility, AutoScroller, Feedback, PointerActivationConstraints } from "@dnd-kit/dom"
import { RestrictToHorizontalAxis, RestrictToVerticalAxis } from "@dnd-kit/abstract/modifiers"
import { RestrictToElement } from "@dnd-kit/dom/modifiers"
import { arrayMove } from "@dnd-kit/helpers"
import { tabHref, tabKey, type SessionTab, type Tab } from "@/context/tabs"
import { ServerConnection, serverName } from "@/context/server"
import { DraftTabItem, TabNavItem } from "@/components/titlebar-tab-nav"
import { useGlobal, type ServerCtx } from "@/context/global"
import { useLanguage } from "@/context/language"
import { useTabs } from "@/context/tabs"
import { createTabPromptState } from "@/context/prompt"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { showToast } from "@/utils/toast"
import { canStartTabDrag, isTabCloseTarget } from "./titlebar-tab-gesture"
import { mergeVisibleTabOrder } from "./titlebar-tab-order"
import { groupTabsByServer } from "./titlebar-tab-group"
import type { Session } from "@opencode-ai/sdk/v2"

export type TabOrientation = "horizontal" | "vertical"

function SessionTabSlot(props: {
  tab: SessionTab
  id: string
  index: () => number
  active: () => boolean
  forceTruncate: boolean
  session: () => Session | undefined
  fallbackTitle?: string
  onRename: (title: string) => Promise<void>
  onNavigate: (element: HTMLDivElement) => void
  onClose: () => void
  group?: string
}) {
  const sortable = useSortable({
    get id() {
      return props.id
    },
    get index() {
      return props.index()
    },
    get group() {
      return props.group
    },
  })
  let ref!: HTMLDivElement

  return (
    <div
      ref={sortable.ref}
      data-titlebar-tab-slot
      data-tab-key={props.id}
      data-active={props.active()}
      class="relative flex w-56 min-w-7 max-w-56 flex-shrink"
    >
      <TabNavItem
        ref={(el) => {
          ref = el
        }}
        href={tabHref(props.tab)}
        server={props.tab.server}
        session={props.session}
        fallbackTitle={props.fallbackTitle}
        onRename={props.onRename}
        onNavigate={() => props.onNavigate(ref)}
        onClose={props.onClose}
        active={props.active()}
        forceTruncate={props.forceTruncate}
        dragging={sortable.isDragSource()}
      />
    </div>
  )
}

function SessionTabEntry(props: {
  tab: SessionTab
  id: string
  index: () => number
  active: () => boolean
  forceTruncate: boolean
  serverCtx: () => ServerCtx | undefined
  onVisibleChange: (visible: boolean) => void
  onNavigate: (element: HTMLDivElement) => void
  onClose: () => void
  group?: string
}) {
  const tabs = useTabs()
  const language = useLanguage()
  const sdk = createMemo(() => props.serverCtx()?.sdk ?? null)
  const cachedSession = createMemo(() => props.serverCtx()?.sync.session.peek(props.tab.sessionId))
  const persisted = createMemo(() => tabs.info[props.id])
  const [loadedSession] = createResource(
    () => {
      const ctx = props.serverCtx()
      return ctx ? { id: props.tab.sessionId, ctx } : null
    },
    ({ id, ctx }) => ctx.sync.session.resolve(id).catch(() => undefined),
  )
  const session = createMemo(() => cachedSession() ?? loadedSession())
  const missingSession = createMemo(() => !!props.serverCtx() && !loadedSession.loading && !session())
  const visible = createMemo(() => !!session() || missingSession() || !!persisted()?.title)
  let prefetched = false

  const rename = async (title: string) => {
    const value = session()
    const ctx = props.serverCtx()
    if (!value || !ctx) return

    ctx.sync.session.remember({ ...value, title })
    try {
      await ctx.sdk.api.session.rename({ sessionID: value.id, title })
    } catch (err) {
      const current = session()
      const currentCtx = props.serverCtx()
      if (current && currentCtx) currentCtx.sync.session.remember({ ...current, title: value.title })
      showToast({
        title: language.t("common.requestFailed"),
        description: err instanceof Error ? err.message : undefined,
      })
    }
  }

  createEffect(() => props.onVisibleChange(visible()))

  createEffect(() => {
    const ctx = props.serverCtx()
    const value = session()
    if (!ctx || !value || prefetched) return
    prefetched = true
    createRoot((dispose) => {
      try {
        void ctx.sync
          .ensureDirSyncContext(value.directory)
          .session.sync(value.id)
          .catch(() => {})
          .finally(dispose)
      } catch {
        dispose()
      }
    })
  })

  createEffect(() => {
    const value = session()
    if (!value) return
    tabs.rememberSessionInfo(props.tab, value)
    const current = sdk()
    if (!current) return
    createTabPromptState(tabs, props.tab, current.scope, {
      dir: base64Encode(value.directory),
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
        forceTruncate={props.forceTruncate}
        session={session}
        fallbackTitle={persisted()?.title ?? (missingSession() ? language.t("session.tab.unknown") : undefined)}
        onRename={rename}
        onNavigate={props.onNavigate}
        onClose={props.onClose}
        group={props.group}
      />
    </Show>
  )
}

function DraftTabSlot(props: {
  tab: Extract<Tab, { type: "draft" }>
  id: string
  index: () => number
  active: () => boolean
  title: string
  onNavigate: (element: HTMLDivElement) => void
  onClose: () => void
  group?: string
}) {
  const sortable = useSortable({
    get id() {
      return props.id
    },
    get index() {
      return props.index()
    },
    get group() {
      return props.group
    },
  })
  let ref!: HTMLDivElement

  return (
    <div
      ref={sortable.ref}
      data-titlebar-tab-slot
      data-tab-key={props.id}
      data-active={props.active()}
      class="relative flex w-56 min-w-7 max-w-56 flex-shrink"
    >
      <DraftTabItem
        ref={(el) => {
          ref = el
        }}
        href={tabHref(props.tab)}
        title={props.title}
        onNavigate={() => props.onNavigate(ref)}
        onClose={props.onClose}
        active={props.active()}
        dragging={sortable.isDragSource()}
      />
    </div>
  )
}

export function TitlebarTabStrip(props: {
  tabs: Tab[]
  currentTab: () => Tab | undefined
  forceTruncate: boolean
  orientation?: TabOrientation
  onNavigate: (tab: Tab, el?: HTMLDivElement) => void
  onClose: (tab: Tab) => void
  onReorder: (keys: string[]) => void
  onOverflowChange: (overflowing: boolean) => void
}) {
  const global = useGlobal()
  const language = useLanguage()
  let scrollRef!: HTMLDivElement
  let listRef!: HTMLDivElement
  let resizeFrame: number | undefined
  const [visibility, setVisibility] = createStore<Record<string, boolean>>({})
  const orientation = () => props.orientation ?? "horizontal"
  const orderedTabs = createMemo(() =>
    orientation() === "vertical" ? groupTabsByServer(props.tabs).flatMap((group) => group.tabs) : props.tabs,
  )
  const visibleTabs = createMemo(() =>
    orderedTabs().filter((tab) => tab.type === "draft" || visibility[tabKey(tab)]),
  )
  const visibleTabIds = () => visibleTabs().map(tabKey)
  const servers = createMemo(() => groupTabsByServer(orderedTabs()).map((group) => group.server))
  const machineName = (key: ServerConnection.Key) => {
    const conn = global.servers.list().find((item) => ServerConnection.key(item) === key)
    return conn ? serverName(conn) : key
  }

  function refreshOverflow() {
    if (!scrollRef) return
    props.onOverflowChange(
      orientation() === "vertical"
        ? scrollRef.scrollHeight > scrollRef.clientHeight
        : scrollRef.scrollWidth > scrollRef.clientWidth,
    )
  }

  createResizeObserver(
    () => [scrollRef, listRef],
    () => {
      if (resizeFrame !== undefined) return
      resizeFrame = requestAnimationFrame(() => {
        resizeFrame = undefined
        refreshOverflow()
      })
    },
  )

  onMount(() => {
    refreshOverflow()
  })

  onCleanup(() => {
    if (resizeFrame !== undefined) cancelAnimationFrame(resizeFrame)
  })

  createEffect(() => {
    props.tabs.length
    visibleTabIds()
    orientation()
    refreshOverflow()
  })

  const renderTab = (tab: Tab) => {
    const id = tabKey(tab)
    let ref!: HTMLDivElement
    const visibleIndex = () => visibleTabs().findIndex((item) => tabKey(item) === id)
    const sortableIndex = () =>
      orientation() === "vertical"
        ? visibleTabs()
            .filter((item) => item.server === tab.server)
            .findIndex((item) => tabKey(item) === id)
        : visibleIndex()
    const serverCtx = createMemo(() => {
      if (tab.type !== "session") return
      const conn = global.servers.list().find((item) => ServerConnection.key(item) === tab.server)
      if (conn) return global.ensureServerCtx(conn)
    })

    if (tab.type === "session") {
      return (
        <SessionTabEntry
          tab={tab}
          id={id}
          index={sortableIndex}
          active={() => props.currentTab() === tab}
          forceTruncate={props.forceTruncate}
          serverCtx={serverCtx}
          onVisibleChange={(visible) => setVisibility(id, visible)}
          onNavigate={(element) => {
            ref = element
            props.onNavigate(tab, element)
          }}
          onClose={() => props.onClose(tab)}
          group={orientation() === "vertical" ? tab.server : undefined}
        />
      )
    }

    return (
      <DraftTabSlot
        tab={tab}
        id={id}
        index={sortableIndex}
        active={() => props.currentTab() === tab}
        title={language.t("command.session.new")}
        onNavigate={(element) => {
          ref = element
          props.onNavigate(tab, element)
        }}
        onClose={() => props.onClose(tab)}
        group={orientation() === "vertical" ? tab.server : undefined}
      />
    )
  }

  return (
    <div
      data-slot="titlebar-tabs"
      data-orientation={orientation()}
      class="relative min-w-0"
      classList={{ "min-h-0 flex-1": orientation() === "vertical" }}
    >
      <div
        data-slot="titlebar-tabs-scroll"
        class="flex min-w-0 no-scrollbar [app-region:no-drag]"
        classList={{
          "flex-row items-center gap-1.5 overflow-x-auto": orientation() === "horizontal",
          "h-full flex-col overflow-y-auto overflow-x-hidden": orientation() === "vertical",
        }}
        ref={scrollRef}
      >
        <DragDropProvider
          sensors={[
            PointerSensor.configure({
              activationConstraints: [new PointerActivationConstraints.Distance({ value: 4 })],
              preventActivation: (event) =>
                !canStartTabDrag(event.pointerType) ||
                isTabCloseTarget(event.target) ||
                (event.target instanceof Element && !!event.target.closest('[contenteditable="true"]')),
            }),
          ]}
          modifiers={[
            orientation() === "vertical" ? RestrictToVerticalAxis : RestrictToHorizontalAxis,
            RestrictToElement.configure({ element: () => listRef }),
          ]}
          plugins={(defaults) => [
            ...defaults.filter((plugin) => plugin !== Accessibility),
            AutoScroller.configure({
              acceleration: 8,
              threshold: orientation() === "vertical" ? { x: 0, y: 0.05 } : { x: 0.05, y: 0 },
            }),
            Feedback.configure({ dropAnimation: null }),
          ]}
          onDragStart={(event) => {
            const source = event.operation.source
            if (!source) return
            const tab = props.tabs.find((item) => tabKey(item) === source.id.toString())
            if (!tab) return
            const tabEl = source.element?.querySelector<HTMLDivElement>("[data-titlebar-tab]")
            props.onNavigate(tab, tabEl ?? undefined)
          }}
          onDragOver={(event) => {
            if (orientation() !== "vertical") return
            const source = props.tabs.find((tab) => tabKey(tab) === event.operation.source?.id.toString())
            const target = props.tabs.find((tab) => tabKey(tab) === event.operation.target?.id.toString())
            if (source && target && source.server !== target.server) event.preventDefault()
          }}
          onDragEnd={(event) => {
            const source = event.operation.source
            if (event.canceled || !isSortable(source)) return
            const sourceTab = props.tabs.find((tab) => tabKey(tab) === source.id.toString())
            if (!sourceTab) return
            const targetTab = props.tabs.find((tab) => tabKey(tab) === event.operation.target?.id.toString())
            if (orientation() === "vertical" && targetTab && sourceTab.server !== targetTab.server) return
            const current = visibleTabs()
              .filter((tab) => orientation() !== "vertical" || tab.server === sourceTab.server)
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
            class="flex w-full min-w-0"
            classList={{
              "flex-row items-center": orientation() === "horizontal",
              "flex-col gap-3 pb-2": orientation() === "vertical",
            }}
            ref={listRef}
          >
            <Show when={orientation() === "vertical"} fallback={<For each={orderedTabs()}>{renderTab}</For>}>
              <For each={servers()}>
                {(server) => (
                  <section data-titlebar-tab-group class="flex min-w-0 flex-col gap-1">
                    <h2
                      data-titlebar-tab-group-label
                      class="truncate px-1.5 text-[11px] font-medium text-v2-text-text-faint"
                      title={machineName(server)}
                    >
                      <bdi dir="auto">{machineName(server)}</bdi>
                    </h2>
                    <div class="flex min-w-0 flex-col gap-1">
                      <For each={orderedTabs().filter((tab) => tab.server === server)}>{renderTab}</For>
                    </div>
                  </section>
                )}
              </For>
            </Show>
          </div>
        </DragDropProvider>
      </div>
      <Show when={orientation() === "horizontal"}>
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
