import { chmod, cp, mkdir } from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { homedir } from "node:os"

const [snapshot, destination, googleChat, wakatime, mode = "validation"] = process.argv.slice(2)
if (!["validation", "cutover"].includes(mode)) throw new Error("Configuration mode must be validation or cutover")
if (!snapshot || !destination || !googleChat || !wakatime || !path.isAbsolute(destination))
  throw new Error(
    "Usage: migration-config.ts <snapshot> <new private config directory> <Google Chat package directory> <WakaTime package directory>",
  )
await mkdir(destination, { mode: 0o700 })
await cp(path.join(snapshot, "configuration/global"), destination, { recursive: true, force: false })
const { ConfigNormalize } = await import("../src/config/normalize.js")
const { Config } = await import("@opencode/schema/config")
const { Schema } = await import("effect")
const files: { file: string; diagnostics: { kind: string; path: readonly string[] }[]; mcpServers: number }[] = []
for (const name of ["opencode.json", "opencode.jsonc"]) {
  const file = Bun.file(path.join(destination, name))
  if (!(await file.exists())) continue
  const normalized = ConfigNormalize.normalize(Bun.JSONC.parse(await file.text()))
  if (normalized.type === "rejected") throw new Error(`Configuration rejected: ${name}`)
  const config = Schema.decodeUnknownSync(Schema.toEncoded(Config.Info))(normalized.encoded)
  const value = {
    ...config,
    update: "disable" as const,
    ...(config.mcp && mode === "validation"
      ? {
          mcp: {
            ...config.mcp,
            servers: Object.fromEntries(
              Object.entries(config.mcp.servers ?? {}).map(([key, entry]) => [key, { ...entry, disabled: true }]),
            ),
          },
        }
      : {}),
  }
  delete value.plugins
  Schema.decodeUnknownSync(Config.Info)(value)
  await Bun.write(file, JSON.stringify(value, null, 2) + "\n")
  await chmod(path.join(destination, name), 0o600)
  files.push({
    file: name,
    diagnostics: normalized.diagnostics.map((item) => ({ kind: item.kind, path: item.path })),
    mcpServers: Object.keys(config.mcp?.servers ?? {}).length,
  })
}
const packages = Bun.file(path.join(destination, "package.json"))
if (await packages.exists()) {
  const value = await packages.json()
  const dependencies = { ...value.dependencies }
  delete dependencies["@opencode-ai/plugin"]
  dependencies["@opencode/plugin"] = "2.0.32"
  await Bun.write(packages, JSON.stringify({ ...value, dependencies }, null, 2) + "\n")
  await chmod(path.join(destination, "package.json"), 0o600)
}
const overrides = {
  $schema: "https://opencode.ai/v2/config.json",
  update: "disable",
  permissions: [{ action: "external_directory", resource: "*", effect: "ask" }],
  plugins: [
    { package: pathToFileURL(path.resolve(googleChat)).href, options: mode === "validation" ? { webhookUrl: "" } : {} },
    {
      package: pathToFileURL(path.resolve(wakatime)).href,
      options: {
        binary: path.join(
          homedir(),
          ".wakatime",
          `wakatime-cli-${process.platform === "win32" ? "windows" : process.platform}-${process.arch === "x64" ? "amd64" : process.arch}${process.platform === "win32" ? ".exe" : ""}`,
        ),
      },
    },
  ],
}
Schema.decodeUnknownSync(Config.Info)(overrides)
await Bun.write(path.join(destination, "native-overrides.json"), JSON.stringify(overrides, null, 2) + "\n", {
  mode: 0o600,
})
const report = {
  mode,
  files,
  pluginCount: overrides.plugins.length,
  mcpConnectionsDisabledForValidation: mode === "validation",
  googleChatDeliveryDisabledForValidation: mode === "validation",
}
await Bun.write(path.join(destination, "preparation-report.json"), JSON.stringify(report, null, 2) + "\n", {
  mode: 0o600,
})
console.log(JSON.stringify(report, null, 2))
