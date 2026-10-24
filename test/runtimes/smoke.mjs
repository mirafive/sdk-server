// Runs in every runtime against the stub server in run.mjs, through that runtime's own fetch and crypto.
const assert = (condition, label) => {
  if (!condition) {
    throw new Error(`smoke assertion failed: ${label}`)
  }
}

export async function smoke({ Mira, MiraError }, host, runtime, waitUntil) {
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
    batches.some((batch) => batch.events.map((event) => event.name).join() === "smoke,$identify"),
    "buffered events delivered on shutdown"
  )
  assert(
    batches.every((batch) => batch.v === 1 && batch.context.sdk === "mirafive-server/1.0.0"),
    "envelope"
  )
  assert(
    mine.every((request) => !request.headers.origin && !request.headers["sec-fetch-site"]),
    "no Origin or Sec-Fetch-Site (the server would mark the key exposed)"
  )

  return `${runtime}: ${mine.length} requests, retries identical, events ok`
}
