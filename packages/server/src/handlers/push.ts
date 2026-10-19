import { PushNotification } from "@opencode-ai/core/push"
import { InvalidRequestError } from "@opencode-ai/protocol/errors"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../api"

export const PushHandler = HttpApiBuilder.group(Api, "server.push", (handlers) =>
  Effect.gen(function* () {
    const push = yield* PushNotification.Service
    return handlers
      .handle("push.configuration", () => push.configuration())
      .handle("push.register", (ctx) =>
        push
          .register(ctx.params.id, ctx.payload)
          .pipe(
            Effect.catchTag("Push.InvalidRegistration", (error) => new InvalidRequestError({ message: error.message })),
          ),
      )
      .handle("push.remove", (ctx) => push.remove(ctx.params.id))
      .handle("push.test", (ctx) => push.test(ctx.params.id))
  }),
)
