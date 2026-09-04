import { describe, expect, test } from "bun:test"
import type { DraftTab } from "@/context/tabs"
import { projectGroupKeyForTab } from "./titlebar-tab-project"

describe("projectGroupKeyForTab", () => {
  test("keeps drafts for selected directories separate when they share a worktree", () => {
    const draft = (draftID: string, directory: string) => ({
      type: "draft" as const,
      draftID,
      server: "local" as DraftTab["server"],
      directory,
      worktree: "/home/user",
    })

    expect(projectGroupKeyForTab(draft("a", "/home/user/dev"), undefined, undefined)).toBe("/home/user/dev")
    expect(projectGroupKeyForTab(draft("b", "/home/user/org"), undefined, undefined)).toBe("/home/user/org")
  })
})
