import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260910155807_ui-profile",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`ui_profile\` (
          \`id\` integer PRIMARY KEY,
          \`revision\` integer NOT NULL,
          \`document\` text NOT NULL,
          CONSTRAINT "ui_profile_singleton" CHECK("id" = 1)
        );
      `)
    })
  },
} satisfies DatabaseMigration.Migration
