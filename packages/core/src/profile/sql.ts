import { sql } from "drizzle-orm"
import { check, integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { Profile } from "@opencode-ai/schema/profile"

export const ProfileTable = sqliteTable(
  "ui_profile",
  {
    id: integer().$type<1>().primaryKey(),
    revision: integer().notNull(),
    document: text({ mode: "json" }).$type<typeof Profile.Document.Encoded>().notNull(),
  },
  (table) => [check("ui_profile_singleton", sql`${table.id} = 1`)],
)
