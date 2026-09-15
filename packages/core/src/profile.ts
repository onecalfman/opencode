export * as Profile from "./profile"

import { and, eq } from "drizzle-orm"
import { Context, Effect, Layer, Schema, Scope } from "effect"
import { Profile } from "@opencode-ai/schema/profile"
import { Database } from "./database/database"
import { makeGlobalNode } from "./effect/app-node"
import { EventV2 } from "./event"
import { ProfileTable } from "./profile/sql"

export const ServerUrl = Profile.ServerUrl
export type ServerUrl = Profile.ServerUrl

export const OpenedProject = Profile.OpenedProject
export type OpenedProject = Profile.OpenedProject

export const Server = Profile.Server
export type Server = Profile.Server

export const Document = Profile.Document
export type Document = Profile.Document

export const Revision = Profile.Revision
export type Revision = Profile.Revision

export const Snapshot = Profile.Snapshot
export type Snapshot = Profile.Snapshot

export const ReplaceInput = Profile.ReplaceInput
export type ReplaceInput = Profile.ReplaceInput

export const RevisionConflict = Profile.RevisionConflict
export type RevisionConflict = Profile.RevisionConflict

export const Event = Profile.Event

const ID = 1 as const
const initial = { version: 1, servers: [] } satisfies typeof Document.Encoded

export interface Interface {
  readonly get: () => Effect.Effect<Snapshot>
  readonly replace: (input: ReplaceInput) => Effect.Effect<Snapshot, RevisionConflict>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Profile") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const events = yield* EventV2.Service
    const scope = yield* Scope.Scope
    const decode = Schema.decodeUnknownSync(Document)
    const validate = Schema.encodeUnknownEffect(Document)

    yield* db
      .insert(ProfileTable)
      .values({ id: ID, revision: 0, document: initial })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)

    const snapshot = (row: typeof ProfileTable.$inferSelect) =>
      Snapshot.make({ revision: row.revision, profile: decode(row.document) })

    const get = Effect.fn("Profile.get")(function* () {
      const row = yield* db.select().from(ProfileTable).where(eq(ProfileTable.id, ID)).get().pipe(Effect.orDie)
      if (!row) return yield* Effect.die("UI profile singleton is missing")
      return snapshot(row)
    })

    const replace = Effect.fn("Profile.replace")(function* (input: ReplaceInput) {
      if (input.revision >= Number.MAX_SAFE_INTEGER) return yield* Effect.die("UI profile revision is exhausted")
      const current = yield* db.select().from(ProfileTable).where(eq(ProfileTable.id, ID)).get().pipe(Effect.orDie)
      if (!current) return yield* Effect.die("UI profile singleton is missing")
      const validated = yield* validate(input.profile).pipe(Effect.orDie)
      const previous = new Map(current.document.servers.map((server) => [server.url, server]))
      const document = {
        ...validated,
        servers: validated.servers.map((server) => {
          const existing = previous.get(server.url)
          if (!existing) return server
          if (
            existing.openSessionInputAt !== undefined &&
            (server.openSessionInputAt === undefined || server.openSessionInputAt < existing.openSessionInputAt)
          )
            return {
              ...server,
              ...(existing.openSessionIDs === undefined ? {} : { openSessionIDs: existing.openSessionIDs }),
              openSessionInputAt: existing.openSessionInputAt,
            }
          if (server.openSessionIDs !== undefined) return server
          return existing.openSessionIDs === undefined ? server : { ...server, openSessionIDs: existing.openSessionIDs }
        }),
      }
      const row = yield* db
        .update(ProfileTable)
        .set({ revision: input.revision + 1, document })
        .where(and(eq(ProfileTable.id, ID), eq(ProfileTable.revision, input.revision)))
        .returning()
        .get()
        .pipe(Effect.orDie)
      if (!row) {
        const current = yield* get()
        return yield* new RevisionConflict({
          message: "UI profile revision conflict",
          expectedRevision: input.revision,
          actualRevision: current.revision,
        })
      }
      const updated = snapshot(row)
      // The row is authoritative; an invalidation failure must not report a committed CAS update as failed.
      yield* events.publish(Event.Updated, updated).pipe(
        Effect.timeout("10 seconds"),
        Effect.catchCause((cause) => Effect.logError("Failed to publish profile update", { cause })),
        Effect.forkIn(scope, { startImmediately: true }),
      )
      return updated
    })

    return Service.of({ get, replace })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node, EventV2.node] })
