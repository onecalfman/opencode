import { PushNotification } from "@opencode/core/push"
import { InvalidRequestError } from "@opencode/protocol/errors"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/http-api"
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
