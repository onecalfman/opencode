import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261018041219_web-push",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`push_key\` (
          \`id\` integer PRIMARY KEY,
          \`public_key\` text NOT NULL,
          \`private_key\` text NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`push_subscription\` (
          \`id\` text PRIMARY KEY,
          \`endpoint\` text NOT NULL UNIQUE,
          \`registration\` text NOT NULL
        );
      `)
    })
  },
} satisfies DatabaseMigration.Migration
