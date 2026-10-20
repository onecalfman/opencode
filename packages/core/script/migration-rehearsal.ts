import { Database } from "bun:sqlite"
import { chmod, copyFile, lstat, mkdir } from "node:fs/promises"
import path from "node:path"

const [mode, input, destination, auth] = process.argv.slice(2)
if (
  !["--snapshot", "--verify", "--fixture-from", "--fixture-with-projection"].includes(mode) ||
  !input ||
  !destination ||
  !path.isAbsolute(destination)
) {
  throw new Error(
    "Usage: bun script/migration-rehearsal.ts <--snapshot | --fixture-from | --fixture-with-projection> <offline.db or V1 checkout> <new absolute directory>",
  )
}

// An exclusive new directory prevents a rehearsal from opening an existing candidate or service database.
if (mode !== "--verify") await mkdir(destination, { mode: 0o700 })
const sourcePath = path.join(destination, "source.db")
if (mode === "--snapshot") {
  if (!(await lstat(input)).isFile() || (await Bun.file(`${input}-wal`).exists())) {
    throw new Error("Supply a standalone, offline SQLite backup, not an active database or symlink")
  }
  await copyFile(input, sourcePath)
}
if (mode === "--fixture-from" || mode === "--fixture-with-projection")
  await seedFixture(input, sourcePath, mode === "--fixture-with-projection")
await chmod(sourcePath, 0o600)
const before = inspect(sourcePath)
const sourceDigest = await digest(sourcePath)
const candidatePath = path.join(destination, "candidate.db")
if (mode === "--verify") {
  const receipt = await Bun.file(path.join(destination, "report.json")).json()
  if (receipt.sourceDigest !== sourceDigest || !(await Bun.file(candidatePath).exists()))
    throw new Error("Existing rehearsal source does not match its receipt")
}
if (mode !== "--verify") await copyFile(sourcePath, candidatePath)
await chmod(candidatePath, 0o600)

// Set every root before loading runtime modules. Only Database and the converter are built: no service election,
// session recovery, plugins, provider execution, tools, push delivery, or listener is started.
process.env.HOME = destination
process.env.OPENCODE_TEST_HOME = destination
process.env.XDG_CONFIG_HOME = path.join(destination, "config")
process.env.XDG_DATA_HOME = path.join(destination, "data")
process.env.XDG_CACHE_HOME = path.join(destination, "cache")
process.env.XDG_STATE_HOME = path.join(destination, "state")
process.env.OPENCODE_CONFIG_DIR = path.join(destination, "config", "opencode")
process.env.OPENCODE_DB = candidatePath
delete process.env.OPENCODE_CONFIG
delete process.env.OPENCODE_CONFIG_CONTENT
const { Cause, Effect, Exit } = await import("effect")
const { Global } = await import("@opencode/util/global")
const database = await import("../src/database/database.js")
const { V1Migration } = await import("../src/database/v1-migration.js")
const { SessionTable } = await import("../src/session/sql.js")
const { sql } = await import("drizzle-orm")
const global = Global.make({
  home: destination,
  data: path.join(destination, "data", "opencode"),
  config: path.join(destination, "config", "opencode"),
  cache: path.join(destination, "cache", "opencode"),
  state: path.join(destination, "state", "opencode"),
  tmp: path.join(destination, "tmp"),
  bin: path.join(destination, "bin"),
  log: path.join(destination, "log"),
  repos: path.join(destination, "repos"),
})
await Promise.all(Object.values(global).map((directory) => mkdir(directory, { recursive: true, mode: 0o700 })))
if (auth) {
  await copyFile(auth, path.join(global.data, "auth.json"))
  await chmod(path.join(global.data, "auth.json"), 0o600)
}
const audit = {
  sessions: 0,
  sourceMessages: 0,
  projectedMessages: 0,
  mismatchedSessions: 0,
  unaccountedMessages: 0,
  warnings: 0,
  omitted: {} as Record<string, number>,
}
const conversion = await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      yield* V1Migration.run()
      const first = inspect(candidatePath)
      yield* V1Migration.run()
      const second = inspect(candidatePath)
      if (JSON.stringify(first) !== JSON.stringify(second)) throw new Error("Conversion is not idempotent")
      const db = (yield* database.Database.Service).db
      const sessions = yield* db.select().from(SessionTable)
      type Legacy = Parameters<typeof V1Migration.transformSession>[0]
      for (const session of sessions) {
        if (before.projectionOnlySessionIDs.includes(session.id)) continue
        const messages = yield* db.all<Legacy["messages"][number]>(
          sql`SELECT id, session_id, time_created, time_updated, data FROM message WHERE session_id = ${session.id}`,
        )
        const parts = yield* db.all<Legacy["parts"][number]>(
          sql`SELECT id, message_id, session_id, time_created, time_updated, data FROM part WHERE session_id = ${session.id}`,
        )
        const expected = V1Migration.transformSession({ session, messages, parts })
        const actual = yield* db.all<{
          id: string
          type: string
          seq: number
          time_created: number
          time_updated: number
          data: string
        }>(
          sql`SELECT id, type, seq, time_created, time_updated, data FROM session_message WHERE session_id = ${session.id} ORDER BY seq`,
        )
        if (
          actual.length !== expected.messages.length ||
          actual.some((row, index) => {
            const value = expected.messages[index]
            return (
              !value ||
              row.id !== value.id ||
              row.type !== value.type ||
              row.seq !== value.seq ||
              row.time_created !== value.time_created ||
              row.time_updated !== value.time_updated ||
              row.data !== JSON.stringify(value.data)
            )
          })
        )
          audit.mismatchedSessions++
        const accounted = new Set([
          ...expected.messages.map((row) => row.id),
          ...expected.omitted.map((row) => row.messageID),
        ])
        audit.unaccountedMessages += messages.filter((row) => !accounted.has(row.id)).length
        expected.omitted.forEach((row) => {
          audit.omitted[row.reason] = (audit.omitted[row.reason] ?? 0) + 1
        })
        audit.sessions++
        audit.sourceMessages += messages.length
        audit.projectedMessages += actual.length
        audit.warnings += expected.warnings.length
        yield* Effect.yieldNow
      }
    }).pipe(
      Effect.provide(database.Database.layer({ path: candidatePath })),
      Effect.provideService(Global.Service, global),
    ),
  ).pipe(Effect.exit),
)

const after = inspect(candidatePath)
const checks = {
  conversionCompleted: Exit.isSuccess(conversion),
  sourceUnchanged:
    sourceDigest === (await digest(sourcePath)) &&
    (!["--snapshot", "--verify"].includes(mode) || sourceDigest === (await digest(input))),
  integrity: after.integrity === "ok",
  foreignKeys: after.foreignKeyViolations === 0,
  sessionsPresent: [...before.sessionIDs, ...before.currentSessionIDs].every((id) =>
    after.currentSessionIDs.includes(id),
  ),
  legacyMessagesAccountedFor:
    Exit.isSuccess(conversion) &&
    audit.mismatchedSessions === 0 &&
    audit.unaccountedMessages === 0 &&
    audit.warnings === 0,
  legacyMessagesPreserved: before.preserved.message === after.preserved.message,
  legacyPartsPreserved: before.preserved.part === after.preserved.part,
  projectTagsPreserved: before.projectTags === after.projectTags,
  profilesPreserved: before.preserved.ui_profile === after.preserved.ui_profile,
  signingKeysPreserved: before.preserved.push_key === after.preserved.push_key,
  subscriptionsPreserved: before.preserved.push_subscription === after.preserved.push_subscription,
  credentialsPreserved: before.credentials.every((value) => after.credentials.includes(value)),
  projectionOnlyHistoryPreserved: before.projectionOnlyMessages.every((message) =>
    after.currentMessages.includes(message),
  ),
  noPendingLegacyInputs: before.pendingLegacyInputs === 0,
}
const report = {
  mode,
  createdAt: new Date().toISOString(),
  sourceDigest,
  candidatePath,
  sourceCounts: before.counts,
  candidateCounts: after.counts,
  projectionOnlyMessages: before.projectionOnlyMessages.length,
  pendingLegacyInputs: before.pendingLegacyInputs,
  authFileIncluded: !!auth,
  projectionAudit: audit,
  migrationError: Exit.isFailure(conversion) ? String(Cause.squash(conversion.cause)) : undefined,
  checks,
  readyForDataReview: Object.values(checks).every(Boolean),
}
await Bun.write(
  path.join(destination, mode === "--verify" ? "report-verified.json" : "report.json"),
  `${JSON.stringify(report, null, 2)}\n`,
  { mode: 0o600 },
)
console.log(JSON.stringify(report, null, 2))
if (!report.readyForDataReview) process.exitCode = 1

async function digest(filename: string) {
  const hash = new Bun.CryptoHasher("sha256")
  for await (const chunk of Bun.file(filename).stream()) hash.update(chunk)
  return hash.digest("hex")
}

function inspect(filename: string) {
  using db = new Database(filename, { readonly: true, strict: true })
  const tables = new Set(
    db
      .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((row) => row.name),
  )
  const hash = (value: unknown) => new Bun.CryptoHasher("sha256").update(JSON.stringify(value)).digest("hex")
  // Production history exceeds the JS string/heap limits: hash rows incrementally instead of materializing it.
  const preserved = Object.fromEntries(
    ["message", "part", "ui_profile", "push_key", "push_subscription", "credential"].map((table) => {
      const checksum = new Bun.CryptoHasher("sha256")
      if (tables.has(table)) {
        for (const row of db.query(`SELECT * FROM "${table}" ORDER BY id`).iterate()) {
          checksum.update(JSON.stringify(row)).update("\n")
        }
      }
      return [table, checksum.digest("hex")]
    }),
  )
  const ids = (table: string) =>
    tables.has(table)
      ? db
          .query<{ id: string }, []>(`SELECT id FROM "${table}" ORDER BY id`)
          .all()
          .map((row) => row.id)
      : []
  const projectColumns = tables.has("project") ? db.query<{ name: string }, []>("PRAGMA table_info(project)").all() : []
  const legacyMessages = new Set(
    tables.has("message")
      ? db
          .query<{ id: string; session_id: string }, []>("SELECT id, session_id FROM message")
          .all()
          .map((row) => `${row.session_id}\n${row.id}`)
      : [],
  )
  const currentMessageIDs: string[] = []
  const currentMessages: string[] = []
  const projectionOnlyMessages: string[] = []
  const projectionOnlySessionIDs = new Set<string>()
  if (tables.has("session_message")) {
    for (const row of db
      .query<
        { id: string; session_id: string; type: string; seq: number; data: string },
        []
      >("SELECT id, session_id, type, seq, data FROM session_message ORDER BY id")
      .iterate()) {
      const checksum = hash(row)
      currentMessageIDs.push(row.id)
      currentMessages.push(checksum)
      if (!legacyMessages.has(`${row.session_id}\n${row.id}`)) {
        projectionOnlyMessages.push(checksum)
        projectionOnlySessionIDs.add(row.session_id)
      }
    }
  }
  return {
    integrity: db.query<{ quick_check: string }, []>("PRAGMA quick_check").get()?.quick_check,
    foreignKeyViolations: db.query("PRAGMA foreign_key_check").all().length,
    counts: Object.fromEntries(
      [
        "project",
        "session",
        "session_v2",
        "message",
        "part",
        "session_message",
        "session_input",
        "session_inbox",
        "ui_profile",
        "push_key",
        "push_subscription",
        "credential",
        "migration",
      ].map((table) => [
        table,
        tables.has(table)
          ? (db.query<{ count: number }, []>(`SELECT COUNT(*) AS count FROM "${table}"`).get()?.count ?? 0)
          : 0,
      ]),
    ),
    sessionIDs: ids("session"),
    currentSessionIDs: ids("session_v2"),
    legacyMessageIDs: ids("message"),
    currentMessageIDs,
    currentMessages,
    projectionOnlyMessages,
    projectionOnlySessionIDs: [...projectionOnlySessionIDs],
    pendingLegacyInputs: tables.has("session_input")
      ? (db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM session_input WHERE promoted_seq IS NULL").get()
          ?.count ?? 0)
      : 0,
    projectTags: hash(
      projectColumns.some((column) => column.name === "tag")
        ? db.query("SELECT id, tag FROM project WHERE tag IS NOT NULL ORDER BY id").all()
        : [],
    ),
    preserved,
    credentials: tables.has("credential") ? db.query("SELECT * FROM credential ORDER BY id").all().map(hash) : [],
  }
}

async function seedFixture(checkout: string, filename: string, projected: boolean) {
  const schema = await Bun.file(path.join(checkout, "packages/core/src/database/schema.gen.ts")).text()
  const statements = [...schema.matchAll(/yield\* tx\.run\(\s*`((?:\\.|[^`])*)`\s*,?\s*\)/g)].map((match) =>
    match[1].replaceAll("\\`", "`"),
  )
  if (
    statements.length !== [...schema.matchAll(/yield\* tx\.run\(/g)].length ||
    statements.some((statement) => statement.includes("${"))
  ) {
    throw new Error("Fixture source is not a static generated V1 schema")
  }
  const journal = await Bun.file(path.join(checkout, "packages/core/src/database/migration.gen.ts")).text()
  const migrations = [...journal.matchAll(/import\("\.\/migration\/([^"\n]+)"\)/g)].map((match) => match[1])
  if (!migrations.includes("20261018041219_web-push"))
    throw new Error("Fixture source does not include the custom push migration")
  using db = new Database(filename, { create: true, strict: true })
  db.transaction(() => {
    statements.forEach((statement) => db.run(statement))
    db.run("CREATE TABLE migration (id TEXT PRIMARY KEY, time_completed INTEGER NOT NULL)")
    migrations.forEach((id) => db.run("INSERT INTO migration VALUES (?, 1)", [id]))
    db.run(
      "INSERT INTO project (id, worktree, name, tag, time_created, time_updated, sandboxes) VALUES ('fixture', '/rehearsal', 'Fixture', 'FX', 1, 2, '[]')",
    )
    const sessionIDs = projected ? ["ses_fixture_legacy", "ses_fixture_projected"] : ["ses_fixture_legacy"]
    sessionIDs.forEach((id) =>
      db.run(
        "INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated) VALUES (?, 'fixture', ?, '/rehearsal', 'Synthetic fixture', '1', 1, 2)",
        [id, id],
      ),
    )
    db.run("INSERT INTO message VALUES ('msg_000000000001aaaaaaaaaaaaaa', 'ses_fixture_legacy', 10, 11, ?)", [
      JSON.stringify({
        role: "user",
        time: { created: 10 },
        agent: "build",
        model: { providerID: "fixture", modelID: "fixture" },
      }),
    ])
    db.run(
      "INSERT INTO part VALUES ('prt_fixture', 'msg_000000000001aaaaaaaaaaaaaa', 'ses_fixture_legacy', 10, 11, ?)",
      [JSON.stringify({ type: "text", text: "Synthetic legacy history" })],
    )
    if (projected)
      db.run("INSERT INTO session_message VALUES ('msg_projected', 'ses_fixture_projected', 'user', 0, 10, 11, ?)", [
        JSON.stringify({ text: "Synthetic projection-only history", time: { created: 10 } }),
      ])
    db.run("INSERT INTO ui_profile VALUES (1, 7, ?)", [
      JSON.stringify({
        version: 1,
        servers: [
          {
            url: "https://fixture.invalid/",
            projects: [{ worktree: "/rehearsal" }],
            openSessionIDs: sessionIDs,
            openSessionInputAt: 123,
          },
        ],
      }),
    ])
    db.run("INSERT INTO push_key VALUES (1, 'synthetic-public-key', 'synthetic-private-key')")
    db.run(
      "INSERT INTO credential (id, integration_id, label, value, time_created, time_updated) VALUES ('cred_fixture', 'fixture', 'Fixture', ?, 1, 2)",
      [JSON.stringify({ type: "key", key: "synthetic-api-key" })],
    )
    db.run("INSERT INTO push_subscription VALUES ('fixture-device', 'https://fcm.googleapis.com/fixture', ?)", [
      JSON.stringify({ fixture: true }),
    ])
  })()
}
