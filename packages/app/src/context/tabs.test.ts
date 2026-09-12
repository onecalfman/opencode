import { describe, expect, test } from "bun:test"
import { createRoot, getOwner, onCleanup } from "solid-js"
import { createTabMemory } from "./tab-memory"
import { nextTabAfterClose, pushClosedTab, removeClosedTabs, takeClosedTab, type ClosedTab } from "./closed-tabs"
import type { SessionTab, Tab } from "./tabs"
import { profileSessionIDs, profileSessionTarget, reconcileProfileSessionTabs } from "./tab-profile"
import { migrateTabs } from "./tab-migration"
import type { ServerConnection } from "./server"

const server = "local\nhttp://localhost:4096" as ServerConnection.Key

function sessionTab(sessionId: string): SessionTab {
  return { type: "session", server, sessionId }
}

describe("tab migration", () => {
  test("drops null and malformed persisted tabs", () => {
    expect(
      migrateTabs([null, sessionTab("a"), { type: "session", server }, { type: "unknown", server }, "invalid"], server),
    ).toEqual([sessionTab("a")])
  })

  test("adds the fallback server to valid legacy tabs", () => {
    expect(migrateTabs([{ type: "session", sessionId: "a", dirBase64: "legacy" }], server)).toEqual([sessionTab("a")])
  })

  test("replaces invalid top-level persisted data", () => {
    expect(migrateTabs(null, server)).toEqual([])
    expect(migrateTabs({}, server)).toEqual([])
  })
})

describe("profile session tabs", () => {
  test("reconciles one server while preserving drafts and other servers", () => {
    const other = "https://other.example" as ServerConnection.Key
    const draft = { type: "draft" as const, draftID: "draft", server, directory: "/repo" }
    const tabs: Tab[] = [
      sessionTab("ses_one"),
      draft,
      sessionTab("ses_two"),
      { ...sessionTab("ses_other"), server: other },
    ]

    expect(
      reconcileProfileSessionTabs(tabs, [
        { key: server, url: "https://one.example/", sessionIDs: ["ses_two", "ses_three"] },
      ]),
    ).toEqual([
      sessionTab("ses_two"),
      draft,
      sessionTab("ses_three"),
      { ...sessionTab("ses_other"), server: other },
    ])
  })

  test("deduplicates session IDs and appends sessions for a newly synchronized server", () => {
    expect(
      reconcileProfileSessionTabs([], [
        { key: server, url: "https://one.example/", sessionIDs: ["ses_one", "invalid", "ses_one", "ses_two"] },
      ]),
    ).toEqual([sessionTab("ses_one"), sessionTab("ses_two")])
  })

  test("uses profile server order across multiple servers", () => {
    const other = "https://other.example" as ServerConnection.Key
    expect(
      reconcileProfileSessionTabs([sessionTab("ses_one"), { ...sessionTab("ses_other"), server: other }], [
        { key: other, url: "https://other.example/", sessionIDs: ["ses_other"] },
        { key: server, url: "https://one.example/", sessionIDs: ["ses_one"] },
      ]),
    ).toEqual([{ ...sessionTab("ses_other"), server: other }, sessionTab("ses_one")])
  })

  test("reads and canonicalizes tabs stored under an equivalent server URL", () => {
    const canonical = "HTTPS://ONE.EXAMPLE:443" as ServerConnection.Key
    const stored = "https://one.example/" as ServerConnection.Key
    const tabs = [{ ...sessionTab("ses_one"), server: stored }]
    const target = { key: canonical, url: "https://one.example/" }

    expect(profileSessionIDs(tabs, target)).toEqual(["ses_one"])
    expect(profileSessionTarget(stored, [{ ...target, sessionIDs: ["ses_one"] }])).toEqual({
      ...target,
      sessionIDs: ["ses_one"],
    })
    expect(reconcileProfileSessionTabs(tabs, [{ ...target, sessionIDs: ["ses_one"] }])).toEqual([
      { ...sessionTab("ses_one"), server: canonical },
    ])
  })
})

describe("tab memory", () => {
  test("keeps state until its tab is removed", () => {
    createRoot((dispose) => {
      const memory = createTabMemory(getOwner())
      let disposed = 0
      const first = memory.ensure("tab", "prompt", () => {
        onCleanup(() => disposed++)
        return { value: "prompt" }
      })

      expect(memory.ensure("tab", "prompt", () => ({ value: "other" }))).toBe(first)
      expect(memory.get<typeof first>("tab", "prompt")).toBe(first)
      expect(memory.get("missing", "prompt")).toBeUndefined()
      expect(memory.ensure("other", "prompt", () => ({ value: "other" }))).not.toBe(first)

      memory.remove("tab")
      expect(disposed).toBe(1)
      expect(memory.ensure("tab", "prompt", () => ({ value: "new" }))).not.toBe(first)

      const moved = memory.ensure("old", "prompt", () => ({ value: "moved" }))
      memory.move("old", "new")
      expect(memory.get("old", "prompt")).toBeUndefined()
      expect(memory.get<typeof moved>("new", "prompt")).toBe(moved)
      dispose()
    })
  })
})

describe("closed tab stack", () => {
  test("records session tabs with their index", () => {
    const stack = pushClosedTab([], sessionTab("a"), 2)

    expect(stack).toEqual([{ tab: sessionTab("a"), index: 2 }])
  })

  test("ignores draft tabs", () => {
    const draft: Tab = { type: "draft", draftID: "d1", server, directory: "/tmp" }

    expect(pushClosedTab([], draft, 0)).toEqual([])
  })

  test("caps the stack size", () => {
    const stack = Array.from({ length: 30 }, (_, i) => i).reduce<ClosedTab[]>(
      (acc, i) => pushClosedTab(acc, sessionTab(`s${i}`), i),
      [],
    )

    expect(stack).toHaveLength(25)
    expect(stack[0]?.tab.sessionId).toBe("s5")
    expect(stack.at(-1)?.tab.sessionId).toBe("s29")
  })

  test("pops the most recently closed tab", () => {
    const stack = [
      { tab: sessionTab("a"), index: 0 },
      { tab: sessionTab("b"), index: 1 },
    ]
    const result = takeClosedTab(stack, [])

    expect(result.entry?.tab.sessionId).toBe("b")
    expect(result.stack).toEqual([{ tab: sessionTab("a"), index: 0 }])
  })

  test("skips entries whose tab is already open", () => {
    const stack = [
      { tab: sessionTab("a"), index: 0 },
      { tab: sessionTab("b"), index: 1 },
    ]
    const result = takeClosedTab(stack, [sessionTab("b")])

    expect(result.entry?.tab.sessionId).toBe("a")
    expect(result.stack).toEqual([])
  })

  test("returns no entry when everything is open or empty", () => {
    expect(takeClosedTab([], []).entry).toBeUndefined()

    const result = takeClosedTab([{ tab: sessionTab("a"), index: 0 }], [sessionTab("a")])
    expect(result.entry).toBeUndefined()
    expect(result.stack).toEqual([])
  })

  test("purges removed sessions", () => {
    const stack = [
      { tab: sessionTab("a"), index: 0 },
      { tab: sessionTab("b"), index: 1 },
    ]

    expect(removeClosedTabs(stack, server, ["a"])).toEqual([{ tab: sessionTab("b"), index: 1 }])
  })

  test("does not navigate when a background tab closes", () => {
    const tabs = [sessionTab("a"), sessionTab("b"), sessionTab("c")]

    expect(nextTabAfterClose(tabs, 1, false)).toBeUndefined()
    expect(nextTabAfterClose(tabs, 1, true)).toEqual(sessionTab("c"))
    expect(nextTabAfterClose([sessionTab("a")], 0, true)).toBeNull()
  })
})
