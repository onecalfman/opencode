import { Profile } from "@opencode-ai/schema/profile"
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"

const authentication =
  "Uses the server's current single-user Basic Authentication when configured. Profile data never includes credentials."

export const ProfileGroup = HttpApiGroup.make("server.profile")
  .add(
    HttpApiEndpoint.get("profile.get", "/api/profile", {
      success: Profile.Snapshot,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.profile.get",
        summary: "Get UI profile",
        description: `Get the machine-global synchronized UI profile. ${authentication}`,
      }),
    ),
  )
  .add(
    HttpApiEndpoint.put("profile.replace", "/api/profile", {
      payload: Profile.ReplaceInput,
      success: Profile.Snapshot,
      error: Profile.RevisionConflict,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.profile.replace",
        summary: "Replace UI profile",
        description: `Atomically replace the machine-global UI profile when its revision matches. ${authentication}`,
      }),
    ),
  )
  .annotateMerge(OpenApi.annotations({ title: "profile", description: "Machine-global synchronized UI profile." }))
