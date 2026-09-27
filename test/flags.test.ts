import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { bootstrapHeaders, MiraFlags, type MiraFlagsOptions } from "../src/flags.ts"
import type { MiraError } from "../src/index.ts"
import { Mira } from "../src/mira.ts"
import type { Flag, FlagDocument } from "../src/protocol/types.ts"
import { type Call, fakeFetch, hang, json } from "./helpers.ts"

const now = 1_790_153_842_822
const seed = "3f9a1c0b7e2d"
const split = [
  {
    w: [
      ["a", 5000],
      ["b", 5000]
    ] as [string, number][]
  }
]
// With this seed user-42 buckets at .v 7627 (variant b), the anonymous id below at 2503 (variant a).
const anonymousId = "0199a3f2-7c1e-7a4b-9f00-1b2c3d4e5f60"
const hostile = "</script><!--\u2028"

const flags: Record<string, Flag> = {
  checkout: { s: seed, t: "b", u: "p", d: "off", r: [{ x: "on" }], w: 1 },
  limits: {
    s: seed,
    t: "c",
    u: "p",
    d: "free",
    p: { free: { max: 1 }, pro: { max: 3, note: hostile } },
    r: [{ if: [["p", "plan", "is", ["pro"]]], x: "pro" }],
    w: 1
  },
  pricing: {
    s: seed,
    t: "m",
    u: "p",
    d: "a",
    p: { a: "Original", b: "Stop paying" },
    r: split,
    e: "o",
    c: "s",
    w: 1
  },
  hero: { s: seed, t: "m", u: "p", d: "a", r: split, e: "r", c: "b", w: 1 },
  layout: { s: seed, t: "m", u: "b", d: "a", r: split, w: 1 },
  beta: { s: seed, t: "b", u: "p", d: "off", r: [{ if: [["s", "3fa9c1e07b"]], x: "on" }] }
}

const documentAt = (at: number, extra: Record<string, Flag> = {}): FlagDocument => ({
  v: 1,
  at,
  flags: { ...flags, ...extra }
})

type Route = (call: Call) => Response | Error | Promise<Response | Error>

const server = (routes: { document?: Route; segments?: Route } = {}) =>
  fakeFetch((call) =>
    call.url.endsWith("/v1/flags/segments")
      ? (routes.segments ?? member)(call)
      : (routes.document ?? (() => json(200, documentAt(Date.now()), { ETag: 'W/"f-1"' })))(call)
  )

function member(call: Call): Response {
  const { units } = call.body as { units: unknown[] }

  return json(200, {
    units: units.map(() => ({ segments: ["3fa9c1e07b"], unavailable: [], refreshedAt: now, stale: false }))
  })
}

const setup = (routes: Parameters<typeof server>[0] = {}, options: Partial<MiraFlagsOptions> = {}) => {
  const transport = server(routes)
  const errors: MiraError[] = []
  const track = vi.fn()
  const miraFlags = new MiraFlags({
    key: "mf_ab12cd34_secret",
    fetch: transport.fetch,
    onError: (error) => errors.push(error),
    mira: { track } as unknown as Mira,
    ...options
  })
  const documents = () => transport.calls.filter((call) => call.url.endsWith("/v1/flags"))
  const lookups = () => transport.calls.filter((call) => call.url.endsWith("/segments"))

  return { flags: miraFlags, errors, track, documents, lookups, ...transport }
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"], now })
  vi.spyOn(Math, "random").mockReturnValue(0.5)
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe("reading", () => {
  it("waits for the first document, then reads variants, values and fallbacks", async () => {
    const { flags: miraFlags, calls } = setup()
    const user = await miraFlags.for({ userId: "user-42", properties: { plan: "pro" } })

    expect(calls[0]?.url).toBe("https://events.mirafive.io/v1/flags")
    expect(calls[0]?.headers).toEqual({ Authorization: "Bearer mf_ab12cd34_secret" })
    expect(user.enabled("checkout")).toBe(true)
    expect(user.variant("pricing")).toBe("b")
    expect(user.config("limits", { max: 0 })).toEqual({ max: 3, note: hostile })
    expect(user.config("checkout", "none")).toBe("none")
    expect(user.variant("nope")).toBeUndefined()
    expect(user.variant("nope", "x")).toBe("x")
    expect(user.enabled("nope")).toBe(false)
    expect(user.enabled("nope", true)).toBe(true)
    expect(user.evaluate("limits")).toEqual({ variant: "pro", reason: "TARGETING_MATCH", rule: 0 })
    expect(user.evaluate("nope")).toEqual({ reason: "ERROR", errorCode: "FLAG_NOT_FOUND" })
    expect(miraFlags.status()).toEqual({ ready: true, stale: false, stopped: false, fetchedAt: now })
  })

  it("uses the anonymous id before any `.` and only with experiments consent", async () => {
    const { flags: miraFlags } = setup()

    expect((await miraFlags.for({ anonymousId: `${anonymousId}.1790153842822` })).evaluate("layout")).toEqual(
      {
        variant: "a",
        reason: "SPLIT",
        rule: 0
      }
    )
    expect(
      (await miraFlags.for({ anonymousId, consent: { experiments: false } })).evaluate("layout")
    ).toMatchObject({ reason: "DEFAULT", rule: 0 })
  })

  it("answers NOT_READY when no document arrives within 1.5 s", async () => {
    const { flags: miraFlags } = setup({ document: hang })
    const reading = miraFlags.for({ userId: "user-42" })

    await vi.advanceTimersByTimeAsync(1500)

    const user = await reading

    expect(user.evaluate("checkout")).toEqual({ reason: "ERROR", errorCode: "NOT_READY" })
    expect(user.enabled("checkout")).toBe(false)
    expect(miraFlags.status().ready).toBe(false)
  })

  it("serves a snapshot at once while it is younger than 7 days", async () => {
    const fresh = setup({ document: hang }, { document: documentAt(now - 6 * 86_400_000) })
    const user = await fresh.flags.for({ userId: "user-42" })

    expect(user.enabled("checkout")).toBe(true)
    expect(fresh.flags.status()).toMatchObject({ ready: true, stale: true })

    const old = setup(
      { document: () => new TypeError("offline") },
      { document: documentAt(now - 8 * 86_400_000) }
    )

    expect(await old.flags.ready()).toBe(false)
    expect(old.flags.snapshot()).toBeUndefined()
  })
})

describe("refreshing", () => {
  it("refreshes on read after refreshSeconds, with If-None-Match", async () => {
    const { flags: miraFlags, documents } = setup({
      document: (call) =>
        call.headers["If-None-Match"] === 'W/"f-1"'
          ? json(304)
          : json(200, documentAt(Date.now()), { ETag: 'W/"f-1"' })
    })

    await miraFlags.for()
    await vi.advanceTimersByTimeAsync(29_999)
    await miraFlags.for()
    expect(documents()).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(1)
    await miraFlags.for()
    // With a document in hand a read does not wait for the refresh.
    await vi.advanceTimersByTimeAsync(0)
    expect(documents()).toHaveLength(2)
    expect(documents()[1]?.headers["If-None-Match"]).toBe('W/"f-1"')
    expect(miraFlags.status()).toMatchObject({ ready: true, fetchedAt: now + 30_000 })
    expect((await miraFlags.for({ userId: "user-42" })).enabled("checkout")).toBe(true)
  })

  it.each([
    [0, 30, 27_000],
    [0.9999, 30, 33_000],
    [0.5, 5, 10_000]
  ])("jitters the interval by ±10 %% (random %s, %s s)", async (random, refreshSeconds, due) => {
    vi.mocked(Math.random).mockReturnValue(random)
    const { flags: miraFlags, documents } = setup({}, { refreshSeconds })

    await miraFlags.for()
    await vi.advanceTimersByTimeAsync(due - 1)
    await miraFlags.for()
    expect(documents()).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    await miraFlags.for()
    expect(documents()).toHaveLength(2)
  })

  it("backs off after failures up to 5 minutes and keeps the last document", async () => {
    let failing = false
    const {
      flags: miraFlags,
      documents,
      errors
    } = setup({
      document: () =>
        failing ? json(503, { code: "sink_unavailable", detail: "later" }) : json(200, documentAt(now))
    })

    await miraFlags.for()
    failing = true

    const gaps = [30_000, 60_000, 120_000, 240_000, 300_000, 300_000]

    for (const [index, gap] of gaps.entries()) {
      await vi.advanceTimersByTimeAsync(gap - 1)
      await miraFlags.for()
      expect(documents()).toHaveLength(index + 1)
      await vi.advanceTimersByTimeAsync(1)
      await miraFlags.for()
      expect(documents()).toHaveLength(index + 2)
    }

    await vi.advanceTimersByTimeAsync(0)
    expect(errors).toHaveLength(6)
    expect(miraFlags.status()).toMatchObject({ ready: true, stale: true, stopped: false })
    expect((await miraFlags.for({ userId: "user-42" })).enabled("checkout")).toBe(true)
  })

  it("waits at least Retry-After", async () => {
    let index = 0
    const { flags: miraFlags, documents } = setup({
      document: () =>
        index++ === 0
          ? json(429, { code: "rate_limited", detail: "" }, { "Retry-After": "600" })
          : json(200, documentAt(now))
    })

    await miraFlags.ready()
    await vi.advanceTimersByTimeAsync(599_999)
    await miraFlags.for()
    expect(documents()).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    await miraFlags.for()
    expect(documents()).toHaveLength(2)
  })

  it.each([401, 403])("stops refreshing after a %s", async (status) => {
    let index = 0
    const {
      flags: miraFlags,
      documents,
      errors
    } = setup({
      document: () =>
        index++ === 0
          ? json(200, documentAt(now))
          : json(status, { code: "unauthorized", detail: "Unknown key." })
    })

    await miraFlags.for()
    await vi.advanceTimersByTimeAsync(30_000)
    await miraFlags.for()
    await vi.advanceTimersByTimeAsync(3_600_000)
    await miraFlags.for()

    expect(documents()).toHaveLength(2)
    expect(errors).toHaveLength(1)
    expect(miraFlags.status()).toMatchObject({ ready: true, stopped: true })
  })

  it("keeps the last document when a new one is unreadable", async () => {
    let version = 1
    const { flags: miraFlags, errors } = setup({
      document: () => json(200, { ...documentAt(now), v: version++ })
    })

    await miraFlags.for()
    await vi.advanceTimersByTimeAsync(30_000)

    const user = await miraFlags.for({ userId: "user-42" })

    expect(user.enabled("checkout")).toBe(true)
    expect(errors[0]).toMatchObject({ code: "unexpected" })
  })

  it("hands refreshes to waitUntil", async () => {
    const handed: Promise<unknown>[] = []
    const { flags: miraFlags } = setup({}, { waitUntil: (promise) => handed.push(promise) })

    await miraFlags.for()
    expect(handed).toHaveLength(1)
  })
})

describe("segments", () => {
  it("batches one tick's lookups and caches them for a minute", async () => {
    const { flags: miraFlags, lookups } = setup()
    const [first, second] = await Promise.all([
      miraFlags.for({ userId: "u_1" }),
      miraFlags.for({ userId: "u_2", anonymousId })
    ])

    expect(lookups()).toHaveLength(1)
    expect(lookups()[0]?.body).toEqual({ units: [{ userId: "u_1" }, { userId: "u_2", anonymousId }] })
    expect(lookups()[0]?.headers).toMatchObject({ "Content-Type": "application/json" })
    expect(first?.enabled("beta")).toBe(true)
    expect(second?.evaluate("beta")).toEqual({ variant: "on", reason: "TARGETING_MATCH", rule: 0 })

    await vi.advanceTimersByTimeAsync(59_999)
    await miraFlags.for({ userId: "u_1" })
    expect(lookups()).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(1)
    await miraFlags.for({ userId: "u_1" })
    expect(lookups()).toHaveLength(2)
  })

  it("sends at most 100 units per request", async () => {
    const { flags: miraFlags, lookups } = setup()

    await miraFlags.ready()
    await Promise.all(Array.from({ length: 150 }, (_, index) => miraFlags.for({ userId: `u_${index}` })))

    expect(lookups().map((call) => (call.body as { units: unknown[] }).units.length)).toEqual([100, 50])
  })

  it("answers the default with MEMBERSHIP_UNAVAILABLE after 300 ms", async () => {
    const { flags: miraFlags, errors } = setup({ segments: hang })

    await miraFlags.ready()

    const reading = miraFlags.for({ userId: "u_1" })

    await vi.advanceTimersByTimeAsync(300)

    const user = await reading

    expect(user.enabled("beta")).toBe(false)
    expect(user.evaluate("beta")).toEqual({
      variant: "off",
      reason: "DEFAULT",
      errorCode: "MEMBERSHIP_UNAVAILABLE"
    })
    expect(errors[0]).toMatchObject({ code: "timeout" })
  })

  it("does not look up without targeting consent or an id", async () => {
    const { flags: miraFlags, lookups } = setup()

    expect(
      (await miraFlags.for({ userId: "u_1", consent: { targeting: false } })).evaluate("beta")
    ).toMatchObject({ variant: "off", errorCode: "NOT_ALLOWED" })
    expect((await miraFlags.for({ userId: "guest" })).evaluate("beta")).toMatchObject({
      variant: "off",
      errorCode: "MEMBERSHIP_UNAVAILABLE"
    })
    expect(lookups()).toHaveLength(0)
  })
})

describe("exposures", () => {
  it("counts a server-counted split once per unit and variant an hour", async () => {
    const { flags: miraFlags, track } = setup()
    const user = await miraFlags.for({ userId: "user-42", anonymousId })

    expect(user.evaluate("pricing")).toMatchObject({ variant: "b", reason: "SPLIT" })
    expect(track).not.toHaveBeenCalled()

    user.variant("pricing")
    user.config("pricing", "")
    ;(await miraFlags.for({ userId: "user-42" })).enabled("pricing")
    expect(track).toHaveBeenCalledTimes(1)
    expect(track).toHaveBeenCalledWith("$exposure", {
      userId: "user-42",
      anonymousId,
      properties: { $experiment: "pricing", $variant: "b" }
    })

    await vi.advanceTimersByTimeAsync(3_600_000)
    ;(await miraFlags.for({ userId: "user-42" })).variant("pricing")
    expect(track).toHaveBeenCalledTimes(2)
  })

  it("answers the default for experiments counted in the browser or without consent", async () => {
    const { flags: miraFlags, track } = setup()
    const user = await miraFlags.for({ userId: "user-42" })

    expect(user.variant("hero")).toBe("a")
    expect(user.evaluate("hero")).toEqual({ variant: "a", reason: "DEFAULT", errorCode: "NOT_ALLOWED" })

    const declined = await miraFlags.for({ userId: "user-42", consent: { experiments: false } })

    expect(declined.variant("pricing")).toBe("a")
    expect(declined.evaluate("pricing")).toMatchObject({ errorCode: "NOT_ALLOWED" })
    expect(track).not.toHaveBeenCalled()
  })

  it("survives a consentless client", async () => {
    const { flags: miraFlags } = setup(
      {},
      {
        mira: {
          track: () => {
            throw new TypeError("consentless")
          }
        } as unknown as Mira
      }
    )

    expect((await miraFlags.for({ userId: "user-42" })).variant("pricing")).toBe("b")
  })
})

describe("bootstrap", () => {
  it("hands website flags to the page, escaped", async () => {
    const { flags: miraFlags, track } = setup()
    const html = (await miraFlags.for({ userId: "user-42", properties: { plan: "pro" } })).bootstrap()
    const inner = html.slice(
      '<script type="application/json" id="mirafive-flags">'.length,
      -"</script>".length
    )

    expect(html.startsWith('<script type="application/json" id="mirafive-flags">')).toBe(true)
    expect(inner).not.toMatch(/[<>&\u2028\u2029]/)
    expect(inner).toContain("\\u003c/script\\u003e\\u003c!--\\u2028")
    expect(JSON.parse(inner)).toEqual({
      v: 1,
      at: now,
      values: {
        checkout: ["on"],
        limits: ["pro", { max: 3, note: hostile }],
        pricing: ["b", "Stop paying"],
        hero: ["b", null, 1]
      },
      browser: ["layout"],
      unit: "39875499"
    })
    expect(track).toHaveBeenCalledTimes(1)
    expect(bootstrapHeaders).toEqual({ "Cache-Control": "private, no-store" })
  })

  it("is empty but valid before a document arrives", async () => {
    const { flags: miraFlags } = setup({ document: () => new TypeError("offline") })

    expect((await miraFlags.for()).bootstrap()).toBe(
      '<script type="application/json" id="mirafive-flags">{"v":1,"at":0,"values":{}}</script>'
    )
  })
})

describe("robustness", () => {
  it("answers the fallback for a flag that breaks the format, and reports it once", async () => {
    const broken = { s: seed, t: "b", u: "p", d: "off", r: "nope" } as unknown as Flag
    const { flags: miraFlags, errors } = setup({ document: () => json(200, documentAt(now, { broken })) })
    const user = await miraFlags.for({ userId: "user-42" })

    expect(user.enabled("broken", true)).toBe(true)
    expect(user.variant("broken", "x")).toBe("x")
    expect(user.evaluate("broken")).toEqual({ reason: "ERROR", errorCode: "UNSUPPORTED" })
    expect(user.enabled("checkout")).toBe(true)
    expect(() => user.bootstrap()).not.toThrow()
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatchObject({ code: "unexpected" })
  })

  it("reports a missing key without a request and stops", async () => {
    const { flags: miraFlags, calls, errors } = setup({}, { key: undefined })

    expect(await miraFlags.ready()).toBe(false)
    expect(calls).toHaveLength(0)
    expect(errors[0]).toMatchObject({ code: "unauthorized" })
    expect(miraFlags.status().stopped).toBe(true)
  })

  it("reads a bodyless 401 as unauthorized", async () => {
    const { flags: miraFlags, errors } = setup({ document: () => json(401) })

    await miraFlags.ready()
    expect(errors[0]).toMatchObject({ code: "unauthorized", status: 401 })
    expect(miraFlags.status().stopped).toBe(true)
  })
})

describe("opt-out", () => {
  it("uses no ids, looks nothing up and counts no one, but serves fixed values and property rules", async () => {
    const { flags: miraFlags, lookups, track } = setup()
    const user = await miraFlags.for({
      userId: "user-42",
      anonymousId,
      properties: { plan: "pro" },
      optedOut: true
    })

    expect(user.enabled("checkout")).toBe(true)
    expect(user.config("limits", { max: 0 })).toEqual({ max: 3, note: hostile })
    expect(user.variant("pricing")).toBe("a")
    expect(user.evaluate("pricing")).toMatchObject({ reason: "DEFAULT", errorCode: "NOT_ALLOWED" })
    expect(user.evaluate("beta")).toMatchObject({ variant: "off", errorCode: "NOT_ALLOWED" })
    expect(JSON.parse(user.bootstrap().slice(52, -9))).not.toHaveProperty("unit")
    expect(lookups()).toHaveLength(0)
    expect(track).not.toHaveBeenCalled()
  })
})

describe("per-call waitUntil", () => {
  it("hands this request's refresh and exposure to its own waitUntil", async () => {
    const events = fakeFetch()
    const mira = new Mira({ key: "mf_ab12cd34_secret", fetch: events.fetch })
    const { flags: miraFlags } = setup({}, { mira })
    const first: Promise<unknown>[] = []
    const second: Promise<unknown>[] = []

    await miraFlags.for({ userId: "user-42" }, { waitUntil: (promise) => first.push(promise) })
    expect(first).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(30_000)

    const user = await miraFlags.for({ userId: "user-42" }, { waitUntil: (promise) => second.push(promise) })

    user.variant("pricing")
    expect(second).toHaveLength(2)
    await Promise.all(second)
    expect(events.batches()[0]?.events[0]).toMatchObject({
      name: "$exposure",
      properties: { $experiment: "pricing", $variant: "b" }
    })
  })
})

describe("review fixes", () => {
  it("reports once that a consentless Mira counts no exposures", async () => {
    const mira = new Mira({ key: "mf_ab12cd34_secret", mode: "consentless", fetch: fakeFetch().fetch })
    const { flags: miraFlags, errors } = setup({}, { mira })

    ;(await miraFlags.for({ userId: "user-42" })).variant("pricing")
    ;(await miraFlags.for({ userId: "user-7" })).variant("pricing")
    ;(await miraFlags.for({ userId: "user-8" })).variant("pricing")

    expect(errors.map((error) => error.code)).toEqual(["collection_mode_not_allowed"])
  })

  it("retries a failed first fetch after 1, 2, 4 s, up to the refresh interval", async () => {
    const { flags: miraFlags, documents } = setup({ document: () => new TypeError("offline") })

    await miraFlags.ready()

    for (const [index, gap] of [1000, 2000, 4000, 8000, 16_000, 30_000, 30_000].entries()) {
      await vi.advanceTimersByTimeAsync(gap - 1)
      await miraFlags.ready()
      expect(documents()).toHaveLength(index + 1)
      await vi.advanceTimersByTimeAsync(1)
      await miraFlags.ready()
      expect(documents()).toHaveLength(index + 2)
    }
  })

  it("reads only own keys of the document", async () => {
    const odd: Flag = { s: seed, t: "m", u: "p", d: "constructor", r: [] }
    const { flags: miraFlags } = setup({ document: () => json(200, documentAt(now, { odd })) })
    const user = await miraFlags.for({ userId: "user-42" })

    expect(user.evaluate("constructor")).toEqual({ reason: "ERROR", errorCode: "FLAG_NOT_FOUND" })
    expect(user.evaluate("toString")).toEqual({ reason: "ERROR", errorCode: "FLAG_NOT_FOUND" })
    expect(user.variant("odd")).toBe("constructor")
    expect(user.config("odd", "fallback")).toBe("fallback")
  })

  it("shares one lookup between concurrent reads of the same unit", async () => {
    const { flags: miraFlags, lookups } = setup()

    await miraFlags.ready()
    await Promise.all([miraFlags.for({ userId: "u_1" }), miraFlags.for({ userId: "u_1" })])
    // The second read of a tick joins the first's pending lookup.
    await Promise.all([
      miraFlags.for({ userId: "u_2" }),
      Promise.resolve().then(() => miraFlags.for({ userId: "u_2" }))
    ])

    expect(lookups().map((call) => call.body)).toEqual([
      { units: [{ userId: "u_1" }] },
      { units: [{ userId: "u_2" }] }
    ])
  })

  it("uses the default host for an empty one", async () => {
    const { flags: miraFlags, calls } = setup({}, { host: "" })

    await miraFlags.ready()
    expect(calls[0]?.url).toBe("https://events.mirafive.io/v1/flags")
  })
})
