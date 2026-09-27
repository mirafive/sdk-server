import { readFileSync } from "node:fs"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { MiraFlags } from "../src/flags.ts"
import { SDK } from "../src/http.ts"
import { Mira, MiraError } from "../src/index.ts"
import { batchIdFor } from "../src/protocol/batch-id.ts"
import { accept, fakeFetch, hang, json } from "./helpers.ts"

const key = "mf_ab12cd34_secret"
const now = 1_790_153_842_822

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"], now: 1_790_153_842_822 })
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

const client = (
  respond?: Parameters<typeof fakeFetch>[0],
  options: Partial<ConstructorParameters<typeof Mira>[0]> = {}
) => {
  const transport = fakeFetch(respond)
  const errors: MiraError[] = []
  const mira = new Mira({ key, fetch: transport.fetch, onError: (error) => errors.push(error), ...options })

  return { mira, errors, ...transport }
}

describe("buffering", () => {
  it("sends a batch once flushAt events are queued", async () => {
    const { mira, calls, batches } = client(undefined, { flushAt: 3 })

    mira.track("a")
    mira.track("b", { properties: { plan: "pro" } })
    expect(calls).toHaveLength(0)
    mira.track("c")
    await mira.flush()

    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe("https://events.mirafive.io/v1/batch")
    expect(calls[0]?.method).toBe("POST")
    expect(calls[0]?.headers).toMatchObject({
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json"
    })
    expect(batches()[0]).toMatchObject({
      v: 1,
      mode: "full",
      sentAt: 1_790_153_842_822,
      context: { sdk: "mirafive-server/0.5.0" },
      events: [
        { name: "a", time: 1_790_153_842_822 },
        { name: "b", properties: { plan: "pro" } },
        { name: "c" }
      ]
    })
  })

  it("sends what is queued after flushAfterMs", async () => {
    const { mira, calls } = client(undefined, { flushAfterMs: 1000 })

    mira.track("a")
    await vi.advanceTimersByTimeAsync(999)
    expect(calls).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(calls).toHaveLength(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it("does not keep the process alive with its flush timer", () => {
    vi.useRealTimers()

    const timers: { hasRef(): boolean }[] = []
    const real = globalThis.setTimeout

    vi.spyOn(globalThis, "setTimeout").mockImplementation(((handler: () => void, ms: number) => {
      const timer = real(handler, ms)

      timers.push(timer)

      return timer
    }) as typeof setTimeout)

    const { mira } = client()

    mira.track("a")
    expect(timers).toHaveLength(1)
    expect(timers[0]?.hasRef()).toBe(false)
    void mira.shutdown()
  })

  it("splits a buffer into batches under 1 MiB", async () => {
    const { mira, batches, calls } = client(undefined, { flushAt: 1000 })
    const blob = "x".repeat(30_000)

    for (let index = 0; index < 80; index += 1) {
      mira.track("big", { properties: { blob } })
    }

    await mira.flush()

    expect(calls.length).toBeGreaterThan(2)
    expect(calls.every((call) => new TextEncoder().encode(call.raw).length <= 1_048_576)).toBe(true)
    expect(batches().flatMap((batch) => batch.events)).toHaveLength(80)
    expect(new Set(batches().map((batch) => batch.batch)).size).toBe(calls.length)
  })

  it("keeps flushAt within 1–1000", async () => {
    const { mira, calls } = client(undefined, { flushAt: 0 })

    mira.track("a")
    await mira.flush()
    expect(calls).toHaveLength(1)
  })

  it("stamps time from a Date, epoch ms or an ISO string", async () => {
    const { mira, batches } = client()

    mira.track("a", { time: new Date("2026-09-23T08:56:22.821Z") })
    mira.track("b", { time: 1_790_153_782_821.9 })
    mira.track("c", { time: "2026-09-23T08:56:22.821Z" })
    await mira.flush()

    expect(batches()[0]?.events.map((event) => event["time"])).toEqual([
      1_790_153_782_821, 1_790_153_782_821, 1_790_153_782_821
    ])
  })

  it("sends id, page and identifiers only when given", async () => {
    const { mira, calls } = client()
    const id = "01a0cd7b-e085-7aea-8044-494ef4e695b4"
    const sessionId = "b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e"

    mira.track("a", { id, sessionId, userId: "u_1", page: { url: "https://shop.example/" } })
    mira.track("b")
    await mira.flush()

    expect(calls[0]?.raw).toContain(
      `{"name":"a","id":"${id}","time":1790153842822,"page":{"url":"https://shop.example/"},"userId":"u_1","sessionId":"${sessionId}"}`
    )
    expect(calls[0]?.raw).toContain(`{"name":"b","time":1790153842822}`)
  })

  it("identify() queues $identify with traits and the anonymous id", async () => {
    const { mira, batches } = client()

    mira.identify("u_42", { plan: "pro" }, { anonymousId: "5f0c1c8e-3e0e-4a57-9d59-3f7f2a6d1e44" })
    await mira.flush()

    expect(batches()[0]?.events[0]).toEqual({
      name: "$identify",
      time: 1_790_153_842_822,
      userId: "u_42",
      anonymousId: "5f0c1c8e-3e0e-4a57-9d59-3f7f2a6d1e44",
      properties: { plan: "pro" }
    })
  })

  it("with() scopes ids and properties and shares the buffer", async () => {
    const { mira, batches } = client()
    const tenant = mira.with({ properties: { tenant: "acme" } })
    const user = tenant.with({ userId: "u_7", properties: { plan: "pro" } })

    user.track("seat_added", { properties: { seats: 4 } })
    tenant.track("invoice_sent", { userId: "u_8" })
    mira.track("cron")
    await user.flush()

    expect(batches()).toHaveLength(1)
    expect(batches()[0]?.events).toEqual([
      {
        name: "seat_added",
        time: 1_790_153_842_822,
        userId: "u_7",
        properties: { tenant: "acme", plan: "pro", seats: 4 }
      },
      { name: "invoice_sent", time: 1_790_153_842_822, userId: "u_8", properties: { tenant: "acme" } },
      { name: "cron", time: 1_790_153_842_822 }
    ])
  })
})

describe("retries", () => {
  it("retries a 503 with the byte-identical body", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5)
    const { mira, calls } = client((call, index) =>
      index === 0 ? json(503, { code: "sink_unavailable", detail: "later" }) : accept(call)
    )

    const sent = mira.send([{ name: "order", properties: { revenue: 49.9 } }])

    await vi.advanceTimersByTimeAsync(124)
    expect(calls).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)

    await expect(sent).resolves.toMatchObject({ accepted: 1, dropped: 0 })
    expect(calls).toHaveLength(2)
    expect(calls[1]?.raw).toBe(calls[0]?.raw)
  })

  it("backs off with full jitter, doubling up to 4 s", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.9999)
    const { mira, calls } = client(() => json(500, {}), { maxRetries: 6 })
    const sent = mira.send([{ name: "x" }]).catch((error: unknown) => error)
    const waits = [250, 500, 1000, 2000, 4000, 4000]

    for (const [attempt, wait] of waits.entries()) {
      // Timers round down to whole milliseconds, so allow a little drift.
      await vi.advanceTimersByTimeAsync(wait - 10)
      expect(calls).toHaveLength(attempt + 1)
      await vi.advanceTimersByTimeAsync(10)
    }

    expect(calls).toHaveLength(7)
    expect(await sent).toMatchObject({ code: "unexpected", status: 500, retryable: true })
  })

  it.each([
    ["2", 2000],
    ["0", 250],
    ["600", 120_000],
    // HTTP dates have whole seconds.
    [new Date(1_790_153_842_822 + 5000).toUTCString(), 4178]
  ])("honours Retry-After %s, clamped to 250 ms–120 s for send()", async (header, wait) => {
    const { mira, calls } = client((call, index) =>
      index === 0
        ? json(429, { code: "rate_limited", detail: "slow down" }, { "Retry-After": header })
        : accept(call)
    )
    const sent = mira.send([{ name: "x" }])

    await vi.advanceTimersByTimeAsync(wait - 1)
    expect(calls).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    await sent
    expect(calls).toHaveLength(2)
    expect(calls[1]?.raw).toBe(calls[0]?.raw)
  })

  it("retries network errors and timeouts, not 4xx", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0)
    const { mira, calls } = client(
      (call, index) =>
        index === 0 ? new TypeError("fetch failed") : index === 1 ? hang(call) : accept(call),
      { timeoutMs: 50 }
    )
    const sent = mira.send([{ name: "x" }])

    await vi.advanceTimersByTimeAsync(1000)
    await expect(sent).resolves.toMatchObject({ accepted: 1 })
    expect(calls).toHaveLength(3)

    const refused = client(() =>
      json(400, {
        code: "validation_failed",
        detail: "The batch does not match the schema.",
        errors: [{ path: "events.0.name", message: "too long" }]
      })
    )
    const error = await refused.mira.send([{ name: "x" }]).catch((cause: unknown) => cause)

    expect(refused.calls).toHaveLength(1)
    expect(error).toBeInstanceOf(MiraError)
    expect(error).toMatchObject({
      code: "validation_failed",
      status: 400,
      retryable: false,
      errors: [{ path: "events.0.name", message: "too long" }]
    })
  })

  it("reports a timeout as retryable and gives up after maxRetries", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0)
    const { mira, calls, errors } = client(hang, { timeoutMs: 100, maxRetries: 2 })

    mira.track("x")
    const flushed = mira.flush()

    await vi.advanceTimersByTimeAsync(1000)
    await flushed
    expect(calls).toHaveLength(3)
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatchObject({ code: "timeout", retryable: true })
  })

  it("stops on abort", async () => {
    const controller = new AbortController()
    const { mira } = client(hang)
    const sent = mira.send([{ name: "x" }], { signal: controller.signal })

    controller.abort()
    await expect(sent).rejects.toMatchObject({ code: "aborted", retryable: false })
  })
})

describe("send()", () => {
  it("derives the batch id from an idempotency key (PROTOCOL §5)", async () => {
    const { mira, batches } = client()
    const receipt = await mira.send(
      [{ name: "order completed", userId: "u_42", properties: { revenue: 129, currency: "EUR" } }],
      { idempotencyKey: "order-981" }
    )

    expect(batches()[0]?.batch).toBe("274e05f0-4dd7-8db9-a563-87ea5c891487")
    expect(receipt).toEqual({ batch: "274e05f0-4dd7-8db9-a563-87ea5c891487", accepted: 1, dropped: 0 })
  })

  it("returns a dropped receipt as it is", async () => {
    const { mira } = client((call) =>
      json(202, {
        batch: (call.body as { batch: string }).batch,
        accepted: 0,
        dropped: 1,
        reason: "install_check"
      })
    )

    await expect(mira.send([{ name: "$install_check" }])).resolves.toMatchObject({
      dropped: 1,
      reason: "install_check"
    })
  })

  it("refuses an empty or oversized call and an empty key", async () => {
    const { mira, calls } = client()

    await expect(mira.send([])).rejects.toBeInstanceOf(TypeError)
    await expect(mira.send(Array.from({ length: 1001 }, () => ({ name: "x" })))).rejects.toBeInstanceOf(
      TypeError
    )
    await expect(mira.send([{ name: "x" }], { idempotencyKey: "" })).rejects.toBeInstanceOf(TypeError)
    await expect(
      mira.send(Array.from({ length: 40 }, () => ({ name: "x", properties: { blob: "x".repeat(30_000) } })))
    ).rejects.toMatchObject({ code: "payload_too_large" })
    expect(calls).toHaveLength(0)
  })

  it.each([
    [" padded", {}],
    ["", {}],
    ["$made_up", {}],
    ["x", { time: "yesterday" }],
    ["x", { userId: " " }],
    ["x", { sessionId: "not-a-uuid" }],
    ["x", { id: "42" }]
  ])("rejects an invalid event %j %j", async (name, options) => {
    const { mira, calls, errors } = client()

    await expect(mira.send([{ name, ...options }])).rejects.toMatchObject({ code: "invalid_event" })
    mira.track(name, options)
    await mira.flush()
    expect(errors[0]).toMatchObject({ code: "invalid_event" })
    expect(calls).toHaveLength(0)
  })

  it("hands every delivery to waitUntil", async () => {
    const handed: Promise<unknown>[] = []
    const { mira, calls } = client(undefined, { waitUntil: (promise) => handed.push(promise) })

    mira.track("a")
    expect(handed).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1000)
    expect(handed).toHaveLength(2)
    void mira.send([{ name: "b" }])
    expect(handed).toHaveLength(3)
    await Promise.all(handed)
    expect(calls).toHaveLength(2)
  })

  it("a waitUntil promise settles when flush() runs before the timer", async () => {
    const handed: Promise<unknown>[] = []
    const { mira, calls } = client(undefined, { waitUntil: (promise) => handed.push(promise) })

    mira.track("a")
    await mira.flush()
    await Promise.all(handed)
    expect(calls).toHaveLength(1)
  })
})

describe("errors and shutdown", () => {
  it("reports transport failures of buffered events to onError, never throws", async () => {
    const { mira, errors } = client(() => json(401, { code: "unauthorized", detail: "Unknown key." }))

    mira.track("x")
    await expect(mira.flush()).resolves.toBeUndefined()
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatchObject({ code: "unauthorized", status: 401, retryable: false })
    expect(errors[0]?.message).toBe("401 unauthorized: Unknown key.")
  })

  it("reads a bodyless 401 as unauthorized", async () => {
    const { mira } = client(() => json(401))

    await expect(mira.send([{ name: "x" }])).rejects.toMatchObject({ code: "unauthorized", status: 401 })
  })

  it("warns on the console without onError", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const mira = new Mira({
      key,
      fetch: () => Promise.resolve(json(403, { code: "secret_key_exposed", detail: "Rotate it." }))
    })

    mira.track("x")
    await mira.flush()
    expect(warn).toHaveBeenCalledWith("[mirafive] 403 secret_key_exposed: Rotate it.")
  })

  it("reports a missing key without sending", async () => {
    const { mira, calls, errors } = client(undefined, { key: undefined })

    mira.track("x")
    await mira.flush()
    expect(calls).toHaveLength(0)
    expect(errors[0]).toMatchObject({ code: "unauthorized" })
  })

  it("shutdown() flushes, stops the timer and drops later events", async () => {
    const { mira, calls, errors } = client()

    mira.track("a")
    await mira.shutdown()
    expect(calls).toHaveLength(1)
    expect(vi.getTimerCount()).toBe(0)

    mira.track("b")
    await mira.flush()
    expect(calls).toHaveLength(1)
    expect(errors[0]).toMatchObject({ code: "aborted" })
  })
})

describe("configuration", () => {
  it("refuses identifiers in consentless mode", async () => {
    const { mira, batches } = client(undefined, { mode: "consentless" })

    expect(() => mira.track("x", { userId: "u_1" })).toThrow(TypeError)
    expect(() => mira.track("x", { anonymousId: "a" })).toThrow(TypeError)
    expect(() => mira.track("x", { sessionId: "b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e" })).toThrow(TypeError)
    expect(() => mira.identify("u_1")).toThrow(TypeError)
    expect(() => mira.with({ userId: "u_1" })).toThrow(TypeError)
    await expect(mira.send([{ name: "x", userId: "u_1" }])).rejects.toBeInstanceOf(TypeError)

    mira.track("invoice paid", { properties: { revenue: 99, currency: "EUR" } })
    await mira.flush()
    expect(batches()[0]).toMatchObject({ mode: "consentless", events: [{ name: "invoice paid" }] })
  })

  it("needs a host with a scheme and trims its slashes", async () => {
    expect(() => new Mira({ key, host: "events.example.com" })).toThrow(TypeError)

    const { mira, calls } = client(undefined, { host: "http://127.0.0.1:8080//" })

    await mira.send([{ name: "x" }])
    expect(calls[0]?.url).toBe("http://127.0.0.1:8080/v1/batch")
  })

  it("refuses to run in a browser", () => {
    vi.stubGlobal("window", {})
    vi.stubGlobal("document", {})

    try {
      expect(() => new Mira({ key })).toThrow(/secret key must never reach a browser/)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it("narrows event names and properties with an event map", () => {
    type Events = { signup: { plan: "free" | "pro" }; ping: undefined }
    const mira = new Mira<Events>({ key, fetch: fakeFetch().fetch })

    mira.track("signup", { properties: { plan: "pro" } })
    mira.track("ping")
    // @ts-expect-error unknown event
    mira.track("nope")
    // @ts-expect-error wrong property type
    mira.track("signup", { properties: { plan: "enterprise" } })
    expect(new MiraFlags({ key, mira })).toBeInstanceOf(MiraFlags)
    void mira.shutdown()
  })
})

describe("review fixes", () => {
  it("drops an event whose properties cannot be serialised, keeps the rest, never rejects", async () => {
    const { mira, batches, errors } = client()
    const circular: Record<string, unknown[]> = { list: [] }

    circular["list"]?.push(circular)
    mira.track("a")
    mira.track("big", { properties: { amount: 1n } as unknown as Record<string, unknown> })
    mira.track("loop", { properties: circular })
    mira.track("b")
    await expect(mira.flush()).resolves.toBeUndefined()

    expect(batches()[0]?.events.map((event) => event["name"])).toEqual(["a", "b"])
    expect(errors.map((error) => error.code)).toEqual(["invalid_event", "invalid_event"])
    await expect(mira.send([{ name: "x", properties: { amount: 1n } }])).rejects.toMatchObject({
      code: "invalid_event"
    })
  })

  it("never rejects flush() or waitUntil promises, even when onError throws", async () => {
    const handed: Promise<unknown>[] = []
    const { mira } = client(() => json(500, {}), {
      maxRetries: 0,
      waitUntil: (promise) => handed.push(promise),
      onError: () => {
        throw new Error("logger down")
      }
    })

    mira.track("x")
    await expect(mira.flush()).resolves.toBeUndefined()
    await expect(Promise.all(handed)).resolves.toBeDefined()
  })

  it.each([
    ["65 values", Object.fromEntries(Array.from({ length: 65 }, (_, index) => [`k${index}`, index]))],
    ["6 levels", { a: { b: { c: { d: { e: { f: 1 } } } } } }],
    ["a 129-character key", { ["k".repeat(129)]: 1 }],
    ["slashes over 32 KB as the server encodes them", { path: "/".repeat(16_400) }],
    ["non-ASCII over 32 KB as the server encodes them", { text: "ä".repeat(5500) }]
  ])("drops properties with %s", async (_, properties) => {
    const { mira, calls, errors } = client()

    mira.track("x", { properties })
    await mira.flush()
    expect(calls).toHaveLength(0)
    expect(errors[0]).toMatchObject({ code: "invalid_event" })
  })

  it.each([
    ["5 levels", { a: { b: { c: { d: { e: 1 } } } } }],
    ["30,000 ASCII characters", { text: "a".repeat(30_000) }],
    [
      "a list keyed 0…69 as one value",
      { list: Object.fromEntries(Array.from({ length: 70 }, (_, index) => [index, 1])) }
    ]
  ])("keeps properties with %s", async (_, properties) => {
    const { mira, calls, errors } = client()

    mira.track("x", { properties })
    await mira.flush()
    expect(errors).toHaveLength(0)
    expect(calls).toHaveLength(1)
  })

  it("drops an event with an overlong page field", async () => {
    const { mira, errors } = client()

    mira.track("x", { page: { url: `https://shop.example/${"a".repeat(2048)}` } })
    await mira.flush()
    expect(errors[0]).toMatchObject({ code: "invalid_event" })
  })

  it("resends a refused buffered batch without the events the server named", async () => {
    const { mira, calls, errors } = client((call, index) =>
      index === 0
        ? json(400, {
            code: "validation_failed",
            detail: "The batch does not match the schema.",
            errors: [{ path: "events.1.properties", message: "too big" }]
          })
        : accept(call)
    )

    mira.track("a")
    mira.track("b")
    mira.track("c")
    await mira.flush()

    const [first, second] = calls.map((call) => call.body as { batch: string; events: { name: string }[] })

    expect(second?.events.map((event) => event.name)).toEqual(["a", "c"])
    expect(second?.batch).toBe(await batchIdFor(first?.batch ?? ""))
    expect(errors.map((error) => error.code)).toEqual(["validation_failed"])
  })

  it("does not resend when the refusal names no event", async () => {
    const { mira, calls } = client(() =>
      json(400, { code: "validation_failed", detail: "", errors: [{ path: "context.sdk", message: "bad" }] })
    )

    mira.track("a")
    await mira.flush()
    expect(calls).toHaveLength(1)
  })

  it.each([
    ["allowance_exhausted", true],
    ["ingestion_paused", true],
    ["bot", false],
    ["install_check", false]
  ])("reports a buffered batch dropped as %s: %s", async (reason, reported) => {
    const { mira, errors } = client((call) =>
      json(202, { batch: (call.body as { batch: string }).batch, accepted: 0, dropped: 1, reason })
    )

    mira.track("a")
    await mira.flush()
    expect(errors.map((error) => [error.code, error.retryable])).toEqual(reported ? [[reason, false]] : [])
  })

  it("takes sentAt so a resend from another process is byte-identical", async () => {
    const { mira, calls } = client()
    const events = [{ name: "order completed", time: 1_790_000_000_000, properties: { revenue: 5 } }]

    await mira.send(events, { idempotencyKey: "order-1", sentAt: 1_790_000_000_500 })
    vi.setSystemTime(now + 60_000)
    await mira.send(events, { idempotencyKey: "order-1", sentAt: 1_790_000_000_500 })

    expect(calls[0]?.raw).toBe(calls[1]?.raw)
    expect(calls[0]?.body).toMatchObject({ sentAt: 1_790_000_000_500 })
  })

  it("caps Retry-After at 30 s for buffered batches", async () => {
    const { mira, calls } = client((call, index) =>
      index === 0 ? json(429, { code: "rate_limited", detail: "" }, { "Retry-After": "600" }) : accept(call)
    )

    mira.track("a")
    void mira.flush()
    await vi.advanceTimersByTimeAsync(29_999)
    expect(calls).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(calls).toHaveLength(2)
  })

  it("removes its abort listener once a backoff ends", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0)
    const controller = new AbortController()
    const removed = vi.spyOn(controller.signal, "removeEventListener")
    const { mira } = client((call, index) => (index === 0 ? json(503, {}) : accept(call)))
    const sent = mira.send([{ name: "x" }], { signal: controller.signal })

    await vi.advanceTimersByTimeAsync(1)
    await sent
    // Two requests and one backoff each remove theirs.
    expect(removed).toHaveBeenCalledTimes(3)
  })

  it("falls back to the default host for an empty one and refuses plain http beyond this machine", async () => {
    const { mira, calls } = client(undefined, { host: "" })

    await mira.send([{ name: "x" }])
    expect(calls[0]?.url).toBe("https://events.mirafive.io/v1/batch")
    expect(() => new Mira({ key, host: "http://events.example.com" })).toThrow(TypeError)
    expect(() => new Mira({ key, host: "http://localhost.example.com" })).toThrow(TypeError)
    expect(() => new Mira({ key, host: "http://localhost:8080" })).not.toThrow()
    expect(() => new Mira({ key, host: "http://[::1]:3000/" })).not.toThrow()
  })

  it("names itself with the package version", () => {
    const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
      version: string
    }

    expect(SDK).toBe(`mirafive-server/${version}`)
  })
})
