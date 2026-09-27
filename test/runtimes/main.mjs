import * as flags from "../../dist/flags.js"
// oxlint-disable no-console -- run.mjs reads this output
import * as sdk from "../../dist/index.js"
import { smoke } from "./smoke.mjs"

const runtime = globalThis.Bun ? "bun" : globalThis.Deno ? "deno" : "node"
const host = globalThis.Deno?.args[0] ?? globalThis.process.argv[2]

console.log(await smoke(sdk, flags, host, runtime))
