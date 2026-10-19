export * as PushNotification from "./push"

import { createHash, ECDH } from "node:crypto"
import { and, eq, ne } from "drizzle-orm"
import { Push } from "@opencode-ai/schema/push"
import { SessionID } from "@opencode-ai/schema/session-id"
import { Config, Context, Effect, Layer, Queue, Schedule, Schema } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import { Database } from "./database/database"
import { makeGlobalNode } from "./effect/app-node"
import { httpClient } from "./effect/app-node-platform"
import { EventV2 } from "./event"
import { PushKeyTable, PushSubscriptionTable } from "./push/sql"
import { SessionTable } from "./session/sql"

export class InvalidRegistration extends Schema.TaggedErrorClass<InvalidRegistration>()("Push.InvalidRegistration", {
  message: Schema.String,
}) {}

export interface Interface {
  readonly configuration: () => Effect.Effect<Push.Configuration>
  readonly register: (id: string, input: Push.Registration) => Effect.Effect<boolean, InvalidRegistration>
  readonly remove: (id: string) => Effect.Effect<boolean>
  readonly test: (id: string) => Effect.Effect<boolean>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/PushNotification") {}

const kind = (event: EventV2.Payload) => {
  if (event.type === "session.idle") return "agent"
  if (event.type === "session.error") return "errors"
  if (event.type === "permission.asked" || event.type === "permission.v2.asked") return "permission"
  if (event.type === "question.asked" || event.type === "question.v2.asked") return "question"
  if (event.type !== "session.execution.finished") return
  const data = event.data as { outcome: string }
  if (data.outcome === "completed") return "agent"
  if (data.outcome === "failed") return "errors"
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const events = yield* EventV2.Service
    const client = yield* HttpClient.HttpClient
    const subject = yield* Config.string("OPENCODE_WEB_PUSH_SUBJECT").pipe(Config.withDefault("https://opencode.ai"))
    const keys = yield* Effect.cached(
      Effect.gen(function* () {
        const existing = yield* db.select().from(PushKeyTable).where(eq(PushKeyTable.id, 1)).get().pipe(Effect.orDie)
        if (existing) return existing
        const { generateVAPIDKeys } = yield* Effect.promise(() => import("web-push"))
        const generated = generateVAPIDKeys()
        yield* db
          .insert(PushKeyTable)
          .values({ id: 1, public_key: generated.publicKey, private_key: generated.privateKey })
          .onConflictDoNothing()
          .run()
          .pipe(Effect.orDie)
        const stored = yield* db.select().from(PushKeyTable).where(eq(PushKeyTable.id, 1)).get().pipe(Effect.orDie)
        if (!stored) return yield* Effect.die("Push signing key is missing")
        return stored
      }),
    )

    const send = Effect.fn("PushNotification.send")(function* (
      row: typeof PushSubscriptionTable.$inferSelect,
      payload: { title: string; body: string; url: string; tag: string },
    ) {
      const key = yield* keys
      const { generateRequestDetails } = yield* Effect.promise(() => import("web-push"))
      const request = yield* Effect.try({
        try: () =>
          generateRequestDetails(row.registration.subscription, JSON.stringify(payload), {
            vapidDetails: { subject, publicKey: key.public_key, privateKey: key.private_key },
            TTL: 3600,
            urgency: "high",
            topic: createHash("sha256").update(payload.tag).digest("base64url").slice(0, 32),
          }),
        catch: () => new Error("Could not encrypt push notification"),
      })
      const response = yield* client
        .execute(
          HttpClientRequest.post(request.endpoint, {
            headers: Object.fromEntries(Object.entries(request.headers).map(([name, value]) => [name, String(value)])),
          }).pipe(HttpClientRequest.bodyUint8Array(request.body ?? new Uint8Array(), "application/octet-stream")),
        )
        .pipe(
          Effect.flatMap((response) =>
            response.status === 429 || response.status >= 500
              ? Effect.fail(new Error("Push service temporarily unavailable"))
              : Effect.succeed(response),
          ),
          Effect.timeout("10 seconds"),
          Effect.retry({ times: 2, schedule: Schedule.exponential("1 second") }),
        )
      if (response.status === 404 || response.status === 410) {
        // Do not remove a registration replaced while this request was in flight.
        yield* db
          .delete(PushSubscriptionTable)
          .where(and(eq(PushSubscriptionTable.id, row.id), eq(PushSubscriptionTable.endpoint, row.endpoint)))
          .run()
          .pipe(Effect.orDie)
      }
      if (response.status < 200 || response.status >= 300)
        yield* Effect.logWarning("Push service rejected notification", { status: response.status })
      return response.status >= 200 && response.status < 300
    })

    const deliver = Effect.fn("PushNotification.deliver")(function* (event: EventV2.Payload) {
      const channel = kind(event)
      if (!channel) return
      const data = event.data as { sessionID?: string; error?: { name?: string } }
      if (!data.sessionID || data.error?.name === "MessageAbortedError") return
      const session = yield* db
        .select()
        .from(SessionTable)
        .where(eq(SessionTable.id, SessionID.make(data.sessionID)))
        .get()
        .pipe(Effect.orDie)
      if (!session) return
      if ((channel === "agent" || channel === "errors") && session.parent_id) return
      const rows = yield* db.select().from(PushSubscriptionTable).all().pipe(Effect.orDie)
      yield* Effect.forEach(
        rows.filter(
          (row) =>
            row.registration.preferences[
              channel === "permission" ? "permissions" : channel === "question" ? "agent" : channel
            ],
        ),
        (row) =>
          send(row, {
            title: row.registration.titles[channel],
            body: session.title.slice(0, 128),
            url: new URL(
              `/server/${Buffer.from(row.registration.serverKey).toString("base64url")}/session/${encodeURIComponent(session.id)}`,
              row.registration.origin,
            ).href,
            tag: createHash("sha256")
              .update(`${row.registration.serverKey}:${session.id}:${channel}`)
              .digest("base64url")
              .slice(0, 32),
          }).pipe(Effect.catchCause(() => Effect.logWarning("Could not deliver push notification"))),
        { concurrency: 4, discard: true },
      )
    })

    // Admission never waits on a phone's push service or delays a model/tool boundary.
    const queue = yield* Queue.dropping<EventV2.Payload>(1024)
    const failed = new Set<string>()
    const unsubscribe = yield* events.listen((event) => {
      const data = event.data as { sessionID?: string; status?: { type?: string } }
      if (data.sessionID) {
        if (event.type === "session.error") failed.add(data.sessionID)
        if (event.type === "session.status" && data.status?.type === "busy") failed.delete(data.sessionID)
        if (event.type === "session.idle" && failed.delete(data.sessionID)) return Effect.void
      }
      return kind(event)
        ? Queue.offer(queue, event).pipe(
            Effect.flatMap((accepted) =>
              accepted ? Effect.void : Effect.logWarning("Push notification queue is full"),
            ),
          )
        : Effect.void
    })
    yield* Effect.addFinalizer(() => unsubscribe.pipe(Effect.andThen(Queue.shutdown(queue))))
    yield* Queue.take(queue).pipe(
      Effect.flatMap(deliver),
      Effect.catchCause(() => Effect.logWarning("Could not process push notification")),
      Effect.forever,
      Effect.forkScoped,
    )

    return Service.of({
      configuration: () => keys.pipe(Effect.map((key) => ({ publicKey: key.public_key }))),
      register: Effect.fn("PushNotification.register")(function* (id, input) {
        yield* Schema.encodeUnknownEffect(Push.Registration)(input).pipe(
          Effect.mapError(() => new InvalidRegistration({ message: "Invalid push registration" })),
        )
        yield* Effect.try({
          try: () => requireRegistration(input),
          catch: (error) =>
            error instanceof InvalidRegistration
              ? error
              : new InvalidRegistration({ message: "Invalid push encryption key" }),
        })
        yield* db
          .transaction((tx) =>
            Effect.gen(function* () {
              yield* tx
                .delete(PushSubscriptionTable)
                .where(
                  and(
                    eq(PushSubscriptionTable.endpoint, input.subscription.endpoint),
                    ne(PushSubscriptionTable.id, id),
                  ),
                )
                .run()
              yield* tx
                .insert(PushSubscriptionTable)
                .values({ id, endpoint: input.subscription.endpoint, registration: input })
                .onConflictDoUpdate({
                  target: PushSubscriptionTable.id,
                  set: { endpoint: input.subscription.endpoint, registration: input },
                })
                .run()
            }),
          )
          .pipe(Effect.orDie)
        return true
      }),
      remove: (id) =>
        db
          .delete(PushSubscriptionTable)
          .where(eq(PushSubscriptionTable.id, id))
          .run()
          .pipe(Effect.orDie, Effect.as(true)),
      test: Effect.fn("PushNotification.test")(function* (id) {
        const row = yield* db
          .select()
          .from(PushSubscriptionTable)
          .where(eq(PushSubscriptionTable.id, id))
          .get()
          .pipe(Effect.orDie)
        if (!row) return false
        return yield* send(row, {
          title: row.registration.titles.test,
          body: "OpenCode",
          url: `${row.registration.origin}/`,
          tag: `test:${id}`,
        }).pipe(Effect.catchCause(() => Effect.succeed(false)))
      }),
    })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node, EventV2.node, httpClient] })

function requireRegistration(input: Push.Registration) {
  const server = URL.canParse(input.serverKey) ? new URL(input.serverKey) : undefined
  if (
    !server ||
    !["http:", "https:"].includes(server.protocol) ||
    server.username ||
    server.password ||
    server.search ||
    server.hash
  )
    throw new InvalidRegistration({ message: "Server identity must be a credential-free HTTP URL" })
  const endpoint = URL.canParse(input.subscription.endpoint) ? new URL(input.subscription.endpoint) : undefined
  // Push subscriptions are capabilities. Restrict outbound destinations to browser push services.
  if (
    !endpoint ||
    endpoint.protocol !== "https:" ||
    endpoint.port ||
    endpoint.username ||
    endpoint.password ||
    !/^(fcm\.googleapis\.com|updates\.push\.services\.mozilla\.com|[a-z0-9.-]+\.push\.apple\.com|[a-z0-9.-]+\.notify\.windows\.com)$/.test(
      endpoint.hostname,
    )
  )
    throw new InvalidRegistration({ message: "Unsupported push service endpoint" })
  const origin = URL.canParse(input.origin) ? new URL(input.origin) : undefined
  if (
    !origin ||
    origin.origin !== input.origin ||
    (origin.protocol !== "https:" && !["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname))
  )
    throw new InvalidRegistration({ message: "Push notifications require a secure web origin" })
  ECDH.convertKey(Buffer.from(input.subscription.keys.p256dh, "base64url"), "prime256v1")
}
