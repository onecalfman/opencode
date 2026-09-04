import { describe, expect, test } from "bun:test"
import { groupTabsByServer, groupTabsByServerAndProject } from "./titlebar-tab-group"

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

describe("groupTabsByServerAndProject", () => {
  test("groups projects within each machine in first-seen order", () => {
    const tabs = [
      { id: "a", server: "local", project: "app" },
      { id: "b", server: "remote", project: "core" },
      { id: "c", server: "local", project: "sdk" },
      { id: "d", server: "local", project: "app" },
      { id: "e", server: "remote", project: "core" },
    ]

    expect(groupTabsByServerAndProject(tabs, (tab) => tab.project)).toEqual([
      {
        server: "local",
        projects: [
          { project: "app", tabs: [tabs[0], tabs[3]] },
          { project: "sdk", tabs: [tabs[2]] },
        ],
      },
      { server: "remote", projects: [{ project: "core", tabs: [tabs[1], tabs[4]] }] },
    ])
  })
})
