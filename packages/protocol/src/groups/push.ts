import { Push } from "@opencode/schema/push"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api"
import { InvalidRequestError } from "../errors.js"

export const PushGroup = HttpApiGroup.make("server.push")
  .add(HttpApiEndpoint.get("push.configuration", "/api/push", { success: Push.Configuration }))
  .add(
    HttpApiEndpoint.put("push.register", "/api/push/subscriptions/:id", {
      params: { id: Push.ID },
      payload: Push.Registration,
      success: Schema.Boolean,
      error: InvalidRequestError,
    }),
  )
  .add(
    HttpApiEndpoint.delete("push.remove", "/api/push/subscriptions/:id", {
      params: { id: Push.ID },
      success: Schema.Boolean,
    }),
  )
  .add(
    HttpApiEndpoint.post("push.test", "/api/push/subscriptions/:id/test", {
      params: { id: Push.ID },
      success: Schema.Boolean,
    }),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "push",
      description: "Device-specific Web Push subscriptions, managed with server authentication.",
    }),
  )
