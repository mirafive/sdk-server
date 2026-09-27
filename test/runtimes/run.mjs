// oxlint-disable no-console -- this harness is the report
import { spawn, spawnSync } from "node:child_process"
import { createServer } from "node:http"
import { fileURLToPath } from "node:url"

import { flagDocument } from "./smoke.mjs"

const file = (name) => fileURLToPath(new URL(name, import.meta.url))
const root = fileURLToPath(new URL("../../", import.meta.url))
const results = []
const seen = []
const server = await stub()
const host = `http://127.0.0.1:${server.address().port}`

/** @type {Record<string, string[]>} */
const runtimes = {
  node: [],
  bun: ["run"],
  deno: ["run", "--allow-read", "--allow-net=127.0.0.1"]
}

for (const [command, args] of Object.entries(runtimes)) {
  if (spawnSync(command, ["--version"]).error) {
    results.push(`${process.env["CI"] ? "FAIL" : "SKIP"} ${command}: not installed`)
    continue
  }

  const { status, output } = await run(command, [...args, file("main.mjs"), host])

  results.push(status === 0 ? `PASS ${output.trim()}` : `FAIL ${command}:\n${output}`)

  const started = Date.now()
  const exit = await run(command, [...args, file("exit.mjs"), host])
  const took = Date.now() - started

  results.push(
    exit.status === 0 && took < 5000
      ? `PASS ${command}: exits in ${took} ms with a buffered event (timer unref'd)`
      : `FAIL ${command}: exit check (${exit.status}, ${took} ms)\n${exit.output}`
  )
}

await workerd()
server.close()

for (const line of results) {
  console.log(line)
}

process.exit(results.some((line) => line.startsWith("FAIL")) ? 1 : 0)

/** Not spawnSync: the stub server answers from this process's event loop while the child runs. */
function run(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: root, stdio: ["ignore", "pipe", "pipe"] })
    let output = ""

    child.stdout.on("data", (chunk) => (output += chunk))
    child.stderr.on("data", (chunk) => (output += chunk))
    child.on("error", (error) => resolve({ status: -1, output: String(error) }))
    child.on("close", (status) => resolve({ status, output }))
  })
}

async function workerd() {
  let Miniflare

  try {
    ;({ Miniflare } = await import("miniflare"))
  } catch {
    results.push(`${process.env["CI"] ? "FAIL" : "SKIP"} workerd: miniflare is not installed`)

    return
  }

  let miniflare

  try {
    miniflare = new Miniflare({
      modules: true,
      modulesRoot: root,
      scriptPath: file("worker.mjs"),
      modulesRules: [{ type: "ESModule", include: ["**/*.js", "**/*.mjs"] }],
      compatibilityDate: "2026-08-01"
    })

    const response = await miniflare.dispatchFetch(`http://worker.test/?host=${encodeURIComponent(host)}`)
    const text = await response.text()

    results.push(response.ok ? `PASS ${text}` : `FAIL workerd:\n${text}`)

    const answers = []

    for (const user of ["user-42", "user-43"]) {
      const reused = await miniflare.dispatchFetch(
        `http://worker.test/reuse?host=${encodeURIComponent(host)}&user=${user}`
      )

      answers.push(await reused.text())
    }

    const requests = seen.filter((request) => request.key === "mf_smoke000_reuse")
    const documents = requests.filter((request) => request.path === "/v1/flags")
    const exposures = requests
      .filter((request) => request.path === "/v1/batch")
      .flatMap((request) => JSON.parse(request.body).events)
      .filter((event) => event.name === "$exposure")

    results.push(
      answers.join() === "b true,a true" && documents.length === 1 && exposures.length === 2
        ? "PASS workerd: one module-level MiraFlags served two requests (1 document fetch, 2 exposures via per-call waitUntil)"
        : `FAIL workerd reuse: ${answers.join()} / ${documents.length} documents / ${exposures.length} exposures`
    )
  } catch (error) {
    results.push(`FAIL workerd: ${error?.stack ?? error}`)
  } finally {
    await miniflare?.dispose()
  }
}

function answer(response, status, payload, headers = {}) {
  response.writeHead(status, { "Content-Type": "application/json", ...headers })
  response.end(payload === undefined ? undefined : JSON.stringify(payload))
}

/** Stands in for events.mirafive.io and records every request, so the smoke can check what went out. */
function stub() {
  const answered = new Set()
  const listener = createServer((request, response) => {
    let body = ""

    request.on("data", (chunk) => (body += chunk))
    request.on("end", () => {
      const path = new URL(request.url ?? "/", "http://stub").pathname
      const key = (request.headers.authorization ?? "").replace("Bearer ", "")
      if (path === "/__seen") {
        answer(response, 200, seen)

        return
      }

      seen.push({ method: request.method, path, key, headers: request.headers, body })

      if (key.endsWith("_refused")) {
        answer(response, 401, { code: "unauthorized", detail: "Unknown key." })
      } else if (path === "/v1/batch") {
        const batch = JSON.parse(body)
        const check = batch.events.every((event) => event.name === "$install_check")

        if (key.endsWith("_retry") && !answered.has(key)) {
          answered.add(key)
          answer(response, 503, { code: "sink_unavailable", detail: "later" })
        } else {
          answer(response, 202, {
            batch: batch.batch,
            accepted: check ? 0 : batch.events.length,
            dropped: check ? batch.events.length : 0,
            ...(check && { reason: "install_check" })
          })
        }
      } else if (path === "/v1/flags") {
        if (request.headers["if-none-match"] === 'W/"f-smoke"') {
          answer(response, 304)
        } else {
          answer(response, 200, flagDocument(Date.now()), {
            ETag: 'W/"f-smoke"',
            "Cache-Control": "private, no-cache"
          })
        }
      } else if (path === "/v1/flags/segments") {
        answer(response, 200, {
          units: JSON.parse(body).units.map(() => ({
            segments: ["3fa9c1e07b"],
            unavailable: [],
            refreshedAt: Date.now(),
            stale: false
          }))
        })
      } else {
        answer(response, 404, { code: "not_found", detail: path })
      }
    })
  })

  return new Promise((resolve) => {
    listener.listen(0, "127.0.0.1", () => resolve(listener))
  })
}
