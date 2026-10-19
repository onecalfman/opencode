export * as Push from "./push.js"

import { Schema } from "effect"

const text = Schema.String.check(Schema.isMaxLength(128))

export const ID = Schema.String.check(
  Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i),
).annotate({ identifier: "Push.ID" })

export const Subscription = Schema.Struct({
  endpoint: Schema.String.check(Schema.isMaxLength(4096)),
  keys: Schema.Struct({
    p256dh: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{87}=?$/)),
    auth: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{22}={0,2}$/)),
  }),
}).annotate({ identifier: "Push.Subscription" })
export interface Subscription extends Schema.Schema.Type<typeof Subscription> {}

export const Preferences = Schema.Struct({
  agent: Schema.Boolean,
  permissions: Schema.Boolean,
  errors: Schema.Boolean,
}).annotate({ identifier: "Push.Preferences" })
export interface Preferences extends Schema.Schema.Type<typeof Preferences> {}

export const Registration = Schema.Struct({
  subscription: Subscription,
  origin: Schema.String.check(Schema.isMaxLength(512)),
  serverKey: Schema.String.check(Schema.isMaxLength(512)),
  preferences: Preferences,
  titles: Schema.Struct({ agent: text, permission: text, question: text, errors: text, test: text }),
}).annotate({ identifier: "Push.Registration" })
export interface Registration extends Schema.Schema.Type<typeof Registration> {}

export const Configuration = Schema.Struct({ publicKey: Schema.String }).annotate({ identifier: "Push.Configuration" })
export interface Configuration extends Schema.Schema.Type<typeof Configuration> {}
