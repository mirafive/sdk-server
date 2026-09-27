// A buffered event must not keep the process alive: this exits long before flushAfterMs.
import { Mira } from "../../dist/index.js"

const host = globalThis.Deno?.args[0] ?? globalThis.process.argv[2]

new Mira({ key: "mf_smoke000_exit", host, flushAfterMs: 60_000 }).track("never flushed")
