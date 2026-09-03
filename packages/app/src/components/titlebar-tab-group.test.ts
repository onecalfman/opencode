import { describe, expect, test } from "bun:test"
import { groupTabsByServer } from "./titlebar-tab-group"

describe("groupTabsByServer", () => {
  test("groups tabs by machine in first-seen order", () => {
    const tabs = [
      { id: "a", server: "local" },
      { id: "b", server: "remote" },
      { id: "c", server: "local" },
      { id: "d", server: "another" },
      { id: "e", server: "remote" },
    ]

    expect(groupTabsByServer(tabs)).toEqual([
      { server: "local", tabs: [tabs[0], tabs[2]] },
      { server: "remote", tabs: [tabs[1], tabs[4]] },
      { server: "another", tabs: [tabs[3]] },
    ])
  })

  test("returns no machine groups when there are no tabs", () => {
    expect(groupTabsByServer([])).toEqual([])
  })
})
