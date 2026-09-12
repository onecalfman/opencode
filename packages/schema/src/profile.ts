export * as Profile from "./profile"

import { Schema, SchemaTransformation } from "effect"
import { define, inventory } from "./event"
import { NonNegativeInt, optional } from "./schema"
import { SessionID } from "./session-id"

const ServerUrlString = Schema.String.check(
  Schema.isPattern(
    /^https?:\/\/(?![^/?#\s]*@)(?:\[[0-9a-f:.]+\]|[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)(?::[1-9]\d{0,4})?(?:\/[^\s?#]*)?$/i,
  ),
)
export const ServerUrl = ServerUrlString.pipe(Schema.decodeTo(Schema.URL, SchemaTransformation.urlFromString)).annotate(
  { identifier: "Profile.ServerUrl" },
)
export type ServerUrl = typeof ServerUrl.Type

export interface OpenedProject extends Schema.Schema.Type<typeof OpenedProject> {}
export const OpenedProject = Schema.Struct({
  worktree: Schema.String,
}).annotate({ identifier: "Profile.OpenedProject" })

export interface Server extends Schema.Schema.Type<typeof Server> {}
export const Server = Schema.Struct({
  url: ServerUrl,
  name: optional(Schema.String),
  projects: Schema.Array(OpenedProject),
  openSessionIDs: optional(Schema.Array(SessionID)),
}).annotate({ identifier: "Profile.Server" })

export interface Document extends Schema.Schema.Type<typeof Document> {}
export const Document = Schema.Struct({
  version: Schema.Literal(1),
  servers: Schema.Array(Server),
}).annotate({ identifier: "Profile.Document" })

export const Revision = NonNegativeInt.annotate({ identifier: "Profile.Revision" })
export type Revision = typeof Revision.Type

export interface Snapshot extends Schema.Schema.Type<typeof Snapshot> {}
export const Snapshot = Schema.Struct({
  revision: Revision,
  profile: Document,
}).annotate({ identifier: "Profile.Snapshot" })

export interface ReplaceInput extends Schema.Schema.Type<typeof ReplaceInput> {}
export const ReplaceInput = Schema.Struct({
  revision: Revision.check(Schema.isLessThan(Number.MAX_SAFE_INTEGER)),
  profile: Document,
}).annotate({ identifier: "Profile.ReplaceInput" })

export class RevisionConflict extends Schema.TaggedErrorClass<RevisionConflict>()(
  "RevisionConflict",
  {
    message: Schema.String,
    expectedRevision: Revision,
    actualRevision: Revision,
  },
  { httpApiStatus: 409 },
) {}

const Updated = define({
  type: "profile.updated",
  schema: {
    revision: Revision,
    profile: Document,
  },
})
export const Event = { Updated, Definitions: inventory(Updated) }
