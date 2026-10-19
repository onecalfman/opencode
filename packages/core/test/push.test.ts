import { describe, expect } from "bun:test"
import { createDecipheriv, createECDH, hkdfSync } from "node:crypto"
import { Context, Deferred, Effect, Layer, Queue } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import { AppNodeBuilder } from "../src/effect/app-node-builder"
import { LayerNode } from "../src/effect/layer-node"
import { Database } from "../src/database/database"
import { EventV2 } from "../src/event"
import { Project } from "../src/project"
import { ProjectTable } from "../src/project/sql"
import { PushNotification } from "../src/push"
import { PushKeyTable, PushSubscriptionTable } from "../src/push/sql"
import { SessionTable } from "../src/session/sql"
import { AbsolutePath } from "../src/schema"
import { SessionID } from "@opencode-ai/schema/session-id"
import { SessionExecutionEvent } from "@opencode-ai/schema/session-execution-event"
import { SessionStatusEvent } from "@opencode-ai/schema/session-status-event"
import { SessionV1 } from "@opencode-ai/schema/session-v1"
import { Permission } from "@opencode-ai/schema/permission"
import { Question } from "@opencode-ai/schema/question"
import { PermissionV1 } from "@opencode-ai/schema/permission-v1"
import { QuestionV1 } from "@opencode-ai/schema/question-v1"
import { testEffect } from "./lib/effect"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node, EventV2.node])))
const id = "f71521b1-6a87-46b7-a864-7c1d3663bdef"
const sessionID = SessionID.make("ses_push_test")

const fixture = Effect.gen(function* () {
  const db = (yield* Database.Service).db
  const requests = yield* Queue.unbounded<{ title: string; body: string; url: string; tag: string }>()
  const browser = createECDH("prime256v1")
  const publicKey = browser.generateKeys()
  const auth = crypto.getRandomValues(new Uint8Array(16))
  const status: { code: number; blocked?: Deferred.Deferred<void> } = { code: 201 }
  const client = HttpClient.make((request) =>
    Effect.gen(function* () {
      expect(request.headers["content-encoding"]).toBe("aes128gcm")
      expect(request.headers.authorization).toMatch(/^vapid t=.+, k=/)
      expect(request.headers).not.toHaveProperty("cookie")
      expect(request.body._tag).toBe("Uint8Array")
      if (request.body._tag !== "Uint8Array") return yield* Effect.die("Missing encrypted body")
      const body = Buffer.from(request.body.body)
      const serverKey = body.subarray(21, 21 + body.readUInt8(20))
      const ikm = Buffer.from(
        hkdfSync(
          "sha256",
          browser.computeSecret(serverKey),
          auth,
          Buffer.concat([Buffer.from("WebPush: info\0"), publicKey, serverKey]),
          32,
        ),
      )
      const key = Buffer.from(
        hkdfSync("sha256", ikm, body.subarray(0, 16), Buffer.from("Content-Encoding: aes128gcm\0"), 16),
      )
      const nonce = Buffer.from(
        hkdfSync("sha256", ikm, body.subarray(0, 16), Buffer.from("Content-Encoding: nonce\0"), 12),
      )
      const decipher = createDecipheriv("aes-128-gcm", key, nonce)
      decipher.setAuthTag(body.subarray(-16))
      const plaintext = Buffer.concat([decipher.update(body.subarray(21 + body.readUInt8(20), -16)), decipher.final()])
      expect(plaintext[plaintext.length - 1]).toBe(2)
      yield* Queue.offer(requests, JSON.parse(plaintext.subarray(0, -1).toString()))
      if (status.blocked) yield* Deferred.await(status.blocked)
      return HttpClientResponse.fromWeb(request, new Response(null, { status: status.code }))
    }),
  )
  const push = Context.get(
    yield* Layer.build(PushNotification.layer.pipe(Layer.provide(Layer.succeed(HttpClient.HttpClient, client)))),
    PushNotification.Service,
  )
  const registration = {
    subscription: {
      endpoint: "https://fcm.googleapis.com/fcm/send/test",
      keys: {
        p256dh: publicKey.toString("base64url"),
        auth: Buffer.from(auth).toString("base64url"),
      },
    },
    origin: "https://opencode.example.com",
    serverKey: "https://backend.example.com",
    preferences: { agent: true, permissions: true, errors: true },
    titles: { agent: "Ready", permission: "Permission", question: "Question", errors: "Error", test: "Test" },
  }
  yield* db
    .insert(ProjectTable)
    .values({
      id: Project.ID.make("prj_push_test"),
      worktree: AbsolutePath.make("/workspace"),
      sandboxes: [],
      time_created: 1,
      time_updated: 1,
    })
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionTable)
    .values({
      id: sessionID,
      project_id: Project.ID.make("prj_push_test"),
      directory: AbsolutePath.make("/workspace"),
      title: "My task",
      slug: "push-test",
      version: "1",
      time_created: 1,
      time_updated: 1,
    })
    .run()
    .pipe(Effect.orDie)
  return { db, push, requests, registration, status, client }
})

describe("Web Push", () => {
  it.live("never waits for push delivery at a session or input event boundary", () =>
    Effect.gen(function* () {
      const test = yield* fixture
      const events = yield* EventV2.Service
      const blocked = yield* Deferred.make<void>()
      test.status.blocked = blocked
      yield* test.push.register(id, test.registration)
      yield* events.publish(SessionStatusEvent.Idle, { sessionID }).pipe(Effect.timeout("1 second"))
      expect((yield* Queue.take(test.requests)).title).toBe("Ready")
      yield* events
        .publish(Question.Event.Asked, { id: Question.ID.create(), sessionID, questions: [] })
        .pipe(Effect.timeout("1 second"))
      yield* Deferred.succeed(blocked, undefined)
      expect((yield* Queue.take(test.requests)).title).toBe("Question")
    }).pipe(Effect.timeout("3 seconds")),
  )

  it.live("persists signing keys and reconciles subscription identity and endpoint rotation", () =>
    Effect.gen(function* () {
      const test = yield* fixture
      const first = yield* test.push.configuration()
      expect(first.publicKey).toHaveLength(87)
      const second = Context.get(
        yield* Layer.build(
          PushNotification.layer.pipe(Layer.provide(Layer.succeed(HttpClient.HttpClient, test.client))),
        ),
        PushNotification.Service,
      )
      expect(yield* second.configuration()).toEqual(first)
      expect(yield* test.db.select().from(PushKeyTable).all().pipe(Effect.orDie)).toHaveLength(1)
      yield* test.push.register(id, test.registration)
      yield* test.push.register(id, {
        ...test.registration,
        subscription: { ...test.registration.subscription, endpoint: "https://fcm.googleapis.com/fcm/send/rotated" },
      })
      const replacement = "f71521b1-6a87-46b7-a864-7c1d3663bdee"
      yield* test.push.register(replacement, {
        ...test.registration,
        subscription: { ...test.registration.subscription, endpoint: "https://fcm.googleapis.com/fcm/send/rotated" },
      })
      const rows = yield* test.db.select().from(PushSubscriptionTable).all().pipe(Effect.orDie)
      expect(rows).toHaveLength(1)
      expect(rows[0]?.id).toBe(replacement)
      yield* test.push.remove(replacement)
      expect(yield* test.push.test(replacement)).toBe(false)
    }),
  )

  it.live("rejects arbitrary destinations and insecure origins", () =>
    Effect.gen(function* () {
      const test = yield* fixture
      for (const endpoint of [
        "http://fcm.googleapis.com/test",
        "https://127.0.0.1/private",
        "https://fcm.googleapis.com.evil.test/push",
        "https://user:secret@fcm.googleapis.com/push",
        "https://fcm.googleapis.com:444/push",
      ]) {
        const error = yield* test.push
          .register(id, { ...test.registration, subscription: { ...test.registration.subscription, endpoint } })
          .pipe(Effect.flip)
        expect(error._tag).toBe("Push.InvalidRegistration")
      }
      expect(
        (yield* test.push.register(id, { ...test.registration, origin: "http://example.com" }).pipe(Effect.flip))._tag,
      ).toBe("Push.InvalidRegistration")
      expect(
        (yield* test.push
          .register(id, { ...test.registration, origin: "https://user:pass@example.com" })
          .pipe(Effect.flip))._tag,
      ).toBe("Push.InvalidRegistration")
      expect(
        (yield* test.push
          .register(id, { ...test.registration, serverKey: "https://user:secret@example.com" })
          .pipe(Effect.flip))._tag,
      ).toBe("Push.InvalidRegistration")
      expect(
        (yield* test.push
          .register(id, {
            ...test.registration,
            subscription: {
              ...test.registration.subscription,
              keys: { ...test.registration.subscription.keys, p256dh: Buffer.alloc(65).toString("base64url") },
            },
          })
          .pipe(Effect.flip))._tag,
      ).toBe("Push.InvalidRegistration")
    }),
  )

  it.live("delivers encrypted background completion, failure, and input requests from both runtimes", () =>
    Effect.gen(function* () {
      const test = yield* fixture
      const events = yield* EventV2.Service
      yield* test.push.register(id, test.registration)
      yield* events.publish(SessionStatusEvent.Idle, { sessionID })
      expect(yield* Queue.take(test.requests)).toMatchObject({
        title: "Ready",
        body: "My task",
        url: "https://opencode.example.com/server/aHR0cHM6Ly9iYWNrZW5kLmV4YW1wbGUuY29t/session/ses_push_test",
      })
      yield* events.publish(SessionExecutionEvent.Finished, { sessionID, outcome: "failed" })
      expect((yield* Queue.take(test.requests)).title).toBe("Error")
      yield* events.publish(SessionV1.Event.Error, {
        sessionID,
        error: { name: "UnknownError", data: { message: "Failed" } },
      })
      yield* events.publish(SessionStatusEvent.Idle, { sessionID })
      expect((yield* Queue.take(test.requests)).title).toBe("Error")
      yield* events.publish(SessionExecutionEvent.Finished, { sessionID, outcome: "interrupted" })
      yield* events.publish(Permission.Event.Asked, {
        id: Permission.ID.create(),
        sessionID,
        action: "edit",
        resources: ["a.ts"],
        save: [],
        metadata: {},
      })
      expect((yield* Queue.take(test.requests)).title).toBe("Permission")
      yield* events.publish(Question.Event.Asked, { id: Question.ID.create(), sessionID, questions: [] })
      expect((yield* Queue.take(test.requests)).title).toBe("Question")
      yield* events.publish(PermissionV1.Event.Asked, {
        id: PermissionV1.ID.ascending(),
        sessionID,
        permission: "edit",
        patterns: [],
        always: [],
        metadata: {},
      })
      expect((yield* Queue.take(test.requests)).title).toBe("Permission")
      yield* events.publish(QuestionV1.Event.Asked, { id: QuestionV1.ID.ascending(), sessionID, questions: [] })
      expect((yield* Queue.take(test.requests)).title).toBe("Question")
      yield* events.publish(SessionExecutionEvent.Finished, { sessionID, outcome: "completed" })
      expect((yield* Queue.take(test.requests)).title).toBe("Ready")
    }).pipe(Effect.timeout("5 seconds")),
  )

  it.live("respects preferences and omits child completion notifications", () =>
    Effect.gen(function* () {
      const test = yield* fixture
      const events = yield* EventV2.Service
      yield* test.push.register(id, {
        ...test.registration,
        preferences: { agent: false, permissions: true, errors: false },
      })
      yield* events.publish(SessionStatusEvent.Idle, { sessionID })
      yield* events.publish(Question.Event.Asked, { id: Question.ID.create(), sessionID, questions: [] })
      yield* events.publish(SessionExecutionEvent.Finished, { sessionID, outcome: "failed" })
      yield* events.publish(Permission.Event.Asked, {
        id: Permission.ID.create(),
        sessionID,
        action: "edit",
        resources: [],
        save: [],
        metadata: {},
      })
      expect((yield* Queue.take(test.requests)).title).toBe("Permission")
      yield* test.push.register(id, test.registration)
      const child = SessionID.make("ses_push_child")
      yield* test.db
        .insert(SessionTable)
        .values({
          id: child,
          parent_id: sessionID,
          project_id: Project.ID.make("prj_push_test"),
          directory: AbsolutePath.make("/workspace"),
          title: "Child",
          slug: "child",
          version: "1",
          time_created: 1,
          time_updated: 1,
        })
        .run()
        .pipe(Effect.orDie)
      yield* events.publish(SessionStatusEvent.Idle, { sessionID: child })
      yield* events.publish(SessionExecutionEvent.Finished, { sessionID, outcome: "completed" })
      expect((yield* Queue.take(test.requests)).body).toBe("My task")
    }).pipe(Effect.timeout("5 seconds")),
  )

  it.live("removes expired subscriptions on 404/410 and reports a failed test", () =>
    Effect.gen(function* () {
      const test = yield* fixture
      for (const status of [404, 410]) {
        test.status.code = status
        yield* test.push.register(id, test.registration)
        expect(yield* test.push.test(id)).toBe(false)
        expect(yield* test.db.select().from(PushSubscriptionTable).all().pipe(Effect.orDie)).toHaveLength(0)
      }
    }),
  )
})
