import { describe, expect } from "bun:test"
import { Effect, Exit, Fiber, Latch, Stream } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { Profile } from "@opencode-ai/core/profile"
import { ProfileTable } from "@opencode-ai/core/profile/sql"
import { Database } from "@opencode-ai/core/database/database"
import { SessionID } from "@opencode-ai/schema/session-id"
import { testEffect } from "./lib/effect"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Profile.node, EventV2.node, Database.node])))

describe("Profile", () => {
  it.effect("initializes, replaces with CAS, and publishes the updated snapshot", () =>
    Effect.gen(function* () {
      const profile = yield* Profile.Service
      const events = yield* EventV2.Service

      expect(yield* profile.get()).toEqual({ revision: 0, profile: { version: 1, servers: [] } })

      const subscription = yield* events
        .subscribe(Profile.Event.Updated)
        .pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped)
      yield* Effect.yieldNow

      const updated = yield* profile.replace({
        revision: 0,
        profile: {
          version: 1,
          servers: [
            {
              url: Profile.ServerUrl.make(new URL("https://opencode.example.com")),
              name: "Remote",
              projects: [{ worktree: "/workspace" }],
              openSessionIDs: [SessionID.make("ses_one"), SessionID.make("ses_two")],
            },
          ],
        },
      })

      expect(updated.revision).toBe(1)
      expect(yield* profile.get()).toEqual(updated)
      expect(Array.from(yield* Fiber.join(subscription))[0]).toMatchObject({
        type: "profile.updated",
        data: updated,
      })

      const conflict = yield* profile.replace({ revision: 0, profile: { version: 1, servers: [] } }).pipe(Effect.flip)
      expect(conflict).toEqual(
        new Profile.RevisionConflict({
          message: "UI profile revision conflict",
          expectedRevision: 0,
          actualRevision: 1,
        }),
      )
    }),
  )

  it.effect("returns a committed update without waiting for live event listeners", () =>
    Effect.gen(function* () {
      const profile = yield* Profile.Service
      const events = yield* EventV2.Service
      const blocked = yield* Latch.make()
      yield* events.listen(() => Latch.await(blocked))

      const updated = yield* profile.replace({ revision: 0, profile: { version: 1, servers: [] } })

      expect(updated.revision).toBe(1)
      expect(yield* profile.get()).toEqual(updated)
    }),
  )

  it.effect("preserves established open sessions when an older client omits them", () =>
    Effect.gen(function* () {
      const profile = yield* Profile.Service
      const url = Profile.ServerUrl.make(new URL("https://opencode.example.com"))

      yield* profile.replace({
        revision: 0,
        profile: {
          version: 1,
          servers: [{ url, projects: [], openSessionIDs: [SessionID.make("ses_one")] }],
        },
      })
      const preserved = yield* profile.replace({
        revision: 1,
        profile: { version: 1, servers: [{ url, projects: [{ worktree: "/workspace" }] }] },
      })
      const cleared = yield* profile.replace({
        revision: 2,
        profile: { version: 1, servers: [{ url, projects: [], openSessionIDs: [] }] },
      })

      expect(preserved.profile.servers[0]?.openSessionIDs).toEqual([SessionID.make("ses_one")])
      expect(cleared.profile.servers[0]?.openSessionIDs).toEqual([])
    }),
  )

  it.effect("keeps the newest input owner's open sessions authoritative", () =>
    Effect.gen(function* () {
      const profile = yield* Profile.Service
      const url = Profile.ServerUrl.make(new URL("https://opencode.example.com"))

      yield* profile.replace({
        revision: 0,
        profile: {
          version: 1,
          servers: [
            {
              url,
              projects: [],
              openSessionIDs: [SessionID.make("ses_newest")],
              openSessionInputAt: 200,
            },
          ],
        },
      })
      const stale = yield* profile.replace({
        revision: 1,
        profile: {
          version: 1,
          servers: [{ url, projects: [], openSessionIDs: [], openSessionInputAt: 100 }],
        },
      })
      const omitted = yield* profile.replace({
        revision: 2,
        profile: { version: 1, servers: [{ url, projects: [], openSessionIDs: [] }] },
      })
      const owner = yield* profile.replace({
        revision: 3,
        profile: {
          version: 1,
          servers: [{ url, projects: [], openSessionIDs: [], openSessionInputAt: 200 }],
        },
      })

      expect(stale.profile.servers[0]).toMatchObject({
        openSessionIDs: [SessionID.make("ses_newest")],
        openSessionInputAt: 200,
      })
      expect(omitted.profile.servers[0]).toMatchObject({
        openSessionIDs: [SessionID.make("ses_newest")],
        openSessionInputAt: 200,
      })
      expect(owner.profile.servers[0]).toMatchObject({ openSessionIDs: [], openSessionInputAt: 200 })
    }),
  )

  it.effect("rejects invalid constructed URLs before committing", () =>
    Effect.gen(function* () {
      const profile = yield* Profile.Service
      const result = yield* profile
        .replace({
          revision: 0,
          profile: Profile.Document.make({
            version: 1,
            servers: [
              {
                url: Profile.ServerUrl.make(new URL("https://user:secret@example.com")),
                projects: [],
              },
            ],
          }),
        })
        .pipe(Effect.exit)

      expect(Exit.isFailure(result)).toBe(true)
      expect(yield* profile.get()).toEqual({ revision: 0, profile: { version: 1, servers: [] } })
    }),
  )

  it.effect("strips unknown credential fields before storing the document", () =>
    Effect.gen(function* () {
      const profile = yield* Profile.Service
      const server = {
        url: Profile.ServerUrl.make(new URL("https://opencode.example.com")),
        projects: [],
        username: "user",
        password: "secret",
        activeSessionID: "ses_active",
        drafts: ["draft"],
        closedSessionIDs: ["ses_closed"],
      }

      yield* profile.replace({
        revision: 0,
        profile: Profile.Document.make({ version: 1, servers: [server] }),
      })

      const row = yield* (yield* Database.Service).db.select().from(ProfileTable).get()
      expect(row?.document).toEqual({
        version: 1,
        servers: [{ url: "https://opencode.example.com/", projects: [] }],
      })
    }),
  )
})
