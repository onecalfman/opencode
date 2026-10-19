import { createECDH } from "node:crypto"
import { NodeHttpServer, NodeServices } from "@effect/platform-node"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { PushNotification } from "@opencode-ai/core/push"
import { PushGroup } from "@opencode-ai/protocol/groups/push"
import { Authorization } from "@opencode-ai/protocol/middleware/authorization"
import { SchemaErrorMiddleware } from "@opencode-ai/protocol/middleware/schema-error"
import { ServerAuth } from "@opencode-ai/server/auth"
import { PushHandler } from "@opencode-ai/server/handlers/push"
import { authorizationLayer } from "@opencode-ai/server/middleware/authorization"
import { schemaErrorLayer } from "@opencode-ai/server/middleware/schema-error"
import { describe, expect } from "bun:test"
import { Effect, Layer, Option } from "effect"
import { HttpClient, HttpClientRequest, HttpRouter } from "effect/unstable/http"
import { HttpApi, HttpApiBuilder } from "effect/unstable/httpapi"
import { testEffect } from "../lib/effect"

const api = HttpApi.make("server").add(PushGroup).middleware(Authorization).middleware(SchemaErrorMiddleware)
const routes = HttpApiBuilder.layer(api).pipe(
  Layer.provide(PushHandler),
  Layer.provide(authorizationLayer),
  Layer.provide(schemaErrorLayer),
  Layer.provide(ServerAuth.Config.configLayer({ username: "opencode", password: Option.some("test-password") })),
  Layer.provide(AppNodeBuilder.build(PushNotification.node)),
)
const it = testEffect(
  HttpRouter.serve(routes, { disableListenLog: true, disableLogger: true }).pipe(
    Layer.provideMerge(NodeHttpServer.layerTest),
    Layer.provideMerge(NodeServices.layer),
  ),
)
const id = "a71521b1-6a87-46b7-a864-7c1d3663bdef"
const authorized = HttpClientRequest.setHeader("authorization", `Basic ${btoa("opencode:test-password")}`)

describe("push HttpApi", () => {
  it.live("authenticates configuration, registration, testing, and deletion", () =>
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient
      for (const request of [
        HttpClientRequest.get("/api/push"),
        HttpClientRequest.put(`/api/push/subscriptions/${id}`),
        HttpClientRequest.post(`/api/push/subscriptions/${id}/test`),
        HttpClientRequest.delete(`/api/push/subscriptions/${id}`),
      ]) {
        const response = yield* client.execute(request)
        expect(response.status).toBe(401)
      }
      const response = yield* client.execute(HttpClientRequest.get("/api/push").pipe(authorized))
      expect(response.status).toBe(200)
      const configuration = yield* response.json
      expect(configuration).toEqual({ publicKey: expect.stringMatching(/^[A-Za-z0-9_-]{87}$/) })
    }),
  )

  it.live("validates registrations and keeps management device-specific", () =>
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient
      const browser = createECDH("prime256v1")
      const registration = {
        subscription: {
          endpoint: "https://fcm.googleapis.com/fcm/send/test",
          keys: {
            p256dh: browser.generateKeys().toString("base64url"),
            auth: Buffer.alloc(16, 1).toString("base64url"),
          },
        },
        origin: "https://app.example.com",
        serverKey: "https://backend.example.com",
        preferences: { agent: true, permissions: true, errors: false },
        titles: { agent: "Ready", permission: "Permission", question: "Question", errors: "Error", test: "Test" },
      }
      const invalid = yield* client.execute(
        HttpClientRequest.put(`/api/push/subscriptions/${id}`).pipe(
          authorized,
          HttpClientRequest.bodyJsonUnsafe({
            ...registration,
            subscription: { ...registration.subscription, endpoint: "https://127.0.0.1/private" },
          }),
        ),
      )
      expect(invalid.status).toBe(400)
      const accepted = yield* client.execute(
        HttpClientRequest.put(`/api/push/subscriptions/${id}`).pipe(
          authorized,
          HttpClientRequest.bodyJsonUnsafe(registration),
        ),
      )
      expect(accepted.status).toBe(200)
      expect(yield* accepted.json).toBe(true)
      const badID = yield* client.execute(
        HttpClientRequest.put("/api/push/subscriptions/invalid").pipe(
          authorized,
          HttpClientRequest.bodyJsonUnsafe(registration),
        ),
      )
      expect(badID.status).toBe(400)
      const removed = yield* client.execute(HttpClientRequest.delete(`/api/push/subscriptions/${id}`).pipe(authorized))
      expect(removed.status).toBe(200)
      const test = yield* client.execute(HttpClientRequest.post(`/api/push/subscriptions/${id}/test`).pipe(authorized))
      expect(test.status).toBe(200)
      expect(yield* test.json).toBe(false)
    }),
  )
})
