import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { Profile } from "../src/profile"

describe("Profile", () => {
  test("defines a versioned credential-free browser contract", () => {
    const profile = Schema.decodeUnknownSync(Profile.Document)({
      version: 1,
      servers: [
        {
          url: "https://opencode.example.com",
          username: "ignored",
          password: "ignored",
          projects: [{ worktree: "/workspace" }],
        },
      ],
    })

    expect(Schema.encodeSync(Profile.Document)(profile)).toEqual({
      version: 1,
      servers: [{ url: "https://opencode.example.com/", projects: [{ worktree: "/workspace" }] }],
    })
  })

  test("rejects malformed and credential-bearing server URLs", () => {
    const decode = Schema.decodeUnknownSync(Profile.ServerUrl)
    expect(() => decode("ssh://example.com")).toThrow()
    expect(() => decode("https://user:secret@example.com")).toThrow()
    expect(() => decode("https://example.com?auth_token=secret")).toThrow()
    expect(() => decode("https://example.com#secret")).toThrow()
    expect(() => decode("https://.")).toThrow()
    expect(() => decode("https://example.com:99999")).toThrow()
    expect(() => decode("http://[:::]")).toThrow()
  })

  test("omits an undefined server name while encoding", () => {
    expect(
      Schema.encodeSync(Profile.Server)({
        url: Profile.ServerUrl.make(new URL("http://localhost:4096")),
        name: undefined,
        projects: [],
      }),
    ).toEqual({ url: "http://localhost:4096/", projects: [] })
  })

  test("preserves missing and explicit open session state", () => {
    const decode = Schema.decodeUnknownSync(Profile.Server)

    expect(Schema.encodeSync(Profile.Server)(decode({ url: "https://example.com", projects: [] }))).toEqual({
      url: "https://example.com/",
      projects: [],
    })
    expect(
      Schema.encodeSync(Profile.Server)(
        decode({
          url: "https://example.com",
          projects: [],
          openSessionIDs: ["ses_one", "ses_two"],
          openSessionInputAt: 123,
        }),
      ),
    ).toEqual({
      url: "https://example.com/",
      projects: [],
      openSessionIDs: ["ses_one", "ses_two"],
      openSessionInputAt: 123,
    })
    expect(() => decode({ url: "https://example.com", projects: [], openSessionIDs: ["invalid"] })).toThrow()
    expect(() => decode({ url: "https://example.com", projects: [], openSessionInputAt: -1 })).toThrow()
  })

  test("rejects a replacement revision that cannot be incremented safely", () => {
    expect(() =>
      Schema.decodeUnknownSync(Profile.ReplaceInput)({
        revision: Number.MAX_SAFE_INTEGER,
        profile: { version: 1, servers: [] },
      }),
    ).toThrow()
  })
})
