import { MiraError } from "./error.ts"
import { call, type Fetch, trimHost } from "./http.ts"
import type { Mira } from "./mira.ts"
import { evaluate, usable } from "./protocol/evaluate.ts"
import { fnv1a32 } from "./protocol/hash.ts"
import { DEFAULT_HOST, MAX_LOOKUP_UNITS } from "./protocol/limits.ts"
import type { Facts, Flag, FlagDocument, Json, Membership, Reason, Segments } from "./protocol/types.ts"

export type { Bootstrap, Flag, FlagDocument, Json } from "./protocol/types.ts"

export type FlagErrorCode =
  | "UNSUPPORTED"
  | "NOT_READY"
  | "FLAG_NOT_FOUND"
  | "MEMBERSHIP_UNAVAILABLE"
  | "NOT_ALLOWED"

/** A variant and why; `errorCode` on a variant names facts that were left out. `ERROR` means the code fallback applies. */
export type FlagEvaluation =
  | {
      readonly variant: string
      readonly reason: Reason
      readonly rule?: number
      readonly errorCode?: "MEMBERSHIP_UNAVAILABLE" | "NOT_ALLOWED"
    }
  | { readonly reason: "ERROR"; readonly errorCode: FlagErrorCode }

export interface FlagUnit {
  /** Your own id for the signed-in person. */
  readonly userId?: string | undefined
  /** The browser SDK's anonymous id (`mirafive("anonymousId")`); anything after a `.` is ignored. */
  readonly anonymousId?: string | undefined
  /** Facts for targeting rules. Held in memory, never sent. */
  readonly properties?: { readonly [key: string]: Json | undefined } | undefined
  /** The visitor's consent answer. Omitted scopes count as granted: your own lawful basis applies. */
  readonly consent?: { readonly experiments?: boolean; readonly targeting?: boolean } | undefined
  /** Set it from `Sec-GPC: 1` or `DNT: 1`: no ids, no segment lookup, no exposure; fixed values and property rules still apply. */
  readonly optedOut?: boolean | undefined
}

export interface ForOptions {
  /** This request's `waitUntil`, so one `MiraFlags` can serve every request of a Workers isolate. */
  readonly waitUntil?: ((promise: Promise<unknown>) => void) | undefined
}

/** One unit's flags. Reads are synchronous and never throw; a flag that cannot be read answers the fallback. */
export interface UserFlags {
  enabled(key: string, fallback?: boolean): boolean
  variant(key: string): string | undefined
  variant(key: string, fallback: string): string
  config<T>(key: string, fallback: T): T
  /** Explains a read without counting an exposure. */
  evaluate(key: string): FlagEvaluation
  /** The `<script type="application/json" id="mirafive-flags">` block for the browser SDK. Send `bootstrapHeaders` with it. */
  bootstrap(): string
}

export interface MiraFlagsOptions {
  readonly key: string | undefined
  readonly host?: string | undefined
  /** Default 30, at least 10. */
  readonly refreshSeconds?: number | undefined
  /** How long the first read waits for the document. Default 1500. */
  readonly timeoutMs?: number | undefined
  /** A snapshot to start from, used while younger than 7 days. */
  readonly document?: FlagDocument | undefined
  /** Counts experiments counted on the server. */
  // oxlint-disable-next-line typescript/no-explicit-any -- any event map
  readonly mira?: Mira<any> | undefined
  readonly fetch?: Fetch | undefined
  readonly waitUntil?: ((promise: Promise<unknown>) => void) | undefined
  readonly onError?: ((error: MiraError) => void) | undefined
}

export interface MiraFlagsStatus {
  readonly ready: boolean
  readonly stale: boolean
  /** A 401 or 403 stopped refreshing until restart; the last document stays in use. */
  readonly stopped: boolean
  readonly fetchedAt?: number | undefined
}

/** Send with every response that carries a bootstrap block. */
export const bootstrapHeaders = { "Cache-Control": "private, no-store" } as const

type Lookup = readonly [unit: string, resolve: (segments: Segments | "unavailable") => void]

const MINUTE = 60_000

const cache = <T>(ttl: number) => {
  const entries = new Map<string, readonly [number, T]>()

  return {
    get: (key: string): T | undefined => {
      const hit = entries.get(key)

      return hit && hit[0] > Date.now() ? hit[1] : undefined
    },
    set: (key: string, value: T): void => {
      entries.delete(key)
      entries.set(key, [Date.now() + ttl, value])

      if (entries.size > 10_000) {
        const [oldest = ""] = entries.keys()

        entries.delete(oldest)
      }
    }
  }
}

const own = <T>(record: Readonly<Record<string, T>> | undefined, key: string): T | undefined =>
  record && Object.hasOwn(record, key) ? record[key] : undefined

const refsOf = (flag: Flag): string[] => {
  try {
    return flag.r.flatMap(
      (rule) => rule.if?.flatMap((condition) => (condition[0] === "s" ? [condition[1]] : [])) ?? []
    )
  } catch {
    return []
  }
}

/** Evaluates this source's flags on the server, refreshing the document on read. */
export class MiraFlags {
  /** Resolves `true` once a document is usable, `false` when none arrived within `timeoutMs`. */
  declare readonly ready: () => Promise<boolean>
  /** The document in use: the last one fetched, else the `document` option while younger than 7 days. */
  declare readonly snapshot: () => FlagDocument | undefined
  declare readonly status: () => MiraFlagsStatus
  declare readonly for: (unit?: FlagUnit, options?: ForOptions) => Promise<UserFlags>

  constructor(options: MiraFlagsOptions) {
    const { mira, waitUntil, onError, fetch } = options
    const key = options.key?.trim()
    const host = trimHost(options.host || DEFAULT_HOST)
    const refreshMs = Math.max(10, options.refreshSeconds ?? 30) * 1000
    const known = cache<Segments | "unavailable">(MINUTE)
    const exposed = cache<1>(60 * MINUTE)
    const asking = new Map<string, Promise<Segments | "unavailable">>()
    let lookups: Lookup[] = []
    let lookupsFrom = 0
    let consentless = false
    let document: FlagDocument | undefined
    let etag: string | undefined
    let fetchedAt: number | undefined
    let due = 0
    let failures = 0
    let stopped = false
    let loading: Promise<unknown> | undefined
    let since = 0

    const broken = new Set<unknown>()

    const report = (error: MiraError): MiraError => {
      if (onError) {
        onError(error)
      } else {
        // oxlint-disable-next-line no-console -- a server SDK has no other channel
        console.warn(`[mirafive] ${error.message}`)
      }

      return error
    }

    // Without a key the server answers 401, which stops refreshing and reaches onError.
    const request = async <T>(
      path: string,
      init: { method?: string; headers: Record<string, string>; body?: string },
      timeoutMs: number
    ) => {
      if (!key) {
        throw new MiraError("unauthorized", "no key: pass MIRAFIVE_SECRET_KEY")
      }

      return call<T>(
        fetch,
        host + path,
        { ...init, headers: { ...init.headers, Authorization: `Bearer ${key}` } },
        timeoutMs
      )
    }

    // A document that breaks the format answers the fallback, reported once per flag.
    const decide = (flag: Flag, facts: Facts): FlagEvaluation => {
      try {
        return evaluate(flag, facts)
      } catch (cause) {
        if (!broken.has(flag)) {
          broken.add(flag)
          report(new MiraError("unexpected", `unreadable flag: ${String(cause)}`, { cause }))
        }

        return { reason: "ERROR", errorCode: "UNSUPPORTED" }
      }
    }

    const snapshot = (): FlagDocument | undefined => {
      const given = options.document

      return document ?? (given && Date.now() - given.at < 7 * 24 * 60 * MINUTE ? given : undefined)
    }

    const confirmedAt = (): number | undefined => fetchedAt ?? snapshot()?.at

    // Every failure here is a MiraError: call() wraps what the transport throws.
    const load = (): Promise<unknown> => {
      let wait = refreshMs
      let floor = 0

      return request<FlagDocument>("/v1/flags", { headers: etag ? { "If-None-Match": etag } : {} }, 10_000)
        .then(([response, fetched]) => {
          if (response.status !== 304) {
            if (fetched?.v !== 1 || !fetched.flags) {
              throw new MiraError("unexpected", "unreadable flag document")
            }

            document = fetched
            etag = response.headers.get("ETag") ?? undefined
          }

          failures = 0

          return (fetchedAt = Date.now())
        })
        .catch((error: MiraError) => {
          report(error)
          // Without any document, retry soon: 1 s, 2 s, 4 s … up to the refresh interval.
          wait = snapshot()
            ? Math.min(5 * MINUTE, wait * 2 ** ++failures)
            : Math.min(wait, 500 * 2 ** ++failures)
          floor = error.retryAfterMs ?? 0
          stopped = error.code === "unauthorized" || error.status === 403
        })
        .finally(() => {
          due = Date.now() + Math.max(wait * (0.9 + Math.random() * 0.2), floor)
          loading = undefined
        })
    }

    // Reads refresh the document; a refresh older than its timeout was cut off with its request (workerd).
    const settle = async (wait = waitUntil): Promise<void> => {
      const now = Date.now()

      if (!(loading && now - since < 10_000) && !stopped && now >= due) {
        since = now
        loading = load()
      }

      if (loading) {
        wait?.(loading)

        if (!snapshot()) {
          await Promise.race([
            loading,
            new Promise((resolve) => setTimeout(resolve, options.timeoutMs ?? 1500))
          ])
        }
      }
    }

    const ask = (batch: readonly Lookup[]): Promise<unknown> =>
      request<{ units?: Partial<Membership>[] }>(
        "/v1/flags/segments",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: `{"units":[${batch.map(([unit]) => unit).join(",")}]}`
        },
        300
      ).then(
        ([, body]) =>
          batch.map(([unit, resolve], index) => {
            const { segments, unavailable = [] } = body?.units?.[index] ?? {}
            const membership = segments ? { in: segments, unavailable } : "unavailable"

            known.set(unit, membership)
            resolve(membership)
          }),
        (error: MiraError) => {
          lookupsFrom = Date.now() + (report(error).retryAfterMs ?? 10_000)

          for (const [, resolve] of batch) {
            resolve("unavailable")
          }
        }
      )

    // Lookups of one tick share requests of up to 100 units.
    const lookup = (unit: string): Promise<Segments | "unavailable"> | Segments | "unavailable" => {
      const found =
        known.get(unit) ?? asking.get(unit) ?? (Date.now() < lookupsFrom ? "unavailable" : undefined)

      if (found) {
        return found
      }

      // Concurrent reads of one unit share its lookup.
      const asked = new Promise<Segments | "unavailable">((resolve) => {
        if (lookups.push([unit, resolve]) === 1) {
          queueMicrotask(() => {
            const queued = lookups

            lookups = []

            for (let at = 0; at < queued.length; at += MAX_LOOKUP_UNITS) {
              void ask(queued.slice(at, at + MAX_LOOKUP_UNITS))
            }
          })
        }
      })

      asking.set(unit, asked)
      void asked.then(() => asking.delete(unit))

      return asked
    }

    const forUnit = async (
      unit: FlagUnit = {},
      { waitUntil: wait = waitUntil }: ForOptions = {}
    ): Promise<UserFlags> => {
      await settle(wait)

      const current = snapshot()
      const { optedOut } = unit
      const experiments = !optedOut && unit.consent?.experiments !== false
      const targeting = !optedOut && unit.consent?.targeting !== false
      const userId = optedOut ? undefined : usable(unit.userId)
      // Without experiments consent the browser's anonymous id is not used at all.
      const anonymousId = experiments ? usable(unit.anonymousId?.split(".")[0]) : undefined
      const segments =
        current && Object.values(current.flags).some((flag) => refsOf(flag)[0])
          ? targeting && (userId ?? anonymousId)
            ? await lookup(JSON.stringify({ userId, anonymousId }))
            : "unavailable"
          : undefined
      const facts: Facts = { userId, id: anonymousId, properties: unit.properties, segments }

      // use: 0 explains, 1 reads a value, 2 reads for a bootstrap.
      const read = (flagKey: string, use: 0 | 1 | 2): FlagEvaluation => {
        const flag = own(current?.flags, flagKey)

        if (!flag) {
          return { reason: "ERROR", errorCode: current ? "FLAG_NOT_FOUND" : "NOT_READY" }
        }

        let decision = decide(flag, facts)

        if (decision.reason === "ERROR") {
          return decision
        }

        const refs = refsOf(flag)
        let errorCode: "MEMBERSHIP_UNAVAILABLE" | "NOT_ALLOWED" | undefined =
          refs[0] && (typeof segments !== "object" || refs.some((ref) => segments.unavailable.includes(ref)))
            ? targeting
              ? "MEMBERSHIP_UNAVAILABLE"
              : "NOT_ALLOWED"
            : undefined

        // An experiment counted in the browser is decided there; only a bootstrap hands it over (FLAGS §5.1).
        if (flag.e && decision.reason !== "DISABLED" && (!experiments || (flag.c !== "s" && use < 2))) {
          decision = { variant: flag.d, reason: "DEFAULT" }
          errorCode = "NOT_ALLOWED"
        }

        const { variant } = decision
        // At most one exposure per flag, variant and unit an hour (FLAGS §5.5).
        const seen = `${flagKey}\n${variant}\n${flag.u === "p" ? userId : anonymousId}`

        if (use && mira && flag.e && flag.c === "s" && decision.reason === "SPLIT" && !exposed.get(seen)) {
          exposed.set(seen, 1)

          try {
            mira.track("$exposure", {
              userId,
              anonymousId,
              properties: { $experiment: flagKey, $variant: variant }
            })
          } catch {
            if (!consentless) {
              consentless = true
              report(
                new MiraError(
                  "collection_mode_not_allowed",
                  "a consentless Mira counts no exposures; pass a full one"
                )
              )
            }
          }

          // With a waitUntil the exposure leaves with this request, not on the client's timer.
          wait?.(mira.flush())
        }

        return errorCode ? { ...decision, errorCode } : decision
      }

      const pick = (flagKey: string): string | undefined => {
        const answer = read(flagKey, 1)

        return "variant" in answer ? answer.variant : undefined
      }

      function variant(flagKey: string): string | undefined
      function variant(flagKey: string, fallback: string): string
      function variant(flagKey: string, fallback?: string): string | undefined {
        return pick(flagKey) ?? fallback
      }

      return {
        enabled: (flagKey, fallback = false) => {
          const on = pick(flagKey)

          return on === "on" || (on !== "off" && fallback)
        },
        variant,
        config: <T>(flagKey: string, fallback: T): T => {
          const on = pick(flagKey)

          // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the caller names the config's type
          return ((on && own(own(current?.flags, flagKey)?.p, on)) ?? fallback) as T
        },
        evaluate: (flagKey) => read(flagKey, 0),
        bootstrap: () => {
          const values: Record<string, readonly [string, Json?, 1?]> = {}
          const browser: string[] = []

          for (const [flagKey, flag] of Object.entries(current?.flags ?? {})) {
            // Only flags the website reads too: a server-only value never reaches a page (FLAGS §5.4).
            if (flag.w !== 1) {
              continue
            }

            const bare = flag.u === "b" ? decide(flag, { ...facts, id: undefined }) : undefined

            if (bare?.reason === "DEFAULT" && bare.rule !== undefined) {
              browser.push(flagKey)
              continue
            }

            const answer = read(flagKey, 2)

            if (answer.reason !== "ERROR") {
              const value = own(flag.p, answer.variant)

              // An experiment the browser counts but the server split: the page sends its exposure.
              values[flagKey] =
                flag.e && flag.c !== "s" && answer.reason === "SPLIT"
                  ? [answer.variant, value ?? null, 1]
                  : value === undefined
                    ? [answer.variant]
                    : [answer.variant, value]
            }
          }

          // Undefined fields drop out of the JSON.
          const block = {
            v: 1,
            at: confirmedAt() ?? 0,
            values,
            browser: browser[0] && browser,
            unit: userId && String(fnv1a32(userId))
          }

          return `<script type="application/json" id="mirafive-flags">${JSON.stringify(block).replace(
            /[<>&\u2028\u2029]/g,
            (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`
          )}</script>`
        }
      }
    }

    Object.assign(this, {
      ready: async () => {
        await settle()

        return !!snapshot()
      },
      snapshot,
      status: (): MiraFlagsStatus => ({
        ready: !!snapshot(),
        stale: Date.now() - (confirmedAt() ?? Infinity) > 5 * MINUTE,
        stopped,
        fetchedAt
      }),
      for: forUnit
    })
  }
}
