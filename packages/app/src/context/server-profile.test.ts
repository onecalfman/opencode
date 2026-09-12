import { describe, expect, test } from "bun:test"
import type { ProfileDocument } from "@opencode-ai/sdk/v2/types"
import {
  applyProfileProjects,
  applyProfileServers,
  mergeOpenSessionIDs,
  mergePortableProfiles,
  normalizePortableProfile,
  portableServerUrl,
  projectPortableProfile,
  replayProfileOperations,
} from "./server-profile"

const profile = (servers: ProfileDocument["servers"]): ProfileDocument => ({ version: 1, servers })

describe("portable profile", () => {
  test("includes only stable regular HTTP URLs without userinfo", () => {
    const connection = (url: string, type = "http") => ({ type, http: { url } })
    expect(portableServerUrl(connection("https://example.com"))).toBe("https://example.com/")
    expect(portableServerUrl(connection("http://example.com/api/"))).toBe("http://example.com/api")
    expect(portableServerUrl(connection(" HTTPS://EXAMPLE.COM:443/api/// "))).toBe("https://example.com/api")
    expect(portableServerUrl(connection("ftp://example.com"))).toBeUndefined()
    expect(portableServerUrl(connection("https://user:secret@example.com"))).toBeUndefined()
    expect(portableServerUrl(connection("https://@example.com"))).toBeUndefined()
    expect(portableServerUrl(connection("https://example.com?auth_token=secret"))).toBeUndefined()
    expect(portableServerUrl(connection("https://example.com#secret"))).toBeUndefined()
    expect(portableServerUrl(connection("http://localhost:4096"))).toBeUndefined()
    expect(portableServerUrl(connection("http://localhost.:4096"))).toBeUndefined()
    expect(portableServerUrl(connection("http://dev.localhost:4096"))).toBeUndefined()
    expect(portableServerUrl(connection("http://127.42.0.1"))).toBeUndefined()
    expect(portableServerUrl(connection("http://0.0.0.0:4096"))).toBeUndefined()
    expect(portableServerUrl(connection("http://[::1]:4096"))).toBeUndefined()
    expect(portableServerUrl(connection("http://[::]:4096"))).toBeUndefined()
    expect(portableServerUrl(connection("http://[::ffff:127.0.0.1]:4096"))).toBeUndefined()
    expect(portableServerUrl(connection("https://example.com:0"))).toBeUndefined()
    expect(portableServerUrl(connection("https://example.com", "ssh"))).toBeUndefined()
  })

  test("projects only portable fields", () => {
    const result = projectPortableProfile({
      servers: [
        {
          type: "http",
          displayName: "Work",
          label: "device label",
          authToken: true,
          http: { url: "https://example.com", username: "me", password: "secret" },
        },
      ],
      projects: () => [{ worktree: "/repo", expanded: false, draft: "local" }],
    })
    expect(result).toEqual(profile([{ url: "https://example.com/", name: "Work", projects: [{ worktree: "/repo" }] }]))
  })
})

test("normalizing a remote profile canonicalizes and deduplicates portable servers", () => {
  expect(
    normalizePortableProfile(
      profile([
        { url: "HTTPS://EXAMPLE.COM:443", projects: [{ worktree: "/one" }, { worktree: "/one" }] },
        {
          url: "https://example.com/",
          name: "Shared",
          projects: [{ worktree: "/one" }, { worktree: "/two" }, { worktree: "/two" }],
        },
        { url: "http://localhost:4096", projects: [{ worktree: "/local" }] },
      ]),
    ),
  ).toEqual(
    profile([
      {
        url: "https://example.com/",
        name: "Shared",
        projects: [{ worktree: "/one" }, { worktree: "/two" }],
      },
    ]),
  )
})

test("applying remote metadata preserves matching credentials and excluded connections", () => {
  const result = applyProfileServers(
    [
      {
        type: "http",
        displayName: "Old",
        label: "device",
        authToken: true,
        http: { url: "https://one.example", username: "me", password: "secret" },
      },
      { type: "http", http: { url: "http://localhost:4096", password: "local" } },
    ],
    profile([
      { url: "https://one.example", name: "Shared", projects: [] },
      { url: "https://two.example", projects: [] },
    ]),
  )
  expect(result).toEqual([
    { type: "http", http: { url: "http://localhost:4096", password: "local" } },
    {
      type: "http",
      displayName: "Shared",
      label: "device",
      authToken: true,
      http: { url: "https://one.example", username: "me", password: "secret" },
    },
    { type: "http", displayName: undefined, http: { url: "https://two.example/" } },
  ])
})

test("applying canonical metadata preserves the local connection spelling and credentials", () => {
  expect(
    applyProfileServers(
      [{ type: "http", http: { url: "HTTPS://EXAMPLE.COM:443/api", password: "secret" } }],
      profile([{ url: "https://example.com/api", name: "Shared", projects: [] }]),
    ),
  ).toEqual([
    {
      type: "http",
      displayName: "Shared",
      http: { url: "HTTPS://EXAMPLE.COM:443/api", password: "secret" },
    },
  ])
})

test("one-time import merge keeps remote values and adds missing local metadata once", () => {
  const remote = profile([{ url: "https://one.example", name: "Remote", projects: [{ worktree: "/remote" }] }])
  const local = profile([
    {
      url: "https://one.example",
      name: "Local",
      projects: [{ worktree: "/remote" }, { worktree: "/local" }],
    },
    { url: "https://two.example", projects: [{ worktree: "/two" }] },
  ])
  const merged = mergePortableProfiles(remote, local)
  expect(merged).toEqual(
    profile([
      {
        url: "https://one.example",
        name: "Remote",
        projects: [{ worktree: "/remote" }, { worktree: "/local" }],
      },
      { url: "https://two.example", projects: [{ worktree: "/two" }] },
    ]),
  )
  expect(mergePortableProfiles(merged, local)).toEqual(merged)
})

test("operation replay preserves order across open, move, remove, and server removal", () => {
  const result = replayProfileOperations(profile([]), [
    { type: "server.set", url: "https://one.example", name: "One" },
    { type: "project.open", url: "https://one.example", worktree: "/a" },
    { type: "project.open", url: "https://one.example", worktree: "/b" },
    { type: "project.open", url: "https://one.example", worktree: "/c" },
    { type: "project.move", url: "https://one.example", worktree: "/a", toIndex: 0 },
    { type: "project.remove", url: "https://one.example", worktree: "/b" },
    { type: "server.set", url: "https://two.example" },
    { type: "server.remove", url: "https://two.example" },
  ])
  expect(result).toEqual(
    profile([
      {
        url: "https://one.example",
        name: "One",
        projects: [{ worktree: "/a" }, { worktree: "/c" }],
      },
    ]),
  )
})

test("session merge preserves established remote state and update applies local changes", () => {
  const initial = profile([
    {
      url: "https://one.example",
      projects: [],
      openSessionIDs: ["ses_remote", "ses_remote"],
    },
    { url: "https://two.example", projects: [] },
  ])

  expect(
    replayProfileOperations(initial, [
      { type: "session.merge", url: "https://one.example", sessionIDs: ["ses_local"] },
      { type: "session.merge", url: "https://two.example", sessionIDs: ["ses_two", "ses_two"] },
    ]),
  ).toEqual(
    profile([
      { url: "https://one.example", projects: [], openSessionIDs: ["ses_remote", "ses_local"] },
      { url: "https://two.example", projects: [], openSessionIDs: ["ses_two"] },
    ]),
  )

  expect(
    replayProfileOperations(initial, [
      {
        type: "session.update",
        url: "https://one.example",
        previousSessionIDs: ["ses_remote"],
        sessionIDs: ["ses_new", "invalid", "ses_new"],
      },
    ]),
  ).toEqual(
    profile([
      { url: "https://one.example", projects: [], openSessionIDs: ["ses_new"] },
      { url: "https://two.example", projects: [] },
    ]),
  )
})

test("normalizing sessions preserves missing state and deduplicates explicit state", () => {
  expect(
    normalizePortableProfile(
      profile([
        { url: "https://one.example", projects: [] },
        {
          url: "https://two.example",
          projects: [],
          openSessionIDs: ["ses_one", "invalid", "ses_one", "ses_two"],
        },
      ]),
    ),
  ).toEqual(
    profile([
      { url: "https://one.example/", projects: [] },
      { url: "https://two.example/", projects: [], openSessionIDs: ["ses_one", "ses_two"] },
    ]),
  )
})

test("normalizing duplicate servers merges their open sessions", () => {
  expect(
    normalizePortableProfile(
      profile([
        { url: "https://one.example", projects: [], openSessionIDs: ["ses_one"] },
        { url: "https://one.example/", projects: [], openSessionIDs: ["ses_two", "ses_one"] },
      ]),
    ),
  ).toEqual(profile([{ url: "https://one.example/", projects: [], openSessionIDs: ["ses_one", "ses_two"] }]))
})

test("replaying a session merge after a conflict keeps sessions from both clients", () => {
  expect(
    replayProfileOperations(profile([{ url: "https://one.example", projects: [], openSessionIDs: ["ses_first"] }]), [
      { type: "session.merge", url: "https://one.example", sessionIDs: ["ses_second"] },
    ]),
  ).toEqual(
    profile([{ url: "https://one.example", projects: [], openSessionIDs: ["ses_first", "ses_second"] }]),
  )
})

test("replaying session updates preserves concurrent opens and closes", () => {
  expect(
    replayProfileOperations(profile([{ url: "https://one.example", projects: [], openSessionIDs: ["ses_a", "ses_b"] }]), [
      {
        type: "session.update",
        url: "https://one.example",
        previousSessionIDs: ["ses_a"],
        sessionIDs: ["ses_a", "ses_c"],
      },
    ]),
  ).toEqual(
    profile([{ url: "https://one.example", projects: [], openSessionIDs: ["ses_a", "ses_c", "ses_b"] }]),
  )

  expect(
    replayProfileOperations(profile([{ url: "https://one.example", projects: [], openSessionIDs: ["ses_a"] }]), [
      {
        type: "session.update",
        url: "https://one.example",
        previousSessionIDs: ["ses_a", "ses_b"],
        sessionIDs: ["ses_b"],
      },
    ]),
  ).toEqual(profile([{ url: "https://one.example", projects: [], openSessionIDs: [] }]))
})

test("one-time session import keeps remote order and appends local tabs", () => {
  expect(mergeOpenSessionIDs(["ses_remote", "ses_shared"], ["ses_local", "ses_shared", "invalid"])).toEqual([
    "ses_remote",
    "ses_shared",
    "ses_local",
  ])
})

test("opening a project recreates a missing server profile entry", () => {
  expect(
    replayProfileOperations(profile([]), [
      { type: "project.open", url: "https://one.example", worktree: "/workspace" },
    ]),
  ).toEqual(profile([{ url: "https://one.example", projects: [{ worktree: "/workspace" }] }]))
})

test("applying opened projects preserves expansion and defaults new projects expanded", () => {
  const result = applyProfileProjects({
    profile: profile([{ url: "https://one.example/", projects: [{ worktree: "/kept" }, { worktree: "/new" }] }]),
    projects: {
      one: [
        { worktree: "/kept", expanded: false },
        { worktree: "/removed", expanded: false },
      ],
      local: [{ worktree: "/local", expanded: false }],
    },
    portableUrls: ["https://one.example/"],
    scope: () => "one",
  })
  expect(result).toEqual({
    one: [
      { worktree: "/kept", expanded: false },
      { worktree: "/new", expanded: true },
    ],
    local: [{ worktree: "/local", expanded: false }],
  })
})
