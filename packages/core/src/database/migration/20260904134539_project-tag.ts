import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260904134539_project-tag",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`project\` ADD \`tag\` text;`)
    })
  },
} satisfies DatabaseMigration.Migration
