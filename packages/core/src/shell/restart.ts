export * as ShellRestart from "./restart.js"

// Deliberately not a general shell parser: accept only literal words, optionally
// quoted as a whole. Expansion, redirection and command composition never qualify.
export function allows(command: string) {
  if (/[\r\n]/.test(command)) return false
  if (
    !/^[ \t]*(?:[\w./:=-]+|'[\w./:=-]+'|"[\w./:=-]+")(?:[ \t]+(?:[\w./:=-]+|'[\w./:=-]+'|"[\w./:=-]+"))*[ \t]*$/.test(
      command,
    )
  )
    return false
  const words = command
    .trim()
    .split(/[ \t]+/)
    .map((word) => word.replace(/^['"]|['"]$/g, ""))
  if (words[0] !== "gh") return false
  const args = words.slice(1)
  const repo = (value: string) => /^(?:[\w.-]+\/)?[\w.-]+\/[\w.-]+$/.test(value)
  const flags = new Set<string>()
  if (args[0] === "-R" || args[0] === "--repo") {
    if (!repo(args[1] ?? "")) return false
    args.splice(0, 2)
    flags.add("--repo")
  }
  const run = args[0] === "run" && args[1] === "watch"
  const pr = args[0] === "pr" && args[1] === "checks"
  if (!run && !pr) return false
  const targets: string[] = []
  for (let index = 2; index < args.length; index++) {
    const word = args[index]
    if (!word.startsWith("-")) {
      targets.push(word)
      continue
    }
    const equals = word.indexOf("=")
    const flag = equals < 0 ? word : word.slice(0, equals)
    const inline = equals < 0 ? undefined : word.slice(equals + 1)
    const name = flag === "-R" ? "--repo" : flag === "-i" ? "--interval" : flag
    if (flags.has(name)) return false
    flags.add(name)
    if (name === "--repo" || name === "--interval") {
      const value = inline ?? args[++index]
      if (!value || !(name === "--repo" ? repo(value) : /^[1-9]\d*$/.test(value))) return false
      continue
    }
    if (inline !== undefined) return false
    if (run && (name === "--compact" || name === "--exit-status")) continue
    if (pr && (name === "--watch" || name === "--required" || name === "--fail-fast")) continue
    return false
  }
  return targets.length === 1 && /^[1-9]\d*$/.test(targets[0]) && (run || flags.has("--watch"))
}
