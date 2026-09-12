import { Profile } from "@opencode/core/profile"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/http-api"
import { Api } from "../api"

export const ProfileHandler = HttpApiBuilder.group(Api, "server.profile", (handlers) =>
  Effect.gen(function* () {
    const profile = yield* Profile.Service
    return handlers
      .handle("profile.get", () => profile.get())
      .handle("profile.replace", (ctx) => profile.replace(ctx.payload))
  }),
)
