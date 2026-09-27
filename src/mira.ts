import { MiraError } from "./error.ts"
import { call, type Fetch, SDK, trimHost } from "./http.ts"
import { batchIdFor } from "./protocol/batch-id.ts"
import { DEFAULT_HOST, MAX_BODY_BYTES, MAX_EVENTS, RESERVED_NAMES } from "./protocol/limits.ts"
import type { Mode, Page, Receipt } from "./protocol/types.ts"

/** Maps event names to their properties; narrows `track()` and `send()`. Types only. */
export type Events = Record<string, Record<string, unknown> | undefined>

export interface EventOptions<P = Record<string, unknown> | undefined> {
  /** Your own pseudonymous id for the person. Never an email address. */
  readonly userId?: string | undefined
  /** The anonymous id the browser SDK minted, when the server knows it. */
  readonly anonymousId?: string | undefined
  /** A session UUID forwarded from the browser. */
  readonly sessionId?: string | undefined
  readonly properties?: P
  /** When it happened. Defaults to the call. */
  readonly time?: Date | number | string | undefined
  readonly page?: Page | undefined
  /** A UUID naming the event; without one the server derives a stable id. */
  readonly id?: string | undefined
}

export type SendEvent<E extends Events = Events> = {
  [K in keyof E & string]: EventOptions<E[K]> & { readonly name: K }
}[keyof E & string]

export interface Scope {
  readonly userId?: string | undefined
  readonly anonymousId?: string | undefined
  readonly properties?: Record<string, unknown> | undefined
}

export interface SendOptions {
  /** Names the batch: the same key is stored once (PROTOCOL §5). */
  readonly idempotencyKey?: string | undefined
  readonly signal?: AbortSignal | undefined
  /** Epoch ms for the batch's `sentAt`; with an idempotency key and fixed event times a resend is byte-identical, even from another process. */
  readonly sentAt?: number | undefined
}

export interface MiraOptions {
  /** The source's secret key, `process.env.MIRAFIVE_SECRET_KEY`. Server-only. */
  readonly key: string | undefined
  readonly host?: string | undefined
  /** `"full"` (default): the customer holds consent. `"consentless"`: no identifiers at all. */
  readonly mode?: Mode | undefined
  readonly flushAt?: number | undefined
  readonly flushAfterMs?: number | undefined
  readonly timeoutMs?: number | undefined
  readonly maxRetries?: number | undefined
  readonly fetch?: Fetch | undefined
  /** Receives every in-flight delivery, e.g. `ctx.waitUntil` on Workers or `waitUntil` from `@vercel/functions`. */
  readonly waitUntil?: ((promise: Promise<unknown>) => void) | undefined
  /** Transport errors of buffered events. Defaults to `console.warn`. */
  readonly onError?: ((error: MiraError) => void) | undefined
}

const encoder = new TextEncoder()
const bytes = (text: string): number => encoder.encode(text).length
const chars = (text: string): number => Array.from(text).length
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const noop = (): void => {}

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    const abort = (): void => {
      clearTimeout(timer)
      reject(new MiraError("aborted", "aborted while waiting to retry"))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort)
      resolve()
    }, ms)

    signal?.addEventListener("abort", abort, { once: true })
  })

// A buffered flush must not keep a Node or Deno process alive; `flush()` and `shutdown()` are awaited instead.
const unref = (timer: { unref?: () => void } | number): void => {
  if (typeof timer === "number") {
    Reflect.get(globalThis, "Deno")?.unrefTimer?.(timer)
  } else {
    timer.unref?.()
  }
}

// The server's EventProperties rule: objects nest at most 5 levels, lists and scalars are leaves.
const walk = (
  value: Record<string, unknown>,
  depth: number,
  leaves: { count: number }
): string | undefined => {
  for (const [key, item] of Object.entries(value)) {
    if (chars(key) > 128) {
      return "property keys have at most 128 characters"
    }

    if (item === undefined || typeof item === "function") {
      continue
    }

    const nested = typeof item === "object" && item !== null && !Array.isArray(item) ? item : undefined
    const keys = nested ? Object.keys(nested) : []

    // An object keyed 0, 1, … decodes to a list on the server.
    if (nested && keys[0] && !keys.every((name, index) => name === String(index))) {
      if (depth === 5) {
        return "properties nest at most 5 levels"
      }

      const problem = walk({ ...nested }, depth + 1, leaves)

      if (problem) {
        return problem
      }
    } else if (++leaves.count > 64) {
      return "at most 64 property values"
    }
  }

  return undefined
}

// The envelope around the events stays well under this.
const split = (events: readonly string[]): string[][] => {
  const parts: string[][] = []
  let part: string[] = []
  let size = 0

  for (const event of events) {
    const length = bytes(event) + 1

    if (part.length === MAX_EVENTS || (part.length > 0 && size + length > MAX_BODY_BYTES - 1024)) {
      parts.push(part)
      part = []
      size = 0
    }

    part.push(event)
    size += length
  }

  return part.length > 0 ? [...parts, part] : parts
}

/** The buffer and transport one client and all its `with()` views share. */
class Core {
  readonly #key: string | undefined
  readonly #host: string
  readonly mode: Mode
  readonly #flushAt: number
  readonly #flushAfterMs: number
  readonly #timeoutMs: number
  readonly #maxRetries: number
  readonly #fetch: Fetch | undefined
  readonly #waitUntil: ((promise: Promise<unknown>) => void) | undefined
  readonly #onError: (error: MiraError) => void
  readonly #inflight = new Set<Promise<unknown>>()
  #queue: string[] = []
  #timer: ReturnType<typeof setTimeout> | undefined
  #armed: (() => void) | undefined
  closed = false

  constructor(options: MiraOptions) {
    this.#key = options.key?.trim()
    this.#host = trimHost(options.host || DEFAULT_HOST)
    this.mode = options.mode ?? "full"
    this.#flushAt = Math.min(Math.max(options.flushAt ?? 100, 1), MAX_EVENTS)
    this.#flushAfterMs = options.flushAfterMs ?? 1000
    this.#timeoutMs = options.timeoutMs ?? 10_000
    this.#maxRetries = options.maxRetries ?? 3
    this.#fetch = options.fetch
    this.#waitUntil = options.waitUntil
    this.#onError =
      options.onError ??
      ((error) => {
        // oxlint-disable-next-line no-console -- a server SDK has no other channel
        console.warn(`[mirafive] ${error.message}`)
      })
  }

  push(event: string): void {
    if (this.#queue.push(event) >= this.#flushAt) {
      void this.flush()
    } else if (this.#timer === undefined) {
      this.#timer = setTimeout(() => void this.flush(), this.#flushAfterMs)
      unref(this.#timer)
      this.#waitUntil?.(
        new Promise<void>((resolve) => {
          this.#armed = resolve
        })
      )
    }
  }

  // Never rejects: it runs from timers and waitUntil, where a rejection would crash the process.
  async flush(): Promise<void> {
    try {
      const armed = this.#armed

      clearTimeout(this.#timer)
      this.#timer = this.#armed = undefined

      for (const part of split(this.#queue.splice(0))) {
        void this.hold(this.#buffered(part))
      }

      armed?.()
      await Promise.all(this.#inflight)
    } catch (error) {
      this.report(error)
    }
  }

  async #buffered(
    events: readonly string[],
    batch: string = crypto.randomUUID(),
    again = true
  ): Promise<void> {
    try {
      const { dropped, reason } = await this.deliver(events, batch, 30_000)

      if (dropped > 0 && reason !== "install_check" && reason !== "bot") {
        this.report(new MiraError(reason ?? "unexpected", `${dropped} events dropped: ${reason}`))
      }
    } catch (error) {
      this.report(error)

      // A 400 names the events it refused: send the rest once, under an id derived from this batch's.
      const refused = new Set(
        error instanceof MiraError && error.code === "validation_failed"
          ? error.errors?.map(({ path }) => +(/^events\.(\d+)\./.exec(path)?.[1] ?? -1))
          : [-1]
      )
      const rest = events.filter((_, index) => !refused.has(index))

      if (again && !refused.has(-1) && rest.length > 0 && rest.length < events.length) {
        await this.#buffered(rest, await batchIdFor(batch), false)
      }
    }
  }

  async deliver(
    events: readonly string[],
    batch: string,
    maxWaitMs: number,
    signal?: AbortSignal,
    sentAt = Date.now()
  ): Promise<Receipt> {
    if (!this.#key) {
      throw new MiraError("unauthorized", "no key: pass MIRAFIVE_SECRET_KEY")
    }

    // Serialised once: a retry resends the identical bytes (PROTOCOL §5).
    const body = `${JSON.stringify({ v: 1, batch, mode: this.mode, sentAt, context: { sdk: SDK } }).slice(0, -1)},"events":[${events.join()}]}`

    if (bytes(body) > MAX_BODY_BYTES) {
      throw new MiraError("payload_too_large", "batch over 1 MiB")
    }

    for (let attempt = 0; ; attempt += 1) {
      try {
        // oxlint-disable-next-line no-await-in-loop -- each attempt waits for the one before
        const [, answer] = await call<Partial<Receipt>>(
          this.#fetch,
          `${this.#host}/v1/batch`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${this.#key}`,
              "Content-Type": "application/json",
              "User-Agent": SDK
            },
            body
          },
          this.#timeoutMs,
          signal
        )

        return { batch, accepted: 0, dropped: 0, ...answer }
      } catch (error) {
        if (!(error instanceof MiraError) || !error.retryable || attempt >= this.#maxRetries) {
          throw error
        }

        const { retryAfterMs } = error

        // oxlint-disable-next-line no-await-in-loop -- backoff between attempts
        await sleep(
          retryAfterMs === undefined
            ? Math.random() * Math.min(4000, 250 * 2 ** attempt)
            : Math.min(Math.max(retryAfterMs, 250), maxWaitMs),
          signal
        )
      }
    }
  }

  hold<T>(promise: Promise<T>): Promise<T> {
    const settled: Promise<unknown> = promise.then(noop, noop).then(() => this.#inflight.delete(settled))

    this.#inflight.add(settled)
    this.#waitUntil?.(settled)

    return promise
  }

  report(error: unknown): void {
    try {
      this.#onError(
        error instanceof MiraError ? error : new MiraError("unexpected", String(error), { cause: error })
      )
    } catch {
      // An onError that throws must not take the process down.
    }
  }
}

let shared: Core | undefined

/** Sends events for one server source. `track()` and `identify()` buffer; `send()` delivers at once. */
export class Mira<E extends Events = Events> {
  readonly #core: Core
  #scope: Scope = {}

  constructor(options: MiraOptions) {
    if ("window" in globalThis && "document" in globalThis) {
      throw new TypeError(
        "@mirafive/sdk-server is server-only: a secret key must never reach a browser. Use @mirafive/sdk-browser."
      )
    }

    this.#core = shared ?? new Core(options)
  }

  /** A view whose events carry these ids and properties. It shares this client's buffer. */
  with(scope: Scope): Mira<E> {
    this.#identifiers(scope.userId, scope.anonymousId)
    shared = this.#core

    try {
      const view = new Mira<E>({ key: undefined })

      view.#scope = {
        ...this.#scope,
        ...scope,
        properties: { ...this.#scope.properties, ...scope.properties }
      }

      return view
    } finally {
      shared = undefined
    }
  }

  /** Buffers one event. Delivery failures go to `onError`; nothing is thrown for transport reasons. */
  track<K extends keyof E & string>(name: K, options: EventOptions<E[K]> = {}): void {
    this.#push(name, options)
  }

  /** Buffers `$identify`: links the anonymous id, when given, to the user and records their traits. */
  identify(
    userId: string,
    traits?: Record<string, unknown>,
    options: { readonly anonymousId?: string | undefined } = {}
  ): void {
    this.#push("$identify", { userId, anonymousId: options.anonymousId, properties: traits })
  }

  /** Delivers up to 1000 events as one batch now. Rejects with a `MiraError`. */
  async send(events: readonly SendEvent<E>[], options: SendOptions = {}): Promise<Receipt> {
    const { idempotencyKey } = options

    if (events.length === 0 || events.length > MAX_EVENTS) {
      throw new TypeError(`send() takes 1–${MAX_EVENTS} events, got ${events.length}`)
    }

    if (idempotencyKey === "") {
      throw new TypeError("idempotencyKey must not be empty")
    }

    const wire = events.map((event) => this.#event(event.name, event))
    const batch = idempotencyKey === undefined ? crypto.randomUUID() : await batchIdFor(idempotencyKey)

    // A caller awaiting send() can afford a longer Retry-After than a background flush.
    return this.#core.hold(this.#core.deliver(wire, batch, 120_000, options.signal, options.sentAt))
  }

  /** Sends the buffer and waits for every delivery in flight. Never rejects. */
  flush(): Promise<void> {
    return this.#core.flush()
  }

  /** Flushes and stops: later events are reported to `onError` and dropped. */
  shutdown(): Promise<void> {
    this.#core.closed = true

    return this.#core.flush()
  }

  #push(name: string, options: EventOptions): void {
    try {
      const event = this.#event(name, options)

      if (this.#core.closed) {
        throw new MiraError("aborted", `${name}: after shutdown()`)
      }

      this.#core.push(event)
    } catch (error) {
      if (!(error instanceof MiraError)) {
        throw error
      }

      this.#core.report(error)
    }
  }

  #identifiers(...ids: readonly unknown[]): void {
    if (this.#core.mode === "consentless" && ids.some((id) => id !== undefined)) {
      throw new TypeError(
        'consentless mode sends no userId, anonymousId or sessionId; use mode "full" when you hold consent'
      )
    }
  }

  /** The event as it goes on the wire, checked against the server's limits so one bad event never costs a batch. */
  #event(name: string, options: EventOptions): string {
    const scope = this.#scope
    const userId = options.userId ?? scope.userId
    const anonymousId = options.anonymousId ?? scope.anonymousId
    const { sessionId, id, page, time: at } = options

    this.#identifiers(userId, anonymousId, sessionId)

    const time = Math.floor(
      at === undefined ? Date.now() : typeof at === "number" ? at : new Date(at).getTime()
    )
    const properties =
      scope.properties || options.properties ? { ...scope.properties, ...options.properties } : undefined
    let problem =
      typeof name !== "string" || name === "" || chars(name) > 128 || name.trim() !== name
        ? "a name has 1–128 characters, no outer whitespace"
        : name[0] === "$" && !(RESERVED_NAMES as readonly string[]).includes(name)
          ? "$ names are reserved"
          : !(time >= 0)
            ? "invalid time"
            : [userId, anonymousId].some(
                  (value) => value !== undefined && (!value.trim() || chars(value) > 256)
                )
              ? "ids have 1–256 characters, not blank"
              : [sessionId, id].some((value) => value !== undefined && !uuid.test(value))
                ? "sessionId and id are UUIDs"
                : chars(page?.url ?? "") > 2048 ||
                    chars(page?.title ?? "") > 512 ||
                    chars(page?.referrer ?? "") > 2048
                  ? "page url and referrer have at most 2048 characters, the title 512"
                  : properties && walk(properties, 1, { count: 0 })

    if (!problem) {
      try {
        if (properties && bytes(JSON.stringify(properties)) > 32_768) {
          problem = "properties encode to at most 32 KB"
        } else {
          return JSON.stringify({ name, id, time, page, properties, anonymousId, userId, sessionId })
        }
      } catch (cause) {
        problem = `properties are not JSON (${String(cause)})`
      }
    }

    throw new MiraError("invalid_event", `${name}: ${problem}`)
  }
}
