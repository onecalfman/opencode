import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import type { Push } from "@opencode/schema/push"

export const PushKeyTable = sqliteTable("push_key", {
  id: integer().primaryKey(),
  public_key: text().notNull(),
  private_key: text().notNull(),
})

export const PushSubscriptionTable = sqliteTable("push_subscription", {
  id: text().primaryKey(),
  endpoint: text().notNull().unique(),
  registration: text({ mode: "json" }).$type<Push.Registration>().notNull(),
})
