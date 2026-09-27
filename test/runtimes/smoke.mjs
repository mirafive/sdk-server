// Runs in every runtime against the stub server in run.mjs, through that runtime's own fetch and crypto.
const seed = "3f9a1c0b7e2d"
const hostile = "</script><!--\u2028"

export const flagDocument = (at) => ({
  v: 1,
  at,
  flags: {
    checkout: { s: seed, t: "b", u: "p", d: "off", r: [{ x: "on" }], w: 1 },
    banner: { s: seed, t: "c", u: "p", d: "v", p: { v: { text: hostile } }, r: [{ x: "v" }], w: 1 },
    pricing: {
      s: seed,
      t: "m",
      u: "p",
      d: "a",
      r: [
        {
          w: [
            ["a", 5000],
            ["b", 5000]
          ]
        }
      ],
      e: "o",
      c: "s",
      w: 1
    },
    beta: { s: seed, t: "b", u: "p", d: "off", r: [{ if: [["s", "3fa9c1e07b"]], x: "on" }] }
  }
})

const assert = (condition, label) => {
  if (!condition) {
    throw new Error(`smoke assertion failed: ${label}`)
  }
}

export async function smoke({ Mira, MiraError }, { MiraFlags, bootstrapHeaders }, host, runtime, waitUntil) {
  const key = `mf_smoke000_${runtime}`
  const handed = []
  const errors = []
  const hand = (promise) => {
    handed.push(promise)
    waitUntil?.(promise)
  }
  const mira = new Mira({ key, host, waitUntil: hand, onError: (error) => errors.push(error) })

  const receipt = await mira.send([{ name: "$install_check" }], { idempotencyKey: "order-981" })

  assert(
    receipt.batch === "274e05f0-4dd7-8db9-a563-87ea5c891487",
    "idempotency key → batch id (crypto.subtle)"
  )
  assert(receipt.dropped === 1 && receipt.reason === "install_check", "install_check receipt")

  const retried = new Mira({ key: `${key}_retry`, host, maxRetries: 2 })

  await retried.send([{ name: "retried", properties: { runtime } }])

  const refused = await new Mira({ key: `${key}_refused`, host, maxRetries: 0 })
    .send([{ name: "x" }])
    .catch((error) => error)

  assert(refused instanceof MiraError && refused.code === "unauthorized" && !refused.retryable, "MiraError")

  const flags = new MiraFlags({ key, host, mira, waitUntil: hand, onError: (error) => errors.push(error) })
  const user = await flags.for({ userId: "user-42" })

  assert(user.enabled("checkout") === true, "fixed flag")
  assert(user.variant("pricing") === "b", "split by FNV-1a (TextEncoder)")
  assert(user.enabled("beta") === true, "segment membership")
  assert(user.config("banner", {}).text === hostile, "config value")

  const html = user.bootstrap()
  const inner = html.slice(html.indexOf(">") + 1, -"</script>".length)

  assert(!/[<>&\u2028\u2029]/.test(inner) && JSON.parse(inner).values.banner[1].text === hostile, "bootstrap")
  assert(!("beta" in JSON.parse(inner).values), "server-only flag left out of the bootstrap")
  assert(bootstrapHeaders["Cache-Control"] === "private, no-store", "bootstrap headers")

  mira.track("smoke", { userId: "user-42", properties: { runtime } })
  mira.identify("user-42", { plan: "pro" })
  await mira.shutdown()
  await Promise.all(handed)
  assert(errors.length === 0, `no errors: ${errors.map((error) => error.message).join(", ")}`)

  const seen = await (await fetch(`${host}/__seen`)).json()
  const mine = seen.filter((request) => request.key.startsWith(key))
  const batches = mine
    .filter((request) => request.path === "/v1/batch")
    .map((request) => JSON.parse(request.body))
  const retries = mine.filter((request) => request.key === `${key}_retry`)

  assert(retries.length === 2 && retries[0].body === retries[1].body, "retry resends the identical body")
  assert(
    batches.some((batch) => batch.events.some((event) => event.name === "$exposure")),
    "exposure delivered"
  )
  assert(
    batches.some((batch) => batch.events.map((event) => event.name).join() === "smoke,$identify"),
    "buffered events delivered on shutdown"
  )
  assert(
    batches.every((batch) => batch.v === 1 && batch.context.sdk === "mirafive-server/1.0.0"),
    "envelope"
  )
  assert(
    mine.some((request) => request.method === "GET" && request.path === "/v1/flags"),
    "flag document fetched"
  )
  assert(
    mine.some((request) => request.path === "/v1/flags/segments"),
    "segments posted"
  )
  assert(
    mine.every((request) => !request.headers.origin && !request.headers["sec-fetch-site"]),
    "no Origin or Sec-Fetch-Site (the server would mark the key exposed)"
  )

  return `${runtime}: ${mine.length} requests, retries identical, flags and exposures ok`
}
