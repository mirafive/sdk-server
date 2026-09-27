/**
 * Copies modules of mirafive/protocol into this repo, following their relative imports.
 *
 *   bun scripts/vendor-protocol.ts [module …] [--from ../protocol] [--to src/protocol]
 *
 * Without modules it takes package.json#mirafive.protocol. MIRAFIVE_PROTOCOL may name the checkout.
 */
import { execFileSync } from "node:child_process"
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"

const marker = "// Vendored from mirafive/protocol"
const args = process.argv.slice(2)

const option = (name: string): string | undefined => {
  const at = args.indexOf(`--${name}`)

  return at < 0 ? undefined : args.splice(at, 2)[1]
}

const from = resolve(option("from") ?? process.env["MIRAFIVE_PROTOCOL"] ?? "../protocol")
const to = resolve(option("to") ?? "src/protocol")
const listed: string[] =
  args.length > 0
    ? args
    : ((JSON.parse(readFileSync("package.json", "utf8")) as { mirafive?: { protocol?: string[] } }).mirafive
        ?.protocol ?? [])

if (listed.length === 0) {
  console.error("Name the modules to vendor, or list them in package.json#mirafive.protocol.")
  process.exit(1)
}

const git = (...command: string[]): string =>
  execFileSync("git", ["-C", from, ...command], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"]
  }).trim()

// A checkout with uncommitted changes in src/ is not the commit it names.
const version = (): string => {
  try {
    return git("status", "--porcelain", "--", "src") === "" ? git("rev-parse", "--short=12", "HEAD") : "local"
  } catch {
    return "local"
  }
}

const files = new Map<string, string>()

const add = (module: string): void => {
  const file = module.endsWith(".ts") ? module : `${module}.ts`

  if (files.has(file)) {
    return
  }

  const source = readFileSync(join(from, "src", file), "utf8")

  files.set(file, source)

  for (const [, imported] of source.matchAll(/from "\.\/([^"]+)"/g)) {
    add(imported ?? "")
  }
}

for (const module of listed) {
  add(module)
}

const sha = version()

mkdirSync(to, { recursive: true })

for (const name of readdirSync(to)) {
  if (name.endsWith(".ts") && readFileSync(join(to, name), "utf8").startsWith(marker)) {
    rmSync(join(to, name))
  }
}

for (const [file, source] of files) {
  writeFileSync(join(to, file), `${marker} ${sha}. Do not edit; run bun run vendor:protocol.\n${source}`)
}

console.log(`Vendored ${[...files.keys()].join(", ")} from mirafive/protocol ${sha} into ${to}`)
