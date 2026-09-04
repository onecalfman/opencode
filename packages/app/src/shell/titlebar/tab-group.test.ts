import { expect, test } from "bun:test"
import { groupTabsByServerAndProject } from "./tab-group"

test("groups tabs by server and project in first-seen order without mixing drafts", () => {
  const tabs = [
    { id: "one", server: "remote", project: "/alpha" },
    { id: "two", server: "local", project: "/alpha" },
    { id: "three", server: "remote", project: "/beta" },
    { id: "draft", server: "remote", project: "/alpha" },
  ]
  expect(groupTabsByServerAndProject(tabs, (tab) => tab.project)).toEqual([
    { server: "remote", projects: [
      { project: "/alpha", tabs: [tabs[0], tabs[3]] },
      { project: "/beta", tabs: [tabs[2]] },
    ] },
    { server: "local", projects: [{ project: "/alpha", tabs: [tabs[1]] }] },
  ])
})
