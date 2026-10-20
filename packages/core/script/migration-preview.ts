import { Database } from "bun:sqlite"
import { randomBytes } from "node:crypto"
import { constants, copyFile, mkdir } from "node:fs/promises"
import path from "node:path"

const [converted, config, destination, port = "4480"] = process.argv.slice(2)
process.umask(0o077)
if (!converted || !config || !destination || !path.isAbsolute(destination))
  throw new Error(
    "Usage: migration-preview.ts <offline converted.db> <isolated config> <new private runtime directory>",
  )
const wal = Bun.file(`${converted}-wal`)
if ((await wal.exists()) && wal.size > 0)
  throw new Error("Close and checkpoint the converted database before previewing it")
await mkdir(destination, { mode: 0o700 })
const workspace = path.join(destination, "workspace")
await mkdir(workspace, { mode: 0o700 })
const filename = path.join(destination, "preview.db")
await copyFile(converted, filename, constants.COPYFILE_FICLONE)
using db = new Database(filename, { strict: true })
if (
  db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM session_v2 WHERE time_suspended IS NOT NULL").get()
    ?.count
)
  throw new Error("Preview refuses execution claims")
// The audited database remains untouched. This preview copy cannot discover production servers from profiles
// or resolve session Locations into active working directories.
db.run("UPDATE session_v2 SET directory = ?", [workspace])
db.run("UPDATE ui_profile SET document = ?", [JSON.stringify({ version: 1, servers: [] })])
const password = randomBytes(32).toString("base64url")
const url = "http://127.0.0.1:" + port
const env = {
  PATH: process.env.PATH,
  LANG: process.env.LANG,
  HOME: destination,
  OPENCODE_TEST_HOME: destination,
  XDG_DATA_HOME: path.join(destination, "data"),
  XDG_CONFIG_HOME: path.join(destination, "config"),
  XDG_CACHE_HOME: path.join(destination, "cache"),
  XDG_STATE_HOME: path.join(destination, "state"),
  OPENCODE_CONFIG_DIR: config,
  OPENCODE_CONFIG: path.join(config, "native-overrides.json"),
  OPENCODE_DB: filename,
  OPENCODE_PASSWORD: password,
  OPENCODE_CHANNEL: "dev",
  OPENCODE_DISABLE_PROJECT_CONFIG: "1",
  OPENCODE_DISABLE_CLAUDE_CODE: "1",
  OPENCODE_DISABLE_MODELS_FETCH: "1",
  OPENCODE_DISABLE_FILEWATCHER: "1",
  OPENCODE_DISABLE_FFF: "1",
  TMPDIR: process.env.TMPDIR,
}
const child = Bun.spawn(
  [
    process.execPath,
    "run",
    "--cwd",
    path.resolve(import.meta.dir, "../../cli"),
    "src/index.ts",
    "serve",
    "--hostname",
    "127.0.0.1",
    "--port",
    port,
  ],
  {
    env,
    stdin: "ignore",
    stdout: Bun.file(path.join(destination, "server.log")),
    stderr: Bun.file(path.join(destination, "server-error.log")),
  },
)
child.unref()
await Bun.write(
  path.join(destination, "connection-private.json"),
  JSON.stringify({ pid: child.pid, url, password, database: filename }, null, 2),
  { mode: 0o600 },
)
const deadline = Date.now() + 120_000
while (Date.now() < deadline) {
  const response = await fetch(url + "/api/experimental/migration/v1", {
    headers: { Authorization: "Basic " + btoa("opencode:" + password) },
  }).catch(() => undefined)
  if (response?.ok) {
    console.log(JSON.stringify({ pid: child.pid, url, ready: true }))
    process.exit(0)
  }
  if (child.exitCode !== null) throw new Error("Isolated preview exited; inspect its private logs")
  await Bun.sleep(200)
}
throw new Error("Isolated preview did not become ready; inspect its private logs")
